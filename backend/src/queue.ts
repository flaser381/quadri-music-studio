// FIFO song queue, one song at a time on the GPU:
//   Write (LLM lyrics, simple mode) → Load → Compose (ABC score) → Sing (codec tokens) → Render (flow matching) → Decode (VAE) → Save
// Before YuE2 loads, the lyrics LLM and other configured GPU users make room (see makeRoom).
import fs from 'node:fs'
import path from 'node:path'
import { effectiveLyrics, guessTitle, INSTRUMENTAL_LYRICS } from '../../shared/music.ts'
import type { Draft, Job, Song, Stage, Timings } from '../../shared/types.ts'
import { DATA_DIR, MIN_FREE_RAM, STOP_CONTAINERS } from './config.ts'
import { freeOtherApps, othersRunning, runningContainers, stopOtherContainers } from './containers.ts'
import { comfyBusy, freeComfy, memAvailable, sleep } from './gpu.ts'
import { emit, log, logStream } from './hub.ts'
import { stopLocalLlm } from './llm.ts'
import { type Written, writeLyrics } from './lyrics.ts'
import { getSettings, newId, saveSong, songDir } from './store.ts'
import { ensureWorker, generate, type Handlers, scheduleIdle, stopWorker, workerState } from './worker.ts'

interface InternalJob extends Job {
  draft: Draft
  abort: AbortController
  score: string
}

const jobs: InternalJob[] = []
let running: InternalJob | null = null
/** lyrics written once per click and shared by its takes */
const groups = new Map<string, { written: Written | null }>()

const pub = (j: InternalJob): Job => {
  const { draft: _d, abort: _a, score: _s, ...rest } = j
  return rest
}
export const listJobs = (): Job[] =>
  jobs.filter((j) => j.state === 'queued' || j.state === 'running' || Date.now() - (j.endedAt ?? 0) < 60_000).map(pub)
export const liveScore = (id: string) => jobs.find((j) => j.id === id)?.score ?? ''
export const isBusy = () => running !== null
const update = (j: InternalJob) => emit({ type: 'job', job: pub(j) })

export function enqueue(draft: Draft): Job[] {
  const d = { ...draft }
  if (d.mode === 'simple') {
    if (!d.description.trim()) throw new Error('describe the song first')
  } else if (!effectiveLyrics(d)) {
    throw new Error('write some lyrics (or switch on Instrumental)')
  }
  if (d.abc.trim() && d.cot === 'off') throw new Error('a score needs "Melody + chords" or "Melody only" planning')
  const group = newId()
  const n = d.takes === 2 ? 2 : 1
  const label = d.mode === 'simple' ? d.description.trim() : d.title.trim() || guessTitle(effectiveLyrics(d), d.style)
  const out: Job[] = []
  groups.set(group, { written: null })
  for (let i = 0; i < n; i++) {
    const seed = d.randomSeed ? Math.floor(Math.random() * 2 ** 31) : d.seed + i
    const job: InternalJob = {
      id: newId(),
      group,
      index: i,
      of: n,
      label: label.slice(0, 90),
      mode: d.mode,
      cot: d.cot,
      state: 'queued',
      stage: null,
      abcTokens: 0,
      semanticTokens: 0,
      tps: null,
      renderStep: 0,
      renderTotal: 0,
      decodeStep: 0,
      decodeTotal: 0,
      createdAt: Date.now(),
      startedAt: null,
      endedAt: null,
      error: null,
      songId: null,
      seed,
      title: d.mode === 'custom' ? label : null,
      style: d.mode === 'custom' ? d.style : null,
      draft: d,
      abort: new AbortController(),
      score: '',
    }
    jobs.push(job)
    update(job)
    out.push(pub(job))
  }
  while (jobs.length > 60 && jobs[0].state !== 'queued' && jobs[0].state !== 'running') jobs.shift()
  log(`[studio] queued ${n} take${n > 1 ? 's' : ''}: ${label.slice(0, 60)} (${jobs.filter((j) => j.state === 'queued').length} waiting)`, 'dim')
  pump()
  return out
}

