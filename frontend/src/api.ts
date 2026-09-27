import type { AppState, Draft, Job, LyricsEvent, Song, StudioSettings } from '../../shared/types.ts'

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'

async function req<T>(method: Method, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = method === 'GET' ? {} : { 'X-Studio': '1' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const r = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data.error ?? `${r.status} ${r.statusText}`)
  return data as T
}

export const api = {
  state: () => req<AppState>('GET', '/api/state'),
  patchSong: (id: string, patch: { title?: string; starred?: boolean }) => req<Song>('PATCH', `/api/songs/${id}`, patch),
  deleteSong: (id: string) => req('DELETE', `/api/songs/${id}`),
  create: (draft: Draft) => req<Job[]>('POST', '/api/jobs', draft),
  cancel: (jobId: string) => req('DELETE', `/api/jobs/${jobId}`),
  score: (jobId: string) => req<{ text: string }>('GET', `/api/jobs/${jobId}/score`),
  draft: (patch: Partial<Draft>) => req<Draft>('PATCH', '/api/draft', patch),
  settings: (patch: Partial<StudioSettings>) => req<StudioSettings>('PATCH', '/api/settings', patch),
  free: () => req('POST', '/api/free'),
  clearLogs: (channel: 'output' | 'worker') => req('DELETE', `/api/logs/${channel}`),
}

/** POST /api/lyrics and hand every NDJSON line to `on` until the writer is done. */
export async function streamLyrics(
  body: { idea: string; language: string; style?: string; instrumental?: boolean },
  on: (e: LyricsEvent) => void,
  signal: AbortSignal,
) {
  const r = await fetch('/api/lyrics', {
    method: 'POST',
    headers: { 'X-Studio': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!r.ok || !r.body) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `${r.status} ${r.statusText}`)
  const reader = r.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line) on(JSON.parse(line) as LyricsEvent)
    }
  }
}

export const fileUrl = (rel: string) => `/files/${rel}`
export const downloadUrl = (id: string, fmt: 'flac' | 'mp3' | 'wav' | 'abc') => `/api/songs/${id}/download?fmt=${fmt}`
