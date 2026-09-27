// Quadri Music Studio backend: REST + SSE API, song queue, static frontend + audio files.
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AppState, Draft, LyricsEvent, PathsInfo, Status, StudioSettings } from '../../shared/types.ts'
import { VAE_FILES, YUE2_FILES } from '../../shared/models.ts'
import { DATA_DIR, FRONTEND_DIST, GPU, HOST, LLM, MODELS_DIR, OPEN_BROWSER, PORT, STOP_CONTAINERS, YUE2 } from './config.ts'
import { othersRunning, runningContainers } from './containers.ts'
import { memAvailable, readVram } from './gpu.ts'
import { addClient, clearLogs, emit, log, recentLogs } from './hub.ts'
import { canStartLocal, llmInfo, localLlmState, stopLocalLlm } from './llm.ts'
import { writeLyrics } from './lyrics.ts'
import { cancel, enqueue, listJobs, liveScore } from './queue.ts'
import * as store from './store.ts'
import { stopWorker, workerEngine, workerState } from './worker.ts'

// ---------- status poller ----------

let ffmpeg = false
execFile('ffmpeg', ['-version'], (err) => (ffmpeg = !err))

let status: Status = {
  gpu: GPU,
  engine: null,
  vramTotal: null,
  vramFree: null,
  memAvailable: null,
  worker: 'stopped',
  others: [],
  llmReady: false,
  llmModel: null,
  llmLocal: null,
  llmAvailable: false,
  models: { yue2: false, vae: false, venv: false },
  ffmpeg: false,
}

/** every file present at its exact size (an interrupted download is shorter) */
function complete(files: { file: string; size: number }[]): boolean {
  try {
    return files.every((f) => fs.statSync(path.join(MODELS_DIR, f.file)).size === f.size)
  } catch {
    return false
  }
}

async function pollStatus() {
  const [names, llm, vram] = await Promise.all([STOP_CONTAINERS.length ? runningContainers() : [], llmInfo(), readVram()])
  const mem = memAvailable()
  const local = canStartLocal()
  const next: Status = {
    gpu: GPU,
    engine: workerEngine(),
    vramTotal: vram?.total ?? null,
    vramFree: vram ? vram.total - vram.used : null,
    // rounded so the SSE status event doesn't fire every 2 s
    memAvailable: mem === null ? null : Math.round(mem / 2 ** 28) * 2 ** 28,
    worker: workerState(),
    others: othersRunning(names),
    llmReady: llm.ready,
    llmModel: llm.model,
    llmLocal: local ? localLlmState() : null,
    llmAvailable: llm.ready || local || !!LLM.startUrl,
    models: {
      yue2: complete(YUE2_FILES),
      vae: complete(VAE_FILES),
      venv: fs.existsSync(YUE2.python),
    },
    ffmpeg,
  }
  if (vram && status.vramFree !== null && Math.abs((status.vramFree ?? 0) - (next.vramFree ?? 0)) < 2 ** 26) next.vramFree = status.vramFree
  if (JSON.stringify(next) !== JSON.stringify(status)) {
    status = next
    emit({ type: 'status', status })
  }
}

let polling = false
setInterval(() => {
  if (polling) return
  polling = true
  pollStatus().finally(() => (polling = false))
}, 2000)
pollStatus()

const paths = (): PathsInfo => ({
  dataDir: DATA_DIR,
  modelDir: YUE2.model,
  vaeDir: YUE2.vae,
  python: YUE2.python,
  worker: YUE2.script,
  llmUrl: LLM.url,
  llmServer: canStartLocal() ? LLM.server : null,
  llmGguf: canStartLocal() ? LLM.gguf : null,
})

/** Name of the built JS bundle: changes on every `npm run build`. */
function buildId(): string {
  try {
    return /assets\/(index-[\w-]+\.js)/.exec(fs.readFileSync(path.join(FRONTEND_DIST, 'index.html'), 'utf8'))?.[1] ?? 'dev'
  } catch {
    return 'dev'
  }
}

// ---------- http helpers ----------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.flac': 'audio/flac',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.abc': 'text/plain; charset=utf-8',
}

function json(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** Static file with HTTP Range support (the <audio> element seeks with ranges). */
function sendFile(req: http.IncomingMessage, res: http.ServerResponse, file: string, cache: string, extra: Record<string, string> = {}) {
  const size = fs.statSync(file).size
  const headers: Record<string, string | number> = {
    'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'Cache-Control': cache,
    'Accept-Ranges': 'bytes',
    ...extra,
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]))
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
    if (start >= size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end()
      return
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 })
    fs.createReadStream(file, { start, end }).pipe(res)
    return
  }
  res.writeHead(200, { ...headers, 'Content-Length': size })
  fs.createReadStream(file).pipe(res)
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string) {
  const rel = path.normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '')
  let file = path.join(FRONTEND_DIST, rel)
  if (!file.startsWith(FRONTEND_DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(FRONTEND_DIST, 'index.html') // SPA fallback
  }
  if (!fs.existsSync(file)) {
    res.writeHead(503, { 'Content-Type': 'text/plain' })
    res.end('Frontend not built. Run the installer again (install.sh / install.bat), or: npm run build')
    return
  }
  const immutable = file.includes(`${path.sep}assets${path.sep}`)
  sendFile(req, res, file, immutable ? 'public, max-age=31536000, immutable' : 'no-cache')
}

