// Song helpers shared by backend and frontend: defaults, lyric sections, style tags, ABC handling.
import type { Cot, Draft } from './types.ts'

/** YuE2 codec frames: 48 kHz / 1920 hop = 25 semantic tokens per second of audio */
export const TOKENS_PER_SECOND = 25
/** semantic generation budget (yue2_generation_config.json) → max ~6 min of audio */
export const MAX_SEMANTIC_TOKENS = 9000
export const RENDER_STEPS = 32

export const DEFAULT_DRAFT: Draft = {
  mode: 'custom',
  description: '',
  language: 'English',
  instrumental: false,
  title: '',
  lyrics: '',
  style: '',
  cot: 'full',
  abc: '',
  abcFrom: null,
  cfgScale: null,
  seed: 831001,
  randomSeed: true,
  takes: 1,
}

export const COT_LABEL: Record<Cot, string> = {
  full: 'Melody + chords',
  melody: 'Melody only',
  off: 'No plan',
}
export const COT_SHORT: Record<Cot, string> = { full: 'FULL', melody: 'MEL', off: 'OFF' }

/** section tags YuE2 was trained on (see examples/tonight-awake.json) */
export const SECTIONS = ['Intro', 'Verse', 'Pre-Chorus', 'Chorus', 'Bridge', 'Interlude', 'Outro']

export const LANGUAGES = ['English', 'Mandarin', 'German', 'Spanish', 'French', 'Japanese', 'Korean']

export const STYLE_TAGS: { group: string; tags: string[] }[] = [
  {
    group: 'Genre',
    tags: ['pop', 'rock', 'city pop', 'synthwave', 'hip hop', 'r&b', 'jazz', 'funk', 'nu-disco', 'edm', 'metal', 'folk', 'country', 'ballad', 'lo-fi', 'indie'],
  },
  { group: 'Mood', tags: ['upbeat', 'melancholic', 'dreamy', 'energetic', 'romantic', 'dark', 'joyful', 'epic', 'chill', 'nostalgic'] },
  {
    group: 'Sound',
    tags: ['electric guitar', 'acoustic guitar', 'piano', 'rhodes piano', 'synth', 'groovy bass', 'strings', 'saxophone', 'tight drums', '808', 'brass'],
  },
  { group: 'Voice', tags: ['female vocal', 'male vocal', 'warm lead vocal', 'airy vocal', 'raspy vocal', 'choir', 'duet'] },
]

/** Instrumental: YuE2 always needs lyrics, so send the song structure with empty sections. */
export const INSTRUMENTAL_LYRICS = '[Intro]\n\n[Verse]\n\n[Chorus]\n\n[Interlude]\n\n[Verse]\n\n[Chorus]\n\n[Bridge]\n\n[Chorus]\n\n[Outro]'

export function effectiveLyrics(d: Pick<Draft, 'lyrics' | 'instrumental'>): string {
  return d.instrumental ? INSTRUMENTAL_LYRICS : d.lyrics.trim()
}

/** "[Verse]" lines → sections for display */
export function splitSections(lyrics: string): { tag: string | null; lines: string[] }[] {
  const out: { tag: string | null; lines: string[] }[] = []
  for (const raw of lyrics.split('\n')) {
    const line = raw.trim()
    const m = /^\[([^\]]+)\]$/.exec(line)
    if (m) out.push({ tag: m[1], lines: [] })
    else {
      if (!out.length) out.push({ tag: null, lines: [] })
      out[out.length - 1].lines.push(line)
    }
  }
  for (const s of out) while (s.lines.length && !s.lines[s.lines.length - 1]) s.lines.pop()
  return out.filter((s) => s.tag || s.lines.some(Boolean))
}

/**
 * Covers use melody-only planning and the model card says the ABC must come *without* chord symbols
 * (cot="melody" does not strip them). Chord symbols are the "quoted" strings in music lines.
 */
export function stripChords(abc: string): string {
  return abc
    .split('\n')
    .map((l) => (/^[A-Za-z]:/.test(l) || l.startsWith('%') ? l : l.replace(/"[^"\n]*"/g, '')))
    .join('\n')
}

export const hasChords = (abc: string) => abc.split('\n').some((l) => !/^[A-Za-z]:/.test(l) && /"[^"\n]*"/.test(l))

export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Title from the first lyric line when none is given. */
export function guessTitle(lyrics: string, style: string): string {
  const line = lyrics
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !/^\[.*\]$/.test(l))
  const base = line ?? style.split(',')[0] ?? 'Untitled'
  const t = base.replace(/[.,!?;:"“”]+$/g, '').trim()
  return (t.length > 48 ? `${t.slice(0, 45).trimEnd()}…` : t) || 'Untitled'
}
