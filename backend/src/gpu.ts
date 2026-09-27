// Memory readings (VRAM, RAM) and the optional ComfyUI neighbour on the same GPU.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { promisify } from 'node:util'
import { COMFY_URL, GPU, GPU_DEVICE } from './config.ts'

const exec = promisify(execFile)

/** Asks ComfyUI to drop its cached models (it keeps ~16 GB in RAM/VRAM otherwise). */
export async function freeComfy(): Promise<boolean> {
  if (!COMFY_URL) return false
  try {
    const r = await fetch(`${COMFY_URL}/free`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
      signal: AbortSignal.timeout(5000),
    })
    return r.ok
  } catch {
    return false
  }
}

/** true while ComfyUI renders (its models then sit in RAM + VRAM until the prompt ends) */
export async function comfyBusy(): Promise<boolean> {
  if (!COMFY_URL) return false
  try {
    const r = await fetch(`${COMFY_URL}/queue`, { signal: AbortSignal.timeout(2000) })
    const q = (await r.json()) as { queue_running?: unknown[] }
    return (q.queue_running?.length ?? 0) > 0
  } catch {
    return false
  }
}

export interface Vram {
  total: number
  used: number
}

/** AMD on Linux: amdgpu sysfs of the largest card (no tools needed). */
function amdVram(): Vram | null {
  let best: Vram | null = null
  try {
    for (const card of fs.readdirSync('/sys/class/drm')) {
      if (!/^card\d+$/.test(card)) continue
      const dir = `/sys/class/drm/${card}/device`
      try {
        const total = Number(fs.readFileSync(`${dir}/mem_info_vram_total`, 'utf8'))
        if (total > 4 * 2 ** 30 && total > (best?.total ?? 0)) best = { total, used: Number(fs.readFileSync(`${dir}/mem_info_vram_used`, 'utf8')) }
      } catch {
        /* not amdgpu */
      }
    }
  } catch {
    /* no sysfs */
  }
  return best
}

let nvidiaSmi = true
/** NVIDIA (Linux + Windows): nvidia-smi, the selected GPU or the largest one. */
async function nvidiaVram(): Promise<Vram | null> {
  if (!nvidiaSmi) return null
  try {
    const { stdout } = await exec('nvidia-smi', ['--query-gpu=index,memory.total,memory.used', '--format=csv,noheader,nounits'], { timeout: 5000 })
    const gpus = stdout
      .trim()
      .split('\n')
      .map((l) => l.split(',').map((s) => Number(s.trim())))
      .map(([index, total, used]) => ({ index, total: total * 2 ** 20, used: used * 2 ** 20 }))
    const pick = gpus.find((g) => String(g.index) === GPU_DEVICE.split(',')[0]) ?? gpus.sort((a, b) => b.total - a.total)[0]
    return pick ? { total: pick.total, used: pick.used } : null
  } catch {
    nvidiaSmi = false // not installed: don't spawn it every 2 s
    return null
  }
}

export async function readVram(): Promise<Vram | null> {
  if (GPU === 'nvidia') return nvidiaVram()
  return process.platform === 'linux' ? amdVram() : null
}

export function memAvailable(): number | null {
  if (process.platform !== 'linux') return os.freemem()
  try {
    const m = /MemAvailable:\s+(\d+) kB/.exec(fs.readFileSync('/proc/meminfo', 'utf8'))
    return m ? Number(m[1]) * 1024 : null
  } catch {
    return null
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
