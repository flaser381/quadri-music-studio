// App store: server state (SSE-synced), the create-form draft and the library selection.
import { reactive, watch } from 'vue'
import { DEFAULT_DRAFT, hasChords, stripChords } from '../../shared/music.ts'
import type { Draft, Job, LogLine, PathsInfo, ServerEvent, Song, Status, StudioSettings } from '../../shared/types.ts'
import { api, streamLyrics } from './api.ts'

export const S = reactive({
  ready: false,
  online: false,
  songs: [] as Song[],
  status: null as Status | null,
  jobs: [] as Job[],
  logs: [] as LogLine[],
  paths: null as PathsInfo | null,
  settings: { autoStopOthers: true, keepLoadedMin: 5, backend: 'torch' } as StudioSettings,
  draft: { ...DEFAULT_DRAFT } as Draft,
  selectedId: null as string | null,
  /** live score text per running job */
  scores: {} as Record<string, string>,
  filter: 'all' as 'all' | 'starred',
  query: '',
  /** AI lyrics writer (custom mode) */
  writer: { active: false, status: '', text: '' },
  toast: null as null | { text: string; kind: 'error' | 'info' },
  modal: null as null | 'settings',
})

export function toast(text: string, kind: 'error' | 'info' = 'error') {
  const t = { text, kind }
  S.toast = t
  setTimeout(() => {
    if (S.toast === t) S.toast = null
  }, 6000)
}

async function guard<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    return await p
  } catch (e) {
    toast((e as Error).message)
    return undefined
  }
}

// ---------- boot + SSE ----------

let bootBuild = ''

/** Reload the page when a new frontend build is deployed (an open tab would keep running the old app). */
async function checkBuild() {
  try {
    const st = await api.state()
    if (bootBuild && st.build !== 'dev' && st.build !== bootBuild) location.reload()
  } catch {
    /* backend restarting */
  }
}

let loadingDraft = false

export async function boot() {
  const st = await api.state()
  bootBuild = st.build
  setInterval(checkBuild, 60_000)
  S.songs = st.songs
  S.status = st.status
  S.jobs = st.jobs
  S.logs = st.logs
  S.paths = st.paths
  S.settings = st.settings
  loadingDraft = true
  S.draft = { ...DEFAULT_DRAFT, ...st.draft }
  queueMicrotask(() => (loadingDraft = false))
  S.selectedId = st.songs[0]?.id ?? null
  for (const j of st.jobs.filter((x) => x.state === 'running')) S.scores[j.id] = (await api.score(j.id).catch(() => ({ text: '' }))).text
  S.ready = true
  connect()
}

function connect() {
  const es = new EventSource('/api/events')
  es.onopen = () => {
    S.online = true
    checkBuild()
  }
  es.onerror = () => (S.online = false)
  es.onmessage = (m) => onEvent(JSON.parse(m.data) as ServerEvent)
}

function onEvent(ev: ServerEvent) {
  switch (ev.type) {
    case 'job': {
      const i = S.jobs.findIndex((j) => j.id === ev.job.id)
      if (i >= 0) S.jobs[i] = ev.job
      else S.jobs.push(ev.job)
      if (ev.job.state !== 'running' && ev.job.state !== 'queued') delete S.scores[ev.job.id]
      break
    }
    case 'log':
      S.logs.push(ev.line)
      if (S.logs.length > 4000) S.logs.splice(0, S.logs.length - 3000)
      break
    case 'song': {
      const i = S.songs.findIndex((s) => s.id === ev.song.id)
      if (i >= 0) S.songs[i] = ev.song
      else {
        S.songs.unshift(ev.song)
        S.selectedId = ev.song.id
      }
      break
    }
    case 'songDeleted':
      S.songs = S.songs.filter((s) => s.id !== ev.id)
      if (S.selectedId === ev.id) S.selectedId = S.songs[0]?.id ?? null
      break
    case 'score':
      S.scores[ev.jobId] = ev.text
      break
    case 'status':
      S.status = ev.status
      break
    case 'settings':
      S.settings = ev.settings
      break
  }
}

// persist the draft (debounced) so a reload restores the form
let saveTimer: ReturnType<typeof setTimeout> | undefined
watch(
  () => ({ ...S.draft }),
  (d) => {
    if (loadingDraft) return
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => api.draft(d).catch(() => {}), 600)
  },
)

// ---------- library ----------

export const selectedSong = (): Song | null => S.songs.find((s) => s.id === S.selectedId) ?? null