/** /files/songs/<id>/audio.flac — only audio + score files of finished songs */
function serveData(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string) {
  const rel = path.normalize(decodeURIComponent(urlPath.slice('/files/'.length)))
  const file = path.join(DATA_DIR, rel)
  if (!file.startsWith(path.join(DATA_DIR, 'songs') + path.sep) || !/\.(flac|mp3|wav|abc)$/.test(file) || !fs.existsSync(file)) {
    res.writeHead(404).end()
    return
  }
  sendFile(req, res, file, 'private, max-age=31536000, immutable') // files are never rewritten under the same name
}

const mp3Jobs = new Map<string, Promise<void>>()

/** Convert once with ffmpeg and keep the result next to the FLAC. */
function transcode(src: string, dst: string, fmt: 'mp3' | 'wav'): Promise<void> {
  if (fs.existsSync(dst)) return Promise.resolve()
  const running = mp3Jobs.get(dst)
  if (running) return running
  const args = fmt === 'mp3' ? ['-codec:a', 'libmp3lame', '-b:a', '320k'] : ['-codec:a', 'pcm_s16le']
  const p = new Promise<void>((resolve, reject) => {
    const tmp = `${dst}.part`
    const ff = spawn('ffmpeg', ['-v', 'error', '-y', '-i', src, ...args, '-f', fmt, tmp])
    let err = ''
    ff.stderr.on('data', (b: Buffer) => (err += b.toString()))
    ff.on('error', reject)
    ff.on('close', (code) => {
      if (code === 0) {
        fs.renameSync(tmp, dst)
        resolve()
      } else {
        fs.rmSync(tmp, { force: true })
        reject(new Error(`ffmpeg failed: ${err.slice(-300)}`))
      }
    })
  }).finally(() => mp3Jobs.delete(dst))
  mp3Jobs.set(dst, p)
  return p
}

async function download(req: http.IncomingMessage, res: http.ServerResponse, id: string, fmt: string) {
  const song = store.getSong(id)
  const flac = path.join(DATA_DIR, song.file)
  const safe = song.title.replace(/[^\p{L}\p{N} ._-]+/gu, '').trim() || 'song'
  let file = flac
  if (fmt === 'mp3' || fmt === 'wav') {
    if (!ffmpeg) throw new Error('ffmpeg is not installed')
    file = flac.replace(/\.flac$/, `.${fmt}`)
    await transcode(flac, file, fmt)
  } else if (fmt === 'abc') {
    if (!song.score) throw new Error('this song has no score')
    file = path.join(DATA_DIR, song.dir, 'score.abc')
  } else if (fmt !== 'flac') throw new Error('unknown format')
  const name = `${safe}.${fmt}`
  sendFile(req, res, file, 'no-store', {
    'Content-Disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
  })
}

async function body<T>(req: http.IncomingMessage, limit = 4 * 1024 * 1024): Promise<T> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > limit) throw new Error('request too large')
    chunks.push(c as Buffer)
  }
  const text = Buffer.concat(chunks).toString()
  return (text ? JSON.parse(text) : {}) as T
}

// Only answer to local names/addresses (blocks DNS-rebinding attacks from websites).
function allowedHosts(): Set<string> {
  const h = new Set(['localhost', '127.0.0.1', '[::1]', os.hostname(), `${os.hostname()}.local`])
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list ?? []) h.add(a.family === 'IPv6' ? `[${a.address}]` : a.address)
  return h
}
const hosts = allowedHosts()
const hostOk = (req: http.IncomingMessage) => hosts.has((req.headers.host ?? '').replace(/:\d+$/, ''))

/** POST /api/lyrics: NDJSON stream of LyricsEvent while the LLM writes */
async function lyricsRoute(req: http.IncomingMessage, res: http.ServerResponse) {
  const b = await body<{ idea?: string; language?: string; style?: string; instrumental?: boolean }>(req)
  if (!b.idea?.trim()) throw new Error('describe what the song is about')
  if (workerState() === 'busy' || workerState() === 'starting') throw new Error('busy: YuE2 is making a song, the lyrics writer needs the GPU')
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' })
  const send = (e: LyricsEvent) => res.write(`${JSON.stringify(e)}\n`)
  const abort = new AbortController()
  res.on('close', () => abort.abort())
  try {
    const w = await writeLyrics(
      { idea: b.idea, language: b.language ?? 'English', style: b.style, instrumental: b.instrumental },
      { status: (s) => send({ status: s }), delta: (t) => send({ delta: t }) },
      abort.signal,
    )
    send({ done: true, ...w })
  } catch (e) {
    if (!abort.signal.aborted) {
      log(`[lyrics] failed: ${(e as Error).message}`, 'error')
      send({ error: (e as Error).message })
    }
  }
  res.end()
}

