// YuE2 worker process (../worker/yue2_worker.py): spawned on demand, one song at a time, JSON lines over stdio.
// It stays loaded for settings.keepLoadedMin after the last song; POST /api/free (other GPU apps) unloads it early.
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import path from 'node:path'
import readline from 'node:readline'
import type { Stage, StudioSettings, WorkerState } from '../../shared/types.ts'
import { DATA_DIR, STUDIO_DIR, WORKER_ENV, YUE2 } from './config.ts'
import { log } from './hub.ts'

export interface SongRequest {
  style: string
  lyrics: string
  cot: string
  seed: number
  cfg_scale: number | null
  abc: string | null
  /** absolute output dir for YuE2's artifacts */
  out: string
}

export interface DoneEvent {
  duration: number
  peaks: number[]
  score: string | null
  truncated: { abc: boolean; semantic: boolean }
  timing: { e2e_seconds: number; nar_seconds: number; vae_seconds: number }
  tokens: { abc: number; semantic: number; tps: number | null }
}

type WorkerEvent =
  | { ev: 'ready'; seconds: number; device: string; torch: string; hip: string | null; backend: string; attention: string }
  | { ev: 'stage'; stage: Stage; label: string; total: number | null }
  | { ev: 'progress'; stage: Stage; completed: number; total: number | null; seconds: number }
  | { ev: 'stage_end'; stage: Stage; label: string; seconds: number }
  | { ev: 'score'; text: string }
  | ({ ev: 'done' } & DoneEvent)
  | { ev: 'error'; message: string; cancelled: boolean; fatal: boolean }

export interface Handlers {
  stage?: (stage: Stage, label: string, total: number | null) => void
  progress?: (stage: Stage, completed: number, total: number | null, seconds: number) => void
  stageEnd?: (stage: Stage, label: string, seconds: number) => void
  score?: (text: string) => void
}

let proc: ChildProcessWithoutNullStreams | null = null
let state: WorkerState = 'stopped'
let backend: StudioSettings['backend'] | null = null
let idleTimer: ReturnType<typeof setTimeout> | undefined
let onReady: ((e: Error | null) => void) | null = null
let current: { h: Handlers; resolve: (d: DoneEvent) => void; reject: (e: Error) => void } | null = null
/** load stages seen before the first job (the worker verifies files right after spawning) */
let pending: Handlers | null = null

/** what the last worker reported: GPU name + torch build, shown in the UI */
let engine: string | null = null

export const workerState = () => state
export const workerEngine = () => engine

function dispatch(e: WorkerEvent) {
  const h = current?.h ?? pending ?? {}
  switch (e.ev) {
    case 'ready':
      state = 'ready'
      engine = `${e.device} · torch ${e.torch}`
      log(`[worker] ready in ${e.seconds.toFixed(1)}s · ${e.device} · torch ${e.torch}${e.hip ? ` · HIP ${e.hip}` : ''} · ${e.backend}`, 'dim')
      onReady?.(null)
      onReady = null
      break
    case 'stage':
      h.stage?.(e.stage, e.label, e.total)
      break
    case 'progress':
      h.progress?.(e.stage, e.completed, e.total, e.seconds)
      break
    case 'stage_end':
      h.stageEnd?.(e.stage, e.label, e.seconds)
      break
    case 'score':
      h.score?.(e.text)
      break
    case 'done': {
      const { ev: _ev, ...done } = e
      current?.resolve(done)
      current = null
      if (proc) state = 'ready'
      break
    }
    case 'error': {
      const err = new Error(e.cancelled ? 'cancelled' : e.message)
      if (current) {
        current.reject(err)
        current = null
      } else if (onReady) {
        onReady(err)
        onReady = null
      }
      if (proc && !e.fatal) state = 'ready'
      break
    }
  }
}

