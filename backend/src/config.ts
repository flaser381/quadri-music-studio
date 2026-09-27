import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { LLM_FILE } from '../../shared/models.ts'

const here = path.dirname(fileURLToPath(import.meta.url))

export const STUDIO_DIR = path.resolve(here, '../..')

// Local settings (created by the installer from config.env.example). Real environment variables win.
export const CONFIG_FILE = path.join(STUDIO_DIR, 'config.env')
if (fs.existsSync(CONFIG_FILE)) process.loadEnvFile(CONFIG_FILE)
const env = process.env

/** relative paths are relative to the studio folder */
const dir = (p: string) => path.resolve(STUDIO_DIR, p)
const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const args = (v: string | undefined) => (v ?? '').split(/\s+/).filter(Boolean)
const WIN = process.platform === 'win32'

export const DATA_DIR = dir(env.STUDIO_DATA ?? 'data')
export const FRONTEND_DIST = path.join(STUDIO_DIR, 'frontend/dist')
export const RUNTIME_DIR = path.join(STUDIO_DIR, 'runtime')

export const HOST = env.STUDIO_HOST ?? '127.0.0.1'
export const PORT = Number(env.STUDIO_PORT ?? 8096)
/** open the UI in the browser once the server listens (set by start.sh / start.bat) */
export const OPEN_BROWSER = env.STUDIO_OPEN === '1'

// ---------- YuE2 worker (Python + PyTorch, worker/yue2_worker.py) ----------

/** amd | nvidia, written by the installer */
export const GPU = env.GPU === 'nvidia' ? 'nvidia' : env.GPU === 'amd' ? 'amd' : null
/** index of the GPU to use when there are several (e.g. an APU's iGPU next to the card), written by the installer */
export const GPU_DEVICE = env.GPU_DEVICE ?? ''

export const MODELS_DIR = dir(env.YUE2_MODELS ?? 'models')
export const VENV_DIR = dir(env.YUE2_VENV ?? 'runtime/venv')
export const YUE2 = {
  model: path.join(MODELS_DIR, 'YuE2-3B'),
  vae: path.join(MODELS_DIR, 'YuE2-Vae'),
  python: dir(env.YUE2_PYTHON ?? path.join(VENV_DIR, WIN ? 'Scripts/python.exe' : 'bin/python')),
  script: path.join(STUDIO_DIR, 'worker/yue2_worker.py'),
  /**
   * Attention inside the AR decode graphs (see patch_attention in the worker):
   * auto = YuE2's own choice (varlen FlashAttention: the fast path on NVIDIA, rejected by ROCm)
   * sdpa = masked SDPA (slow on ROCm) · fast = matmul + softmax per CFG branch (the AMD default)
   */
  attention: env.YUE2_ATTENTION ?? (GPU === 'nvidia' ? 'auto' : 'fast'),
}

/** Environment for the torch process. */
export const WORKER_ENV: Record<string, string> = {
  HF_HUB_OFFLINE: '1',
  TOKENIZERS_PARALLELISM: 'false',
  PYTHONUNBUFFERED: '1',
  // lyrics arrive as UTF-8 on stdin (Windows would decode them as the ANSI code page)
  PYTHONUTF8: '1',
  ...(GPU === 'nvidia'
    ? { PYTORCH_CUDA_ALLOC_CONF: 'expandable_segments:True', ...(GPU_DEVICE ? { CUDA_VISIBLE_DEVICES: GPU_DEVICE } : {}) }
    : {
        MIOPEN_FIND_MODE: 'FAST',
        TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL: '1',
        PYTORCH_HIP_ALLOC_CONF: 'expandable_segments:True',
        // one unsupported device (an APU's iGPU) can make ROCm libraries fall back to slow paths
        ...(GPU_DEVICE ? { HIP_VISIBLE_DEVICES: GPU_DEVICE } : {}),
      }),
}

/** refuse to load YuE2 below this much available RAM (it takes ~10 GB while singing) */
export const MIN_FREE_RAM = Number(env.YUE2_MIN_FREE_GB ?? 12) * 2 ** 30

// ---------- lyrics writer (OpenAI-compatible chat API) ----------

export const LLM = {
  /** base URL without /v1: the studio's own llama-server, or Ollama (:11434), LM Studio (:1234), … */
  url: (env.LLM_URL ?? 'http://127.0.0.1:8097').replace(/\/+$/, '').replace(/\/v1$/, ''),
  /** model name sent with requests (default: the first one the server lists) */
  model: env.LLM_MODEL || null,
  apiKey: env.LLM_API_KEY || null,
  /** llama-server binary the studio starts when nothing answers at `url`. Empty = never start one. */
  server: env.LLM_SERVER === '' ? null : dir(env.LLM_SERVER ?? path.join('runtime/llama.cpp', WIN ? 'llama-server.exe' : 'llama-server')),
  gguf: dir(env.LLM_GGUF ?? path.join(MODELS_DIR, LLM_FILE.file)),
  /** extra llama-server flags, e.g. `--device Vulkan1` */
  args: args(env.LLM_ARGS),
  /** alternative: POST here to have something else load a model at `url` (e.g. a model manager) */
  startUrl: env.LLM_START_URL || null,
  /** headers for LLM_START_URL, `Name: value` separated by commas */
  startHeaders: Object.fromEntries(
    list(env.LLM_START_HEADERS)
      .map((h) => [h.slice(0, h.indexOf(':')).trim(), h.slice(h.indexOf(':') + 1).trim()])
      .filter(([k]) => k),
  ) as Record<string, string>,
}

// ---------- other GPU users on the same machine (optional) ----------

/**
 * A ComfyUI on the same GPU (e.g. Quadri Image Studio's): YuE2 waits while it renders and asks it to drop its
 * cached models before loading. Empty = don't talk to ComfyUI.
 */
export const COMFY_URL = env.COMFY_URL === '' ? null : (env.COMFY_URL ?? 'http://127.0.0.1:8188')

/** `podman` or `docker` */
export const CONTAINER_CLI = env.CONTAINER_CLI ?? 'podman'

/**
 * Containers that hold VRAM (e.g. an LLM server), stopped before YuE2 loads (setting "Stop other GPU apps").
 * Entries: `name` (→ `<cli> stop name`) or `name@composeDir` (→ `<cli> compose down` in that folder).
 */
export const STOP_CONTAINERS = list(env.STOP_CONTAINERS).map((s) => {
  const at = s.indexOf('@')
  return at < 0 ? { name: s, composeDir: null } : { name: s.slice(0, at), composeDir: dir(s.slice(at + 1)) }
})

/**
 * Other local apps asked to free their GPU memory before YuE2 loads: POST with header `X-Studio: 1`.
 * A 409 answer means "busy, can't unload now": the song waits and asks again.
 */
export const FREE_URLS = list(env.FREE_URLS)