// ---------- routes ----------

const server = http.createServer(async (req, res) => {
  if (!hostOk(req)) {
    res.writeHead(421).end('Misdirected request')
    return
  }
  const url = new URL(req.url ?? '/', 'http://x')
  const p = url.pathname
  const method = req.method ?? 'GET'

  if (p.startsWith('/files/')) return serveData(req, res, p)
  if (!p.startsWith('/api/')) return serveStatic(req, res, p)

  // Mutating requests need a custom header → cross-site requests are blocked by CORS preflight
  if (method !== 'GET' && req.headers['x-studio'] !== '1') return json(res, 403, { error: 'missing X-Studio header' })

  try {
    if (method === 'GET' && p === '/api/state') {
      const state: AppState = {
        build: buildId(),
        songs: store.listSongs(),
        status,
        jobs: listJobs(),
        logs: recentLogs(),
        paths: paths(),
        settings: store.getSettings(),
        draft: store.getDraft(),
      }
      return json(res, 200, state)
    }
    if (method === 'GET' && p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
      res.write('retry: 2000\n\n')
      addClient(res)
      return
    }

    // songs
    let m = /^\/api\/songs\/(\w+)$/.exec(p)
    if (m && method === 'PATCH') {
      const s = store.updateSong(m[1], await body(req))
      emit({ type: 'song', song: s })
      return json(res, 200, s)
    }
    if (m && method === 'DELETE') {
      store.deleteSong(m[1])
      emit({ type: 'songDeleted', id: m[1] })
      return json(res, 200, { ok: true })
    }
    m = /^\/api\/songs\/(\w+)\/download$/.exec(p)
    if (m && method === 'GET') return await download(req, res, m[1], url.searchParams.get('fmt') ?? 'flac')

    // jobs
    if (method === 'POST' && p === '/api/jobs') {
      return json(res, 202, enqueue(store.setDraft(await body<Partial<Draft>>(req))))
    }
    m = /^\/api\/jobs\/(\w+)$/.exec(p)
    if (m && method === 'DELETE') {
      cancel(m[1])
      return json(res, 200, { ok: true })
    }
    m = /^\/api\/jobs\/(\w+)\/score$/.exec(p)
    if (m && method === 'GET') return json(res, 200, { text: liveScore(m[1]) })

    // lyrics writer
    if (method === 'POST' && p === '/api/lyrics') return await lyricsRoute(req, res)

    // draft / settings / memory
    if (method === 'PATCH' && p === '/api/draft') return json(res, 200, store.setDraft(await body<Partial<Draft>>(req)))
    if (method === 'PATCH' && p === '/api/settings') {
      const settings = store.setSettings(await body<Partial<StudioSettings>>(req))
      emit({ type: 'settings', settings })
      return json(res, 200, settings)
    }
    /**
     * Unload an idle YuE2 worker and our llama-server. Other GPU apps (e.g. Quadri Image Studio via FREE_URLS)
     * call this before they need the GPU; 409 while a song is being made (a queued song respawns YuE2 later).
     */
    if (method === 'POST' && p === '/api/free') {
      if (workerState() === 'busy' || workerState() === 'starting') throw new Error('busy: YuE2 is making a song')
      const was = workerState()
      await Promise.all([stopWorker(), stopLocalLlm()])
      if (was !== 'stopped') log('[vram] YuE2 unloaded on request', 'ok')
      pollStatus()
      return json(res, 200, { ok: true, unloaded: was !== 'stopped' })
    }
    m = /^\/api\/logs\/(output|worker)$/.exec(p)
    if (m && method === 'DELETE') {
      clearLogs(m[1] as 'output' | 'worker')
      return json(res, 200, { ok: true })
    }

    json(res, 404, { error: 'not found' })
  } catch (e) {
    const msg = (e as Error).message
    if (res.headersSent) return res.end()
    json(res, msg.startsWith('busy') ? 409 : /not found/.test(msg) ? 404 : 400, { error: msg })
  }
})

store.sweepUnfinished(new Set())

for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, () => {
    // the worker would notice stdin EOF anyway; quit it cleanly so it frees VRAM right away
    Promise.all([stopWorker(), stopLocalLlm()]).finally(() => process.exit(0))
    setTimeout(() => process.exit(0), 5000).unref()
  })

server.listen(PORT, HOST, () => {
  const url = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`
  console.log(`Quadri Music Studio on ${url}`)
  log(`[studio] ready · YuE2-3B · PyTorch ${GPU === 'nvidia' ? 'CUDA' : GPU === 'amd' ? 'ROCm' : ''} worker (loads on the first song)`, 'dim')
  if (OPEN_BROWSER) openBrowser(url)
})

function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]]
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref()
  } catch {
    /* no browser: the URL is printed above */
  }
}