export function cancel(id: string) {
  const j = jobs.find((x) => x.id === id)
  if (!j) throw new Error('job not found')
  if (j.state === 'queued') {
    j.state = 'cancelled'
    j.endedAt = Date.now()
    update(j)
    return
  }
  if (j.state !== 'running') return
  log('[studio] cancelling…', 'warn')
  j.abort.abort()
}

function pump() {
  if (running) return
  const next = jobs.find((j) => j.state === 'queued')
  if (!next) {
    scheduleIdle(getSettings().keepLoadedMin)
    return
  }
  running = next
  run(next)
    .catch((e: Error) => {
      const cancelled = next.abort.signal.aborted
      next.state = cancelled ? 'cancelled' : 'failed'
      next.error = cancelled ? null : e.message
      log(cancelled ? '[studio] cancelled' : `[studio] failed: ${e.message}`, cancelled ? 'warn' : 'error')
      if (next.songId) fs.rmSync(songDir(next.songId), { recursive: true, force: true })
      next.songId = null
    })
    .finally(() => {
      next.endedAt = Date.now()
      next.stage = null
      update(next)
      if (!jobs.some((j) => j.group === next.group && (j.state === 'queued' || j.state === 'running') && j !== next)) groups.delete(next.group)
      running = null
      pump()
    })
}

/** Stop what holds the GPU and make sure YuE2 has the RAM it needs. */
async function makeRoom(autoStopOthers: boolean, signal: AbortSignal) {
  await stopLocalLlm()
  if (STOP_CONTAINERS.length) {
    if (autoStopOthers) await stopOtherContainers()
    else {
      const still = othersRunning(await runningContainers())
      if (still.length) log(`[vram] ${still.join(', ')} still hold${still.length > 1 ? '' : 's'} VRAM (auto-stop is off), YuE2 may run out of memory`, 'warn')
    }
  }
  if (workerState() !== 'stopped') return
  await freeOtherApps(signal)
  // a ComfyUI render holds ~16 GB RAM/VRAM until it ends: never load YuE2 next to it
  for (let waiting = false; await comfyBusy(); ) {
    if (!waiting) log('[vram] waiting for ComfyUI to finish its render…', 'warn')
    waiting = true
    if (signal.aborted) throw new Error('cancelled')
    await sleep(3000)
  }
  if (await freeComfy()) log('[vram] ComfyUI: unloaded cached models', 'dim')
  for (let i = 0; i < 10; i++) {
    const free = memAvailable()
    if (free === null || free >= MIN_FREE_RAM) return
    await sleep(500)
  }
  const gb = ((memAvailable() ?? 0) / 2 ** 30).toFixed(1)
  throw new Error(
    `only ${gb} GB RAM available, YuE2 needs ~${(MIN_FREE_RAM / 2 ** 30).toFixed(0)} GB free. Close something first (or lower YUE2_MIN_FREE_GB in config.env)`,
  )
}