function spawnWorker(wanted: StudioSettings['backend']): Promise<void> {
  state = 'starting'
  backend = wanted
  log(`[worker] starting YuE2 (${wanted}, attention ${YUE2.attention})`, 'info')
  const p = spawn(YUE2.python, [YUE2.script], {
    cwd: STUDIO_DIR,
    env: {
      ...process.env,
      ...WORKER_ENV,
      YUE2_MODEL: YUE2.model,
      YUE2_VAE: YUE2.vae,
      YUE2_BACKEND: wanted,
      YUE2_ATTENTION: YUE2.attention,
      YUE2_HASH_CACHE: path.join(DATA_DIR, 'weights-hashes.json'),
    },
  })
  proc = p
  readline.createInterface({ input: p.stdout }).on('line', (line) => {
    try {
      dispatch(JSON.parse(line) as WorkerEvent)
    } catch {
      log(line, 'dim', 'worker')
    }
  })
  readline.createInterface({ input: p.stderr }).on('line', (line) => {
    const level = /Traceback|Error|error:/.test(line) ? 'error' : /warn/i.test(line) ? 'warn' : line.startsWith('[YuE2]') ? 'dim' : 'info'
    log(line, level, 'worker')
  })
  return new Promise((resolve, reject) => {
    onReady = (e) => (e ? reject(e) : resolve())
    p.on('error', (e) => {
      onReady?.(e)
      onReady = null
    })
    p.on('exit', (code, signal) => {
      if (proc === p) {
        proc = null
        state = 'stopped'
        backend = null
      }
      const why = signal ? `signal ${signal}` : `code ${code}`
      if (code !== 0 || signal) log(`[worker] exited (${why})${signal === 'SIGKILL' ? ' — out of memory?' : ''}`, code === 0 ? 'dim' : 'warn')
      else log('[worker] unloaded', 'dim')
      const err = new Error(`YuE2 worker exited (${why}), see Worker log`)
      onReady?.(err)
      onReady = null
      current?.reject(err)
      current = null
    })
  })
}

/** Start the worker (or reuse it) and wait until the model files are verified. */
export async function ensureWorker(wanted: StudioSettings['backend'], h: Handlers, signal: AbortSignal): Promise<void> {
  clearTimeout(idleTimer)
  if (proc && backend !== wanted) await stopWorker()
  if (proc && state !== 'starting') return
  pending = h
  const abort = () => void stopWorker()
  signal.addEventListener('abort', abort, { once: true })
  try {
    await (proc ? new Promise<void>((res, rej) => (onReady = (e) => (e ? rej(e) : res()))) : spawnWorker(wanted))
  } finally {
    signal.removeEventListener('abort', abort)
    pending = null
  }
}

export function generate(req: SongRequest, h: Handlers, signal: AbortSignal): Promise<DoneEvent> {
  if (!proc || state !== 'ready') return Promise.reject(new Error('YuE2 worker is not ready'))
  clearTimeout(idleTimer)
  state = 'busy'
  const p = proc
  return new Promise<DoneEvent>((resolve, reject) => {
    const onAbort = () => p.stdin.write(`${JSON.stringify({ cmd: 'cancel' })}\n`)
    signal.addEventListener('abort', onAbort, { once: true })
    current = {
      h,
      resolve: (d) => {
        signal.removeEventListener('abort', onAbort)
        resolve(d)
      },
      reject: (e) => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      },
    }
    p.stdin.write(`${JSON.stringify({ cmd: 'generate', ...req })}\n`)
  })
}

/** After the queue drained: unload now, or after keepLoadedMin minutes. */
export function scheduleIdle(minutes: number) {
  clearTimeout(idleTimer)
  if (!proc) return
  if (minutes <= 0) {
    void stopWorker()
    return
  }
  idleTimer = setTimeout(() => {
    if (state === 'ready') {
      log(`[worker] idle for ${minutes} min, unloading YuE2`, 'dim')
      void stopWorker()
    }
  }, minutes * 60_000)
}

export async function stopWorker(): Promise<void> {
  clearTimeout(idleTimer)
  const p = proc
  if (!p) return
  await new Promise<void>((resolve) => {
    const kill = setTimeout(() => p.kill('SIGKILL'), 15_000)
    p.once('exit', () => {
      clearTimeout(kill)
      resolve()
    })
    if (state === 'starting') p.kill('SIGTERM')
    else p.stdin.write(`${JSON.stringify({ cmd: 'quit' })}\n`)
  })
}
