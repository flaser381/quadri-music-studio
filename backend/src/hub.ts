// SSE fan-out + terminal log ring buffers ("Output" = studio, "Worker log" = YuE2 process).
import type http from 'node:http'
import type { LogLine, ServerEvent } from '../../shared/types.ts'

const clients = new Set<http.ServerResponse>()
const MAX_LINES = 1500
const logs: LogLine[] = []

export function addClient(res: http.ServerResponse) {
  clients.add(res)
  res.on('close', () => clients.delete(res))
}

export function emit(ev: ServerEvent) {
  const msg = `data: ${JSON.stringify(ev)}\n\n`
  for (const c of clients) c.write(msg)
}

export function log(text: string, level: LogLine['level'] = 'info', channel: LogLine['channel'] = 'output') {
  for (const part of text.split('\n')) {
    const line: LogLine = { t: Date.now(), channel, text: part, level }
    logs.push(line)
    emit({ type: 'log', line })
  }
  if (logs.length > MAX_LINES * 2) logs.splice(0, logs.length - MAX_LINES * 2)
  if (channel === 'output' && level !== 'dim') console.log(`[${level}] ${text}`)
}

/** Streamed text (lyrics writer): buffer until newline so the terminal isn't one token per line. */
export function logStream(level: LogLine['level'] = 'dim') {
  let buf = ''
  return {
    write(chunk: string) {
      buf += chunk
      const i = buf.lastIndexOf('\n')
      if (i >= 0) {
        log(buf.slice(0, i), level)
        buf = buf.slice(i + 1)
      } else if (buf.length > 160) {
        const cut = buf.lastIndexOf(' ') > 80 ? buf.lastIndexOf(' ') : buf.length
        log(buf.slice(0, cut), level)
        buf = buf.slice(cut).trimStart()
      }
    },
    end() {
      if (buf.trim()) log(buf, level)
      buf = ''
    },
  }
}

export const recentLogs = () => [
  ...logs.filter((l) => l.channel === 'output').slice(-MAX_LINES),
  ...logs.filter((l) => l.channel === 'worker').slice(-MAX_LINES),
]

export function clearLogs(channel: LogLine['channel']) {
  for (let i = logs.length - 1; i >= 0; i--) if (logs[i].channel === channel) logs.splice(i, 1)
}
