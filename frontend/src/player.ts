// One <audio> element for the whole app: play/pause, seek, next/previous through the visible library.
import { reactive } from 'vue'
import type { Song } from '../../shared/types.ts'
import { fileUrl } from './api.ts'
import { S, visibleSongs } from './studio.ts'

const VOLUME = 'quadri.music.volume'
const audio = new Audio()
audio.preload = 'metadata'

function storedVolume(): number {
  try {
    const v = Number(localStorage.getItem(VOLUME))
    return v > 0 && v <= 1 ? v : 0.85
  } catch {
    return 0.85
  }
}

export const P = reactive({
  songId: null as string | null,
  playing: false,
  loading: false,
  time: 0,
  duration: 0,
  volume: storedVolume(),
})
audio.volume = P.volume

audio.addEventListener('timeupdate', () => (P.time = audio.currentTime))
audio.addEventListener('durationchange', () => (P.duration = Number.isFinite(audio.duration) ? audio.duration : 0))
audio.addEventListener('play', () => (P.playing = true))
audio.addEventListener('pause', () => (P.playing = false))
audio.addEventListener('waiting', () => (P.loading = true))
audio.addEventListener('playing', () => (P.loading = false))
audio.addEventListener('canplay', () => (P.loading = false))
audio.addEventListener('ended', () => next(true))

export const current = (): Song | null => S.songs.find((s) => s.id === P.songId) ?? null

export function play(s: Song, at = 0) {
  if (P.songId === s.id) {
    if (at) seek(at)
    if (audio.paused) void audio.play()
    return
  }
  P.songId = s.id
  P.time = 0
  P.duration = s.duration
  P.loading = true
  audio.src = fileUrl(s.file)
  if (at) audio.currentTime = at * s.duration
  audio.play().catch(() => (P.loading = false))
}

export function toggle(s?: Song | null) {
  const target = s ?? current() ?? visibleSongs()[0]
  if (!target) return
  if (P.songId !== target.id) return play(target)
  if (audio.paused) void audio.play()
  else audio.pause()
}

/** fraction 0..1 of the current song */
export function seek(frac: number) {
  if (!P.duration) return
  audio.currentTime = Math.max(0, Math.min(1, frac)) * P.duration
  P.time = audio.currentTime
}

export function skip(seconds: number) {
  if (P.duration) seek((audio.currentTime + seconds) / P.duration)
}

export function next(auto = false) {
  const list = visibleSongs()
  const i = list.findIndex((s) => s.id === P.songId)
  const n = list[i + 1]
  if (n) play(n)
  else if (auto) P.playing = false
}

export function prev() {
  if (audio.currentTime > 3) return seek(0)
  const list = visibleSongs()
  const i = list.findIndex((s) => s.id === P.songId)
  if (i > 0) play(list[i - 1])
}

export function setVolume(v: number) {
  P.volume = v
  audio.volume = v
  try {
    localStorage.setItem(VOLUME, String(v))
  } catch {
    /* private mode */
  }
}

/** a deleted song must not keep playing */
export function stopIf(id: string) {
  if (P.songId !== id) return
  audio.pause()
  audio.removeAttribute('src')
  audio.load()
  P.songId = null
  P.playing = false
}
