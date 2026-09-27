// Types shared by backend and frontend (erasable TS only: no enums).

/** YuE2 chain-of-thought planning: melody + chords, melody only, or no symbolic plan */
export type Cot = 'full' | 'melody' | 'off'
/** simple = describe the song, the LLM writes title/style/lyrics · custom = you write them */
export type CreateMode = 'simple' | 'custom'
export type Stage = 'write' | 'load' | 'compose' | 'sing' | 'render' | 'decode' | 'save'

export interface Draft {
  mode: CreateMode
  /** simple mode: what the song should be about / sound like */
  description: string
  language: string
  instrumental: boolean
  title: string
  lyrics: string
  style: string
  cot: Cot
  /** optional ABC score (reused from a take for covers/remixes, or pasted) */
  abc: string
  /** where the score came from, shown in the UI */
  abcFrom: { songId: string; title: string; kind: 'remix' | 'cover' } | null
  cfgScale: number | null
  seed: number
  randomSeed: boolean
  /** songs per click (Suno makes 2); each gets its own seed */
  takes: 1 | 2
}

export interface Timings {
  write: number | null
  load: number | null
  compose: number | null
  sing: number | null
  render: number | null
  decode: number | null
  total: number
}

export interface Song {
  id: string
  title: string
  createdAt: number
  style: string
  lyrics: string
  /** simple-mode description the lyrics were written from, if any */
  description: string | null
  lyricsBy: 'user' | 'llm'
  cot: Cot
  seed: number
  cfgScale: number | null
  /** score the take was conditioned on (cover / remix), null = composed by YuE2 */
  abcInput: string | null
  /** final score (ABC) the song was sung from, null for cot=off */
  score: string | null
  source: { kind: 'new' | 'remix' | 'cover'; songId: string | null; title: string | null }
  /** paths relative to the data dir */
  dir: string
  file: string
  duration: number
  /** ~240 peak values 0..100 for the waveform */
  peaks: number[]
  truncated: { abc: boolean; semantic: boolean }
  tokens: { abc: number; semantic: number; tps: number | null }
  starred: boolean
  timings: Timings
}

export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export interface Job {
  id: string
  /** jobs created by one click share a group (and the lyrics written for it) */
  group: string
  index: number
  of: number
  label: string
  mode: CreateMode
  cot: Cot
  state: JobState
  stage: Stage | null
  /** score tokens written so far */
  abcTokens: number
  /** semantic (codec) tokens so far, 25 per second of audio */
  semanticTokens: number
  tps: number | null
  renderStep: number
  renderTotal: number
  decodeStep: number
  decodeTotal: number
  createdAt: number
  startedAt: number | null
  endedAt: number | null
  error: string | null
  songId: string | null
  seed: number
  /** title + style once known (after the lyrics writer ran) */
  title: string | null
  style: string | null
}

export type WorkerState = 'stopped' | 'starting' | 'ready' | 'busy'

export interface Status {
  /** GPU vendor from the installer: picks CUDA or ROCm wording and the worker's settings */
  gpu: 'amd' | 'nvidia' | null
  /** GPU name + torch build, as reported by the last YuE2 worker */
  engine: string | null
  vramTotal: number | null
  vramFree: number | null
  memAvailable: number | null
  worker: WorkerState
  /** configured containers (STOP_CONTAINERS) that hold VRAM right now */
  others: string[]
  /** an OpenAI-compatible model answers at LLM_URL (lyrics writer) */
  llmReady: boolean
  llmModel: string | null
  /** the studio's own llama-server: null = not installed / not used */
  llmLocal: 'stopped' | 'starting' | 'running' | null
  /** something is set up to write lyrics (own llama-server, LLM_START_URL, or a model answering) */
  llmAvailable: boolean
  models: { yue2: boolean; vae: boolean; venv: boolean }
  ffmpeg: boolean
}

export interface LogLine {
  t: number
  channel: 'output' | 'worker'
  text: string
  level?: 'info' | 'ok' | 'warn' | 'error' | 'dim'
}

export interface PathsInfo {
  dataDir: string
  modelDir: string
  vaeDir: string
  python: string
  worker: string
  llmUrl: string
  /** the studio's own llama-server + model, null when not used */
  llmServer: string | null
  llmGguf: string | null
}

export interface StudioSettings {
  /** stop the configured VRAM-holding containers (STOP_CONTAINERS) before YuE2 loads */
  autoStopOthers: boolean
  /** keep YuE2 in memory this many minutes after the last song (0 = unload right away) */
  keepLoadedMin: number
  /** torch = CUDA/HIP graphs (fast), torch-eager = plain PyTorch (fallback) */
  backend: 'torch' | 'torch-eager'
}

export interface AppState {
  /** frontend build id (bundle file name); the page reloads itself when it changes */
  build: string
  songs: Song[]
  status: Status
  jobs: Job[]
  logs: LogLine[]
  paths: PathsInfo
  settings: StudioSettings
  draft: Draft
}

/** NDJSON lines streamed by POST /api/lyrics */
export type LyricsEvent =
  | { status: string }
  | { delta: string }
  | { done: true; title: string; style: string; lyrics: string }
  | { error: string }

export type ServerEvent =
  | { type: 'job'; job: Job }
  | { type: 'log'; line: LogLine }
  | { type: 'song'; song: Song }
  | { type: 'songDeleted'; id: string }
  /** the score as YuE2 writes it (streamed during "compose") */
  | { type: 'score'; jobId: string; text: string }
  | { type: 'status'; status: Status }
  | { type: 'settings'; settings: StudioSettings }
