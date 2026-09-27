// Lyrics writer: title, style tags and lyrics from a song description, streamed from the LLM (see llm.ts).
import { SECTIONS } from '../../shared/music.ts'
import { log } from './hub.ts'
import { chat, ensureLlm, llmIdle, llmInfo } from './llm.ts'

const SYSTEM = (language: string, instrumental: boolean) => `You are a professional songwriter writing for an AI singer.
Answer in exactly this format and nothing else:

Title: <song title>
Style: <6-12 comma-separated English music tags: genre, mood, key instruments, vocal type such as "female vocal", tempo feel>
Lyrics:
[Intro]

[Verse]
<lines>

Rules for the lyrics:
- Section tags stand alone on their line, only these: ${SECTIONS.map((s) => `[${s}]`).join(' ')}. [Intro], [Interlude] and [Outro] may stay empty (instrumental).
- A typical song: [Intro] [Verse] [Pre-Chorus] [Chorus] [Verse] [Pre-Chorus] [Chorus] [Bridge] [Chorus] [Outro], about 2:30 to 4 minutes when sung.
- 4 short, singable lines per verse and chorus, steady meter, natural rhymes. Repeat the chorus words exactly each time.
- Leave one empty line between sections. No stage directions, parentheses, numbering, markdown or emojis.
- ${instrumental ? 'This is an instrumental: output only section tags with empty sections, no words.' : `Write the lyrics in ${language}.`}`

export interface LyricsInput {
  idea: string
  language: string
  /** keep this style instead of inventing one */
  style?: string
  instrumental?: boolean
}

export interface Written {
  title: string
  style: string
  lyrics: string
}

export async function writeLyrics(
  inp: LyricsInput,
  on: { status: (s: string) => void; delta: (t: string) => void },
  signal: AbortSignal,
): Promise<Written> {
  await ensureLlm(on.status, signal)
  try {
    return await write(inp, on, signal)
  } finally {
    llmIdle()
  }
}

async function write(inp: LyricsInput, on: { status: (s: string) => void; delta: (t: string) => void }, signal: AbortSignal): Promise<Written> {
  const { model } = await llmInfo()
  on.status(`writing with ${model ?? 'LLM'}…`)
  log(`[lyrics] ${model ?? 'LLM'} · "${inp.idea.slice(0, 80)}${inp.idea.length > 80 ? '…' : ''}"`, 'info')
  const t0 = Date.now()
  const user = [
    `Song idea: ${inp.idea.trim() || 'surprise me'}`,
    inp.style?.trim() ? `Use this style line unchanged: ${inp.style.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n')
  const r = await chat(
    {
      model,
      stream: true,
      messages: [
        { role: 'system', content: SYSTEM(inp.language || 'English', !!inp.instrumental) },
        { role: 'user', content: user },
      ],
      temperature: 0.9,
      top_p: 0.95,
      max_tokens: 6000,
      chat_template_kwargs: { enable_thinking: false },
    },
    signal,
  )
  if (!r.ok || !r.body) throw new Error(`lyrics writer: ${r.status} ${(await r.text()).slice(0, 300)}`)

  let content = ''
  let thinking = false
  const decoder = new TextDecoder()
  let buf = ''
  for await (const chunk of r.body) {
    buf += decoder.decode(chunk as Uint8Array, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') continue
      try {
        const delta = JSON.parse(data).choices?.[0]?.delta ?? {}
        if (delta.reasoning_content && !thinking) {
          thinking = true
          on.status('thinking…')
        }
        if (delta.content) {
          content += delta.content
          on.delta(delta.content)
        }
      } catch {
        /* keep-alive or partial */
      }
    }
  }
  const song = parseSong(content.replace(/<think>[\s\S]*?<\/think>/, ''))
  if (inp.style?.trim()) song.style = inp.style.trim()
  if (!song.lyrics) throw new Error(`lyrics writer returned no lyrics: ${content.slice(0, 200)}`)
  log(`[lyrics] "${song.title}" · ${song.style} · ${((Date.now() - t0) / 1000).toFixed(1)}s`, 'ok')
  return song
}

const TAG_ALIASES: [RegExp, string][] = [
  [/^pre[- ]?chorus/, 'Pre-Chorus'],
  [/^(chorus|hook|refrain)/, 'Chorus'],
  [/^verse/, 'Verse'],
  [/^bridge/, 'Bridge'],
  [/^intro/, 'Intro'],
  [/^(outro|ending|coda)/, 'Outro'],
  [/^(interlude|instrumental|solo|break)/, 'Interlude'],
]

/** "[verse 2]", "**Chorus:**" … → "[Verse]", "[Chorus]" (YuE2's native tags) */
function normalizeTag(line: string): string | null {
  const m = /^\**\s*[[(]?\s*([A-Za-z][A-Za-z -]*?)\s*\d*\s*[\])]?\s*:?\s*\**$/.exec(line.trim())
  if (!m || !/^\**\s*[[(]|:\**$/.test(line.trim())) return null
  const key = m[1].toLowerCase()
  for (const [re, tag] of TAG_ALIASES) if (re.test(key)) return `[${tag}]`
  return null
}

/** "Title: x", "**Title:** x", "**Title**: x" */
const field = (name: string) => new RegExp(`^[ \\t]*\\**[ \\t]*${name}[ \\t]*\\**[ \\t]*:[ \\t]*\\**(.*)$`, 'im')

export function parseSong(text: string): Written {
  const clean = text.replace(/```\w*/g, '').replace(/\r/g, '')
  const title = field('Title').exec(clean)?.[1] ?? ''
  const style = field('Style').exec(clean)?.[1] ?? ''
  const lyricsAt = field('Lyrics').exec(clean)
  let body = lyricsAt ? clean.slice(lyricsAt.index + lyricsAt[0].length) : clean.replace(new RegExp(field('(Title|Style)').source, 'gim'), '')
  const out: string[] = []
  for (const raw of body.split('\n')) {
    const tag = normalizeTag(raw)
    if (tag) {
      while (out.length && !out[out.length - 1]) out.pop()
      if (out.length) out.push('')
      out.push(tag)
      continue
    }
    const line = raw.replace(/\*\*/g, '').replace(/^\s*[-•]\s+/, '').trim()
    if (!line && (!out.length || !out[out.length - 1] || /^\[.*\]$/.test(out[out.length - 1]))) continue
    out.push(line)
  }
  while (out.length && !out[out.length - 1]) out.pop()
  body = out.join('\n')
  const strip = (s: string) =>
    s
      .replace(/\*\*/g, '')
      .trim()
      .replace(/^["“']|["”']$/g, '')
      .trim()
  return { title: strip(title).slice(0, 120), style: strip(style), lyrics: body }
}