async function run(j: InternalJob) {
  const d = j.draft
  const signal = j.abort.signal
  const settings = getSettings()
  j.state = 'running'
  j.startedAt = Date.now()
  update(j)
  const timings: Timings = { write: null, load: null, compose: null, sing: null, render: null, decode: null, total: 0 }

  // 1) Write: title / style / lyrics from the description (once per click)
  let title = d.title.trim()
  let style = d.style.trim()
  let lyrics = effectiveLyrics(d)
  let lyricsBy: Song['lyricsBy'] = 'user'
  if (d.mode === 'simple') {
    const g = groups.get(j.group) ?? { written: null }
    if (!g.written) {
      j.stage = 'write'
      update(j)
      const t0 = Date.now()
      const stream = logStream('dim')
      g.written = await writeLyrics(
        { idea: d.description, language: d.language, instrumental: d.instrumental },
        { status: (s) => log(`[lyrics] ${s}`, 'dim'), delta: (t) => stream.write(t) },
        signal,
      )
      stream.end()
      groups.set(j.group, g)
      timings.write = (Date.now() - t0) / 1000
    }
    title = g.written.title
    style = g.written.style
    lyrics = d.instrumental ? INSTRUMENTAL_LYRICS : g.written.lyrics
    lyricsBy = 'llm'
  }
  title ||= guessTitle(lyrics, style)
  j.title = title
  j.style = style
  update(j)
  if (signal.aborted) throw new Error('cancelled')

  // 2) Load
  j.stage = 'load'
  update(j)
  const tLoad = Date.now()
  await makeRoom(settings.autoStopOthers, signal)
  const stageSec: Partial<Record<Stage, number>> = {}
  const handlers: Handlers = {
    stage(stage) {
      if (j.stage !== stage) {
        j.stage = stage
        update(j)
      }
    },
    progress(stage, completed, total, seconds) {
      if (stage === 'compose') j.abcTokens = completed
      else if (stage === 'sing') {
        j.semanticTokens = completed
        j.tps = seconds > 0.5 ? completed / seconds : null
      } else if (stage === 'render') {
        j.renderStep = completed
        j.renderTotal = total ?? 0
      } else if (stage === 'decode' && total) {
        j.decodeStep = completed
        j.decodeTotal = total
      }
      update(j)
    },
    stageEnd(stage, _label, seconds) {
      stageSec[stage] = (stageSec[stage] ?? 0) + seconds
    },
    score(text) {
      j.score = text
      emit({ type: 'score', jobId: j.id, text })
    },
  }
  const abortLoad = () => void stopWorker()
  signal.addEventListener('abort', abortLoad, { once: true })
  try {
    await ensureWorker(settings.backend, handlers, signal)
  } finally {
    signal.removeEventListener('abort', abortLoad)
  }
  if (signal.aborted) throw new Error('cancelled')
  // load = making room + spawning/verifying here, plus "Loading model" (weights → GPU) inside the worker's first stage
  const readySec = (Date.now() - tLoad) / 1000
  stageSec.load = 0

  // 3) Compose → Sing → Render → Decode → Save (all inside the worker)
  const songId = newId()
  j.songId = songId
  const dir = songDir(songId)
  fs.mkdirSync(dir, { recursive: true })
  const abc = d.abc.trim() || null
  log(`[studio] ▶ "${title}" · ${d.cot}${abc ? ` · ${d.abcFrom?.kind ?? 'given'} score` : ''} · seed ${j.seed}${d.cfgScale != null ? ` · cfg ${d.cfgScale}` : ''}`, 'ok')
  log(`[studio] style: ${style || '(none)'}`, 'dim')
  const done = await generate({ style, lyrics, cot: d.cot, seed: j.seed, cfg_scale: d.cfgScale, abc, out: dir }, handlers, signal)

  j.stage = 'save'
  update(j)
  timings.load = readySec + (stageSec.load ?? 0)
  timings.compose = stageSec.compose ?? null
  timings.sing = stageSec.sing ?? null
  timings.render = stageSec.render ?? done.timing.nar_seconds ?? null
  timings.decode = stageSec.decode ?? done.timing.vae_seconds ?? null
  timings.total = (Date.now() - j.startedAt) / 1000
  const song: Song = {
    id: songId,
    title,
    createdAt: Date.now(),
    style,
    lyrics,
    description: d.mode === 'simple' ? d.description.trim() : null,
    lyricsBy,
    cot: d.cot,
    seed: j.seed,
    cfgScale: d.cfgScale,
    abcInput: abc,
    score: done.score,
    source: d.abcFrom && abc ? { kind: d.abcFrom.kind, songId: d.abcFrom.songId, title: d.abcFrom.title } : { kind: 'new', songId: null, title: null },
    dir: path.relative(DATA_DIR, dir),
    file: path.relative(DATA_DIR, path.join(dir, 'audio.flac')),
    duration: done.duration,
    peaks: done.peaks,
    truncated: done.truncated,
    tokens: done.tokens,
    starred: false,
    timings,
  }
  saveSong(song)
  j.state = 'done'
  emit({ type: 'song', song })
  if (done.truncated.semantic) log('[studio] the song hit the 9000-token (6 min) limit and was cut off', 'warn')
  log(`[studio] done: "${title}" · ${Math.floor(done.duration / 60)}:${String(Math.round(done.duration % 60)).padStart(2, '0')} of music in ${timings.total.toFixed(0)}s`, 'ok')
}
