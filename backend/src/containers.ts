// Optional: sharing the GPU with other local services (all off unless configured in config.env).
//   STOP_CONTAINERS  containers that hold VRAM, stopped before YuE2 loads
//   FREE_URLS        apps asked to unload their models before YuE2 loads
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { CONTAINER_CLI, FREE_URLS, STOP_CONTAINERS } from './config.ts'
import { log } from './hub.ts'

const exec = promisify(execFile)

/** names of running containers ([] without podman/docker) */
export async function runningContainers(): Promise<string[]> {
  try {
    const { stdout } = await exec(CONTAINER_CLI, ['ps', '--format', '{{.Names}}'], { timeout: 10_000 })
    return stdout.split('\n').filter(Boolean)
  } catch {
    return []
  }
}

async function containerCmd(args: string[]): Promise<string> {
  const { stdout, stderr } = await exec(CONTAINER_CLI, args, { timeout: 30_000 })
  return stdout + stderr
}

function compose(dir: string, args: string[]): Promise<void> {
  // Under systemd, run podman in its own transient scope: otherwise conmon lands in our service's cgroup
  // and a studio restart kills the container.
  const scoped = process.platform === 'linux' && !!process.env.INVOCATION_ID
  const cmd = scoped ? 'systemd-run' : CONTAINER_CLI
  const argv = [...(scoped ? ['--user', '--scope', '--quiet', '--collect', '--', CONTAINER_CLI] : []), 'compose', ...args]
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, argv, { cwd: dir, env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' } })
    let out = ''
    const onData = (b: Buffer) => (out += b.toString())
    p.stdout.on('data', onData)
    p.stderr.on('data', onData)
    p.on('error', reject)
    p.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${CONTAINER_CLI} compose ${args.join(' ')} failed (${code}): ${out.slice(-600)}`)),
    )
  })
}

/** configured VRAM-holding containers that are running right now */
export const othersRunning = (names: string[]) => STOP_CONTAINERS.filter((s) => names.includes(s.name)).map((s) => s.name)

export async function stopOtherContainers(names?: string[]): Promise<string[]> {
  if (STOP_CONTAINERS.length === 0) return []
  const running = names ?? (await runningContainers())
  const stopped: string[] = []
  for (const s of STOP_CONTAINERS) {
    if (!running.includes(s.name)) continue
    log(`[vram] stopping ${s.name} (needs the GPU)`, 'warn')
    if (s.composeDir) await compose(s.composeDir, ['down'])
    else await containerCmd(['stop', s.name])
    stopped.push(s.name)
  }
  return stopped
}

/** Ask the FREE_URLS apps to unload their models; wait while one answers 409 (busy). */
export async function freeOtherApps(signal: AbortSignal) {
  for (const url of FREE_URLS) {
    for (let waiting = false; ; waiting = true) {
      let r: Response
      try {
        r = await fetch(url, { method: 'POST', headers: { 'X-Studio': '1' }, signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) })
      } catch {
        break // not running (or cancelled: the caller checks its signal)
      }
      if (r.status !== 409) {
        const body = r.ok ? ((await r.json().catch(() => ({}))) as { unloaded?: boolean }) : {}
        if (body.unloaded) log(`[vram] ${new URL(url).host}: models unloaded`, 'dim')
        break
      }
      if (!waiting) log(`[vram] waiting for ${new URL(url).host} to finish (busy)…`, 'warn')
      await new Promise((res) => setTimeout(res, 3000))
      if (signal.aborted) throw new Error('cancelled')
    }
  }
}