export function visibleSongs(): Song[] {
  const q = S.query.trim().toLowerCase()
  return S.songs.filter(
    (s) =>
      (S.filter === 'all' || s.starred) &&
      (!q || s.title.toLowerCase().includes(q) || s.style.toLowerCase().includes(q) || s.lyrics.toLowerCase().includes(q)),
  )
}

export async function toggleStar(s: Song) {
  const r = await guard(api.patchSong(s.id, { starred: !s.starred }))
  if (r) s.starred = r.starred
}

export async function renameSong(s: Song, title: string) {
  if (!title.trim() || title === s.title) return
  const r = await guard(api.patchSong(s.id, { title }))
  if (r) s.title = r.title
}

export async function deleteSong(s: Song) {
  if (!confirm(`Delete "${s.title}"? This cannot be undone.`)) return
  await guard(api.deleteSong(s.id))
}

/** Same lyrics + style in the create form (new seed). */
export function reuse(s: Song) {
  Object.assign(S.draft, {
    mode: 'custom',
    title: s.title,
    style: s.style,
    lyrics: s.lyrics,
    instrumental: false,
    cot: s.cot,
    abc: s.abcInput ?? '',
    abcFrom: s.abcInput && s.source.songId ? { songId: s.source.songId, title: s.source.title ?? '', kind: s.source.kind === 'cover' ? 'cover' : 'remix' } : null,
    cfgScale: s.cfgScale,
  } satisfies Partial<Draft>)
}

/**
 * Remix: keep melody + chords (the whole score), change the style.
 * Cover: keep only the melody (chords stripped, melody-only planning), as the model card recommends.
 */
export function fromScore(s: Song, kind: 'remix' | 'cover') {
  if (!s.score) return toast('This song has no score (made without planning)')
  Object.assign(S.draft, {
    mode: 'custom',
    title: s.title,
    lyrics: s.lyrics,
    instrumental: false,
    cot: kind === 'cover' ? 'melody' : 'full',
    abc: kind === 'cover' ? stripChords(s.score) : s.score,
    abcFrom: { songId: s.id, title: s.title, kind },
  } satisfies Partial<Draft>)
  if (kind === 'remix' && !hasChords(s.score)) S.draft.cot = 'melody'
  toast(kind === 'cover' ? 'Melody loaded. Now describe a new style and press Create.' : 'Score loaded (melody + chords). Change the style and press Create.', 'info')
}

export function clearScore() {
  S.draft.abc = ''
  S.draft.abcFrom = null
}

// ---------- create ----------

export async function create() {
  const d = S.draft
  if (d.mode === 'simple' && !d.description.trim()) return toast('Describe the song first')
  if (d.mode === 'custom' && !d.instrumental && !d.lyrics.trim()) return toast('Write some lyrics first (or switch on Instrumental)')
  const jobs = await guard(api.create({ ...d }))
  for (const job of jobs ?? []) if (!S.jobs.some((j) => j.id === job.id)) S.jobs.push(job)
}

let writerAbort: AbortController | null = null

/** Custom mode: let the LLM write title / style / lyrics into the form, streaming. */
export async function writeLyrics(idea: string) {
  if (S.writer.active) {
    writerAbort?.abort()
    return
  }
  writerAbort = new AbortController()
  S.writer = { active: true, status: 'starting…', text: '' }
  const keepStyle = S.draft.style.trim() || undefined
  try {
    await streamLyrics(
      { idea, language: S.draft.language, style: keepStyle, instrumental: S.draft.instrumental },
      (e) => {
        if ('status' in e) S.writer.status = e.status
        else if ('delta' in e) S.writer.text += e.delta
        else if ('done' in e) {
          S.draft.title = e.title || S.draft.title
          S.draft.style = e.style || S.draft.style
          if (!S.draft.instrumental) S.draft.lyrics = e.lyrics
        } else if ('error' in e) toast(e.error)
      },
      writerAbort.signal,
    )
  } catch (e) {
    if (!writerAbort.signal.aborted) toast((e as Error).message)
  } finally {
    S.writer.active = false
    writerAbort = null
  }
}

export const cancelJob = (id: string) => guard(api.cancel(id))
export const freeWorker = () => guard(api.free())
export const updateSettings = async (patch: Partial<StudioSettings>) => {
  const s = await guard(api.settings(patch))
  if (s) S.settings = s
}

export const activeJobs = () => S.jobs.filter((j) => j.state === 'running' || j.state === 'queued').sort((a, b) => a.createdAt - b.createdAt)
export const runningJob = () => S.jobs.find((j) => j.state === 'running') ?? null
