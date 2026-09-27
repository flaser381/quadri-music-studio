// Display helpers.
export const fmtSec = (s: number) => (s >= 90 ? `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s` : `${s.toFixed(s < 10 ? 1 : 0)}s`)

export function fmtAgo(t: number, now = Date.now()): string {
  const s = Math.max(0, (now - t) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`
  return new Date(t).toLocaleDateString()
}

/** style line → tag list */
export const styleTags = (style: string) =>
  style
    .split(/[,·/|]+/)
    .map((t) => t.trim())
    .filter(Boolean)

/** FNV-1a: stable per-song numbers for the generated cover art */
export function hash(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
