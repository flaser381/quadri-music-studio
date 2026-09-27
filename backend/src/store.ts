// JSON-file persistence: data/songs/<id>/{song.json, audio.flac, score.abc, YuE2 artifacts}, data/{settings,draft}.json
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_DRAFT } from '../../shared/music.ts'
import type { Draft, Song, StudioSettings } from '../../shared/types.ts'
import { DATA_DIR } from './config.ts'

const SONGS = path.join(DATA_DIR, 'songs')
fs.mkdirSync(SONGS, { recursive: true })

/** Time-sortable id (ULID-like, Crockford base32, no deps). */
export function newId(): string {
  const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let t = Date.now()
  let time = ''
  for (let i = 0; i < 10; i++) {
    time = A[t % 32] + time
    t = Math.floor(t / 32)
  }
  const rnd = crypto.randomBytes(16)
  let r = ''
  for (let i = 0; i < 16; i++) r += A[rnd[i] % 32]
  return time + r
}

export function songDir(id: string): string {
  if (!/^[0-9A-Z]{26}$/.test(id)) throw new Error('bad song id')
  return path.join(SONGS, id)
}

function writeJson(file: string, data: unknown) {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1))
  fs.renameSync(tmp, file)
}

const songs = new Map<string, Song>()
for (const id of fs.readdirSync(SONGS)) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(SONGS, id, 'song.json'), 'utf8')) as Song
    songs.set(s.id, s)
  } catch {
    /* unfinished or foreign dir */
  }
}

/** newest first */
export const listSongs = (): Song[] => [...songs.values()].sort((a, b) => b.createdAt - a.createdAt)

export function getSong(id: string): Song {
  const s = songs.get(id)
  if (!s) throw new Error('song not found')
  return s
}

export function saveSong(s: Song) {
  songs.set(s.id, s)
  writeJson(path.join(songDir(s.id), 'song.json'), s)
}

export function updateSong(id: string, patch: { title?: string; starred?: boolean }): Song {
  const s = getSong(id)
  if (patch.title?.trim()) s.title = patch.title.trim().slice(0, 120)
  if (patch.starred !== undefined) s.starred = patch.starred
  saveSong(s)
  return s
}

export function deleteSong(id: string) {
  getSong(id)
  songs.delete(id)
  fs.rmSync(songDir(id), { recursive: true, force: true })
}

/** Remove folders of songs that never finished (crash / cancel mid-save). */
export function sweepUnfinished(keep: Set<string>) {
  for (const id of fs.readdirSync(SONGS)) {
    if (!songs.has(id) && !keep.has(id)) fs.rmSync(path.join(SONGS, id), { recursive: true, force: true })
  }
}

// ---------- settings + draft ----------

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json')
const DRAFT_FILE = path.join(DATA_DIR, 'draft.json')
const DEFAULT_SETTINGS: StudioSettings = { autoStopOthers: true, keepLoadedMin: 5, backend: 'torch' }

function readJson<T>(file: string, fallback: T): T {
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(file, 'utf8')) }
  } catch {
    return { ...fallback }
  }
}

/** known keys only (older versions stored others) */
function cleanSettings(s: StudioSettings): StudioSettings {
  return {
    autoStopOthers: s.autoStopOthers !== false,
    keepLoadedMin: Math.max(0, Math.min(120, Number(s.keepLoadedMin) || 0)),
    backend: s.backend === 'torch-eager' ? 'torch-eager' : 'torch',
  }
}

export const getSettings = (): StudioSettings => cleanSettings(readJson(SETTINGS_FILE, DEFAULT_SETTINGS))

export function setSettings(patch: Partial<StudioSettings>): StudioSettings {
  const next = cleanSettings({ ...getSettings(), ...patch })
  writeJson(SETTINGS_FILE, next)
  return next
}

export const getDraft = (): Draft => readJson(DRAFT_FILE, DEFAULT_DRAFT)

export function setDraft(d: Partial<Draft>): Draft {
  const next = { ...getDraft(), ...d }
  writeJson(DRAFT_FILE, next)
  return next
}
