// Downloads: YuE2 weights, the YuE2 inference package, the optional lyrics LLM. Used by the installer (downloads)
// and the backend (a file only counts as present at its exact size: an interrupted download would be shorter).

export interface ModelFile {
  url: string
  /** path relative to the model folder */
  file: string
  size: number
  /** checked after download */
  sha256?: string
}

const hf = (repo: string, rev: string, file: string) => `https://huggingface.co/${repo}/resolve/${rev}/${file}`

// pinned revisions: a changed upstream file must not break installs half way
const YUE2_REV = '14fc6c6f146441b1dd6363fcb2e01e82a6914cb7'
const VAE_REV = '9a94e1d0ea9f8087e98f77fa88df4a4068104d2a'
const LLM_REV = 'f9093662a2e7ae0503f637088bc96f77a1a70c83'
const LLM_SMALL_REV = 'bfc15c382204943c3a8fff0c750b94ae2364d7a3'

const repoFiles = (repo: string, rev: string, dir: string, files: [string, number, string?][]): ModelFile[] =>
  files.map(([file, size, sha256]) => ({ url: hf(repo, rev, file), file: `${dir}/${file}`, size, sha256 }))

/** m-a-p/YuE2-3B (CC BY-NC 4.0): the song model, 7.3 GB bf16 */
export const YUE2_FILES = repoFiles('m-a-p/YuE2-3B', YUE2_REV, 'YuE2-3B', [
  ['config.json', 959],
  ['generation_config.json', 204],
  ['yue2_generation_config.json', 466],
  ['modeling_yue2.py', 32983],
  ['qwen.tiktoken', 2561218],
  ['weights_manifest.json', 179],
  ['LICENSE', 20309],
  ['model.safetensors', 7261441640, '1d55c42c1a9875c34f5d736e15078449992b044e807ce2a138e6cf289a1e59e9'],
])

/** m-a-p/YuE2-Vae (CC BY-NC 4.0): latents → 48 kHz stereo */
export const VAE_FILES = repoFiles('m-a-p/YuE2-Vae', VAE_REV, 'YuE2-Vae', [
  ['config.json', 1378],
  ['modeling_vae.py', 25265],
  ['weights_manifest.json', 178],
  ['LICENSE', 20309],
  ['model.safetensors', 530512720, '807ce9d5149fa27c5ad3e6582058469852e908f6c5acc8c8aa338e7ab7751346'],
])

/** YuE2 inference package (pins torch 2.10.0, transformers 4.57.6, …), published in the model repo */
export const YUE2_WHEEL = `yue2-infer @ ${hf('m-a-p/YuE2-3B', YUE2_REV, 'yue2_infer-0.1.5-py3-none-any.whl')}`

/**
 * Lyrics writer for "simple" mode, run by llama.cpp: Gemma 4 26B-A4B (MoE, 4B active) QAT, uncensored by HauhauCS
 * (Gemma license). No refusals for dark or explicit song topics. Any OpenAI-compatible server works instead.
 */
export const LLM_FILE: ModelFile = {
  url: hf('HauhauCS/Gemma4-26B-A4B-QAT-Uncensored-HauhauCS-Balanced-MTP', LLM_REV, 'Gemma4-26B-A4B-QAT-Uncensored-HauhauCS-Balanced-Q4_K_M.gguf'),
  file: 'lyrics/Gemma4-26B-A4B-QAT-Uncensored-HauhauCS-Balanced-Q4_K_M.gguf',
  size: 16796015520,
  sha256: '3c13133469e431312fffb8b1d9c85ae42199e6bb5746ea1da84e8ddf2097d73c',
}

/** smaller alternative for cards below ~20 GB VRAM (installer --small-lyrics-llm): Gemma 4 E4B (Apache 2.0) */
export const LLM_FILE_SMALL: ModelFile = {
  url: hf('unsloth/gemma-4-E4B-it-GGUF', LLM_SMALL_REV, 'gemma-4-E4B-it-Q4_K_M.gguf'),
  file: 'lyrics/gemma-4-E4B-it-Q4_K_M.gguf',
  size: 4977171584,
}
