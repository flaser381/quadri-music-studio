// The LLM behind the lyrics writer, an OpenAI-compatible chat API at LLM.url. In order of preference:
//   1. whatever already answers there (the studio's own llama-server, Ollama, LM Studio, a remote API, …)
//   2. the studio's own llama-server (installed by the installer), started on demand and stopped before YuE2 loads
//   3. LLM_START_URL: something else is asked to load a model there (e.g. a local model manager)
import { type ChildProcess, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { LLM } from './config.ts'
import { readVram, sleep } from './gpu.ts'
import { log } from './hub.ts'
import { stopWorker, workerState } from './worker.ts'

export type LocalLlmState = 'stopped' | 'starting' | 'running'

let proc: ChildProcess | null = null
let state: LocalLlmState = 'stopped'
let idleTimer: ReturnType<typeof setTimeout> | undefined
/** unload our llama-server this long after the last lyrics were written */
const IDLE_MS = 5 * 60_000

export const localLlmState = () => state
/** our own llama-server can be started (binary + model file present, LLM_URL is on this machine) */
export function canStartLocal(): boolean {
  if (!LLM.server || !fs.existsSync(LLM.server) || !fs.existsSync(LLM.gguf)) return false
  const host = new URL(LLM.url).hostname
  return host === '127.0.0.1' || host === 'localhost'
}

const authHeaders = (): Record<string, string> => (LLM.apiKey ? { Authorization: `Bearer ${LLM.apiKey}` } : {})

export async function llmInfo(): Promise<{ ready: boolean; model: string | null }> {
  try {
    // /v1/models: every OpenAI-compatible server has it (llama-server answers 503 while it loads)
    const r = await fetch(`${LLM.url}/v1/models`, { headers: authHeaders(), signal: AbortSignal.timeout(1500) })
    if (!r.ok) return { ready: false, model: null }
    const j = (await r.json()) as { data?: { id: string }[] }
    return { ready: true, model: LLM.model ?? j.data?.[0]?.id ?? null }
  } catch {
    return { ready: false, model: null }
  }
}

/** POST /v1/chat/completions (streaming) */
export function chat(body: object, signal: AbortSignal): Promise<Response> {
  return fetch(`${LLM.url}/v1/chat/completions`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  })
}

function startLocal(): Promise<void> {
  const port = new URL(LLM.url).port || '80'
  // --alias: /v1/models would otherwise report the full file path as the model name
  const alias = path.basename(LLM.gguf).replace(/\.gguf$/i, '')
  const argv = ['-m', LLM.gguf, '--alias', alias, '--host', '127.0.0.1', '--port', port, '-ngl', '999', '-c', '8192', '--jinja', ...LLM.args]
  log(`[lyrics] starting llama-server (${alias})`, 'info')
  state = 'starting'
  const p = spawn(LLM.server!, argv, { stdio: ['ignore', 'pipe', 'pipe'] })
  proc = p
  const tail: string[] = []
  for (const s of [p.stdout!, p.stderr!])
    readline.createInterface({ input: s }).on('line', (l) => {
      tail.push(l)
      if (tail.length > 12) tail.shift()
    })
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (e?: Error) => {
      if (settled) return
      settled = true
      if (e) reject(e)
      else resolve()
    }
    p.on('error', (e) => done(new Error(`llama-server: ${e.message}`)))
    p.on('exit', (code, signal) => {
      if (proc === p) {
        proc = null
        state = 'stopped'
      }
      done(new Error(`llama-server exited (${signal ?? code}):\n${tail.join('\n')}`))
    })
    void (async () => {
      const t0 = Date.now()
      while (!settled) {
        if ((await llmInfo()).ready) {
          state = 'running'
          log(`[lyrics] llama-server ready after ${((Date.now() - t0) / 1000).toFixed(0)}s`, 'ok')
          return done()
        }
        if (Date.now() - t0 > 180_000) {
          p.kill()
          return done(new Error('llama-server did not come up within 180 s'))
        }
        await sleep(500)
      }
    })()
  })
}

/** Stop our llama-server (before YuE2 loads, or when idle). Leaves anything we didn't start alone. */
export async function stopLocalLlm(): Promise<void> {
  clearTimeout(idleTimer)
  const p = proc
  if (!p) return
  log('[lyrics] stopping llama-server (frees VRAM for YuE2)', 'dim')
  await new Promise<void>((resolve) => {
    const kill = setTimeout(() => p.kill('SIGKILL'), 5000)
    p.once('exit', () => {
      clearTimeout(kill)
      resolve()
    })
    p.kill()
  })
}

/** Called after the lyrics are written: our llama-server stays up a while for the next request. */
export function llmIdle() {
  clearTimeout(idleTimer)
  if (proc) idleTimer = setTimeout(() => void stopLocalLlm(), IDLE_MS)
}

async function startRemote(status: (s: string) => void, signal: AbortSignal) {
  status('loading a model…')
  log(`[lyrics] nothing answers at ${LLM.url}, asking ${LLM.startUrl} to load a model`, 'info')
  let r: Response
  try {
    r = await fetch(LLM.startUrl!, { method: 'POST', headers: LLM.startHeaders, signal })
  } catch {
    throw new Error(`nothing answers at ${LLM.url} and ${LLM.startUrl} is not reachable`)
  }
  if (!r.ok) throw new Error(`${LLM.startUrl}: ${((await r.json().catch(() => ({}))) as { error?: string }).error ?? r.statusText}`)
  const t0 = Date.now()
  while (!(await llmInfo()).ready) {
    if (signal.aborted) throw new Error('cancelled')
    if (Date.now() - t0 > 300_000) throw new Error(`no model at ${LLM.url} within 300 s after ${LLM.startUrl}`)
    await sleep(2000)
  }
  log(`[lyrics] model ready after ${((Date.now() - t0) / 1000).toFixed(0)}s`, 'ok')
}

export async function ensureLlm(status: (s: string) => void, signal: AbortSignal) {
  clearTimeout(idleTimer)
  if ((await llmInfo()).ready) return
  if (canStartLocal()) {
    // an idle YuE2 (~8 GB VRAM) may leave too little room next to the LLM
    const vram = await readVram()
    const need = fs.statSync(LLM.gguf).size + 2 * 2 ** 30
    if (workerState() === 'ready' && (!vram || vram.total - vram.used < need)) {
      log('[lyrics] unloading the idle YuE2 to make room for the LLM', 'dim')
      await stopWorker()
    }
    status('loading the lyrics model…')
    if (!proc) await startLocal()
    else while (state === 'starting') await sleep(300)
    if (signal.aborted) throw new Error('cancelled')
    if (state !== 'running') throw new Error('llama-server stopped while loading')
    return
  }
  if (LLM.startUrl) return startRemote(status, signal)
  throw new Error(
    `no lyrics model: nothing answers at ${LLM.url}. Install the bundled one (run the installer again without --no-lyrics-llm) ` +
      'or point LLM_URL in config.env at an OpenAI-compatible server (Ollama, LM Studio, llama.cpp). Custom mode works without one.',
  )
}
