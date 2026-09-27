// Quadri Music Studio installer (Linux + Windows). Called by install.sh / install.bat, which provide Node.
// Everything goes into this folder: runtime/ (uv, Python + PyTorch, llama.cpp), models/, config.env.
// Safe to re-run: finished steps are skipped, downloads resume.
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { LLM_FILE, type ModelFile, VAE_FILES, YUE2_FILES, YUE2_WHEEL } from '../shared/models.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const RUNTIME = path.join(ROOT, 'runtime')
const WIN = process.platform === 'win32'

// ---------- pinned versions (tested together) ----------

const PYTHON_VERSION = '3.13'
const LLAMA_CPP = 'b11208'
type Gpu = 'amd' | 'nvidia'
interface Torch {
  index: string
  packages: string[]
  strategy?: string
}
// YuE2 pins torch 2.10.0
const TORCH: Record<Gpu, Torch> = {
  amd: WIN
    ? // AMD TheRock wheels, ROCm runtime included (experimental: not tested by the author)
      { index: 'https://repo.amd.com/rocm/whl-multi-arch/', packages: ['torch[device-all]==2.10.0+rocm7.14.0'], strategy: 'unsafe-best-match' }
    : // official PyTorch ROCm build, ROCm runtime included: no system ROCm needed
      { index: 'https://download.pytorch.org/whl/rocm7.1', packages: ['torch==2.10.0'] },
  // CUDA 12.8 needs driver ≥ 570 and covers RTX 20- to 50-series; older drivers: --torch-index …/whl/cu126
  nvidia: { index: 'https://download.pytorch.org/whl/cu128', packages: ['torch==2.10.0'] },
}

// ---------- arguments ----------

const STEPS = ['uv', 'python', 'models', 'lyrics', 'frontend'] as const
type Step = (typeof STEPS)[number]

const HELP = `Usage: ${WIN ? 'install.bat' : './install.sh'} [options]

  --gpu amd|nvidia     GPU vendor (default: detected)
  --no-lyrics-llm      skip the bundled lyrics writer (llama.cpp + a 5 GB model). Simple mode then
                       needs LLM_URL in config.env (Ollama, LM Studio, …); Custom mode works without it.
  --only <steps>       run only these steps, comma separated: ${STEPS.join(',')}
  --skip <steps>       skip these steps (e.g. --skip models to download later)
  --torch-index <url>  PyTorch wheel index (default: ROCm 7.1 / CUDA 12.8)
  -h, --help           this text

Settings (model folder, ports, an LLM server of your own, …) are in config.env, see config.env.example.`

const argv = process.argv.slice(2)
const opt = (name: string) => {
  const i = argv.indexOf(name)
  if (i < 0) return undefined
  const v = argv[i + 1]
  if (!v || v.startsWith('--')) fail(`${name} needs a value`)
  return v
}
if (argv.includes('-h') || argv.includes('--help')) {
  console.log(HELP)
  process.exit(0)
}
const known = ['--gpu', '--no-lyrics-llm', '--only', '--skip', '--torch-index']
for (const a of argv) if (a.startsWith('-') && !known.includes(a)) fail(`unknown option ${a}\n\n${HELP}`)

const steps = (v: string | undefined) => {
  const l = (v ?? '').split(',').filter(Boolean)
  for (const s of l) if (!STEPS.includes(s as Step)) fail(`unknown step "${s}" (steps: ${STEPS.join(', ')})`)
  return l as Step[]
}
const only = steps(opt('--only'))
const skip = steps(opt('--skip'))
const want = (s: Step) => (only.length ? only.includes(s) : !skip.includes(s))

// ---------- helpers ----------

function fail(msg: string): never {
  console.error(`\n✗ ${msg}`)
  process.exit(1)
}

const say = (msg: string) => console.log(`\n▸ ${msg}`)
const note = (msg: string) => console.log(`  ${msg}`)

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; quiet?: boolean } = {}) {
  const r = spawnSync(cmd, args, { cwd: opts.cwd ?? ROOT, env: opts.env ?? process.env, stdio: opts.quiet ? 'pipe' : 'inherit', encoding: 'utf8' })
  if (r.error) fail(`${cmd}: ${r.error.message}`)
  if (r.status !== 0) fail(`${path.basename(cmd)} ${args.join(' ')} failed (exit ${r.status})${opts.quiet ? `\n${r.stdout}${r.stderr}` : ''}`)
  return r.stdout ?? ''
}

function tryRun(cmd: string, args: string[]): string | null {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: 'pipe', timeout: 30_000 })
  return r.status === 0 ? r.stdout + r.stderr : null
}

const gb = (b: number) => `${(b / 1e9).toFixed(1)} GB`

/** Download with resume (.part file, HTTP Range) and a progress line. */
async function download(url: string, dest: string, size: number | null = null) {
  if (fs.existsSync(dest) && (size === null || fs.statSync(dest).size === size)) return
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const part = `${dest}.part`
  let have = fs.existsSync(part) ? fs.statSync(part).size : 0
  if (size !== null && have > size) have = 0
  const headers: Record<string, string> = { 'User-Agent': 'quadri-music-studio-installer' }
  if (have > 0) headers.Range = `bytes=${have}-`
  if (process.env.HF_TOKEN && url.startsWith('https://huggingface.co/')) headers.Authorization = `Bearer ${process.env.HF_TOKEN}`

  let r: Response | null = null
  for (let attempt = 1; ; attempt++) {
    try {
      r = await fetch(url, { headers })
      if (r.ok || r.status === 416) break
      if (r.status < 500) fail(`download failed: ${r.status} ${r.statusText}\n  ${url}`)
    } catch (e) {
      if (attempt >= 5) fail(`download failed: ${(e as Error).message}\n  ${url}`)
    }
    if (attempt >= 5) fail(`download failed: ${r?.status}\n  ${url}`)
    await new Promise((res) => setTimeout(res, 3000 * attempt))
  }
  if (r.status === 416) {
    // .part is already complete
  } else {
    if (r.status === 200) have = 0 // server ignored the Range header
    const total = size ?? (Number(r.headers.get('content-length')) || 0) + have
    const out = fs.createWriteStream(part, { flags: have > 0 ? 'a' : 'w' })
    out.on('error', (e) => fail(`writing ${part}: ${e.message}`))
    const name = path.basename(dest)
    let done = have
    const t0 = Date.now()
    let last = t0
    const tty = process.stdout.isTTY
    try {
      for await (const chunk of r.body!) {
        if (!out.write(chunk)) await new Promise((res) => out.once('drain', res))
        done += (chunk as Uint8Array).length
        const now = Date.now()
        if (now - last > (tty ? 500 : 15_000)) {
          last = now
          const rate = (done - have) / Math.max(1, (now - t0) / 1000)
          const eta = total && rate ? Math.round((total - done) / rate) : 0
          const line = `  ${name}  ${gb(done)}${total ? ` / ${gb(total)}` : ''}  ${(rate / 1e6).toFixed(1)} MB/s${eta ? `  ~${Math.floor(eta / 60)}m${String(eta % 60).padStart(2, '0')}s left` : ''}`
          process.stdout.write(tty ? `\r${line.padEnd(90)}` : `${line}\n`)
        }
      }
    } catch (e) {
      out.end()
      fail(`download interrupted (${(e as Error).message}): run the installer again to resume`)
    }
    await new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res())))
    if (tty) process.stdout.write(`\r${' '.repeat(90)}\r`)
  }
  const got = fs.statSync(part).size
  if (size !== null && got !== size) fail(`${path.basename(dest)}: got ${got} bytes, expected ${size}. Run the installer again to resume.`)
  fs.renameSync(part, dest)
  note(`✓ ${path.basename(dest)}${size && size > 1e7 ? ` (${gb(size)})` : ''}`)
}

async function sha256(file: string): Promise<string> {
  const h = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 8 * 2 ** 20 })) h.update(chunk as Buffer)
  return h.digest('hex')
}

/** Extract a .tar.gz / .zip into `dest`; a single top-level folder is stripped. */
function extract(archive: string, dest: string) {
  const tmp = `${dest}.tmp`
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(tmp, { recursive: true })
  // Windows 10+ ships bsdtar, which also reads zip (a GNU tar from Git Bash on PATH would not)
  const tar = WIN ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
  run(tar, ['-xf', archive, '-C', tmp])
  const entries = fs.readdirSync(tmp)
  const src = entries.length === 1 && fs.statSync(path.join(tmp, entries[0])).isDirectory() ? path.join(tmp, entries[0]) : tmp
  fs.rmSync(dest, { recursive: true, force: true })
  fs.renameSync(src, dest)
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.rmSync(archive, { force: true })
}

/** set KEY=value in config.env (replaces an existing, uncommented line) */
function setConfig(file: string, key: string, value: string) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  const i = lines.findIndex((l) => l.startsWith(`${key}=`))
  if (i >= 0) lines[i] = `${key}=${value}`
  else {
    while (lines.length && lines[lines.length - 1] === '') lines.pop()
    lines.push(`${key}=${value}`, '')
  }
  fs.writeFileSync(file, lines.join('\n'))
  process.env[key] = value
}

function detectGpu(): Gpu | null {
  if (tryRun('nvidia-smi', ['-L'])) return 'nvidia'
  if (process.platform === 'linux') {
    try {
      for (const card of fs.readdirSync('/sys/class/drm')) {
        if (!/^card\d+$/.test(card)) continue
        const dev = `/sys/class/drm/${card}/device`
        const vendor = fs.readFileSync(`${dev}/vendor`, 'utf8').trim()
        if (vendor === '0x10de') return 'nvidia'
        if (vendor === '0x1002' && Number(fs.readFileSync(`${dev}/mem_info_vram_total`, 'utf8')) > 4 * 2 ** 30) return 'amd'
      }
    } catch {
      /* no sysfs */
    }
  }
  if (WIN) {
    const names = tryRun('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_VideoController).Name']) ?? ''
    if (/nvidia/i.test(names)) return 'nvidia'
    if (/radeon.*\b(rx|pro)\b/i.test(names)) return 'amd' // not an APU's "Radeon(TM) Graphics"
  }
  return null
}

function freeSpace(dir: string): number {
  try {
    const st = fs.statfsSync(dir)
    return st.bavail * st.bsize
  } catch {
    return Infinity
  }
}

async function downloadAll(files: ModelFile[], base: string, what: string, notes: string[] = []) {
  const dest = (m: ModelFile) => path.join(base, m.file)
  const missing = files.filter((m) => !fs.existsSync(dest(m)) || fs.statSync(dest(m)).size !== m.size)
  if (!missing.length) return
  const partial = (m: ModelFile) => (fs.existsSync(`${dest(m)}.part`) ? fs.statSync(`${dest(m)}.part`).size : 0)
  const bytes = missing.reduce((s, m) => s + m.size - partial(m), 0)
  say(`${what}: ${gb(bytes)} to download`)
  for (const n of notes) note(n)
  fs.mkdirSync(base, { recursive: true })
  if (freeSpace(base) < bytes) fail(`not enough disk space in ${base}: ${gb(bytes)} needed, ${gb(freeSpace(base))} free`)
  for (const m of missing) {
    await download(m.url, dest(m), m.size)
    if (m.sha256) {
      process.stdout.write(`  verifying ${path.basename(m.file)}…`)
      const got = await sha256(dest(m))
      if (got !== m.sha256) {
        fs.rmSync(dest(m))
        fail(`${m.file} is corrupt (sha256 ${got}), deleted it. Run the installer again to download it anew.`)
      }
      console.log(' ok')
    }
  }
}

// ---------- start ----------

if (process.arch !== 'x64') fail(`only x86-64 is supported (this is ${process.arch})`)
if (!['linux', 'win32'].includes(process.platform)) fail(`only Linux and Windows are supported (this is ${process.platform})`)

fs.mkdirSync(RUNTIME, { recursive: true })
const CONFIG = path.join(ROOT, 'config.env')
if (!fs.existsSync(CONFIG)) fs.copyFileSync(path.join(ROOT, 'config.env.example'), CONFIG)
// read after config.env exists: model folders etc. can be changed there before installing
const cfg = await import('../backend/src/config.ts')

console.log('Quadri Music Studio installer')
console.log(`  folder: ${ROOT}`)

if (argv.includes('--no-lyrics-llm')) setConfig(CONFIG, 'LYRICS_LLM', '0')
const lyrics = process.env.LYRICS_LLM !== '0' && cfg.LLM.server !== null
if (cfg.LLM.server === null && want('lyrics')) note(`LLM_SERVER is empty: lyrics come from ${cfg.LLM.url} (not installed here)`)

let gpu = (opt('--gpu') ?? process.env.GPU) as Gpu | undefined
if (want('python')) {
  if (gpu && !(gpu in TORCH)) fail('--gpu must be amd or nvidia')
  gpu ??= detectGpu() ?? fail('no supported GPU found. Pass --gpu amd or --gpu nvidia if you are sure you have one.')
  if (process.env.GPU !== gpu) setConfig(CONFIG, 'GPU', gpu)
  note(`GPU: ${gpu}${gpu === 'amd' && WIN ? ' (Windows + AMD is experimental)' : ''}`)
}

const uvEnv = {
  ...process.env,
  UV_PYTHON_INSTALL_DIR: path.join(RUNTIME, 'python'),
  UV_CACHE_DIR: process.env.UV_CACHE_DIR || path.join(RUNTIME, 'uv-cache'),
  UV_NO_CONFIG: '1',
}
const uv = path.join(RUNTIME, 'uv', WIN ? 'uv.exe' : 'uv')

// ---------- 1) uv (Python installer) ----------

if (want('uv') && !fs.existsSync(uv)) {
  say('uv (installs Python and PyTorch)')
  const asset = WIN ? 'uv-x86_64-pc-windows-msvc.zip' : 'uv-x86_64-unknown-linux-gnu.tar.gz'
  const archive = path.join(RUNTIME, asset)
  await download(`https://github.com/astral-sh/uv/releases/latest/download/${asset}`, archive)
  extract(archive, path.join(RUNTIME, 'uv'))
}

// ---------- 2) Python + PyTorch + YuE2 ----------

if (want('python')) {
  if (!fs.existsSync(uv)) fail('uv is missing: run without --only/--skip first')
  const torch: Torch = opt('--torch-index') ? { ...TORCH[gpu!], index: opt('--torch-index')!, strategy: undefined } : TORCH[gpu!]
  const py = cfg.YUE2.python
  const marker = path.join(cfg.VENV_DIR, 'quadri-installed.json')
  const stamp = JSON.stringify({ gpu, torch, yue2: YUE2_WHEEL })
  if (!fs.existsSync(marker) || fs.readFileSync(marker, 'utf8') !== stamp || !fs.existsSync(py)) {
    say(`Python ${PYTHON_VERSION} + PyTorch 2.10 for ${gpu} + YuE2 (several GB, this takes a while)`)
    // --managed-python: our own Python in runtime/python, not whatever is on PATH
    if (!fs.existsSync(py)) run(uv, ['venv', '--managed-python', '--python', PYTHON_VERSION, cfg.VENV_DIR], { env: uvEnv })
    run(uv, ['pip', 'install', '--python', py, '--index', torch.index, ...(torch.strategy ? ['--index-strategy', torch.strategy] : []), ...torch.packages, YUE2_WHEEL], {
      env: uvEnv,
    })
    fs.writeFileSync(marker, stamp)
  }

  say('checking that PyTorch sees the GPU')
  // all devices, whatever an earlier GPU_DEVICE selected
  const probeEnv = { ...process.env }
  delete probeEnv.HIP_VISIBLE_DEVICES
  delete probeEnv.CUDA_VISIBLE_DEVICES
  const probe = run(
    py,
    [
      '-c',
      'import json,torch;n=torch.cuda.device_count() if torch.cuda.is_available() else 0;' +
        'print(json.dumps([[torch.cuda.get_device_name(i),torch.cuda.get_device_properties(i).total_memory] for i in range(n)]))',
    ],
    { quiet: true, env: probeEnv },
  )
  const devices = JSON.parse(probe.trim().split('\n').pop() ?? '[]') as [string, number][]
  if (devices.length === 0) {
    fail(
      gpu === 'amd'
        ? 'PyTorch found no AMD GPU. Linux: add yourself to the "render" and "video" groups (then log in again). Windows: update the AMD Adrenalin driver.'
        : 'PyTorch found no NVIDIA GPU. Update the NVIDIA driver (CUDA 12.8 needs ≥ 570), or reinstall with --torch-index https://download.pytorch.org/whl/cu126',
    )
  }
  for (const [i, [name, mem]] of devices.entries()) note(`cuda:${i}  ${name}  ${gb(mem)}`)
  const best = devices.reduce((b, d, i) => (d[1] > devices[b][1] ? i : b), 0)
  if (devices.length > 1 && !cfg.GPU_DEVICE) {
    // e.g. an APU's iGPU next to the graphics card: YuE2 should only see the big one
    setConfig(CONFIG, 'GPU_DEVICE', String(best))
    note(`several GPUs: YuE2 will use cuda:${best} (GPU_DEVICE in config.env)`)
  }
  // a tiny kernel: catches GPUs the torch build has no code for
  const dev = cfg.GPU_DEVICE || (devices.length > 1 ? String(best) : '')
  const kernelEnv = { ...probeEnv, ...(dev ? { [gpu === 'nvidia' ? 'CUDA_VISIBLE_DEVICES' : 'HIP_VISIBLE_DEVICES']: dev } : {}) }
  run(py, ['-c', 'import torch;x=torch.ones(64,64,device="cuda",dtype=torch.bfloat16);assert float((x@x).sum())==64**3'], { quiet: true, env: kernelEnv })
  const vram = devices[cfg.GPU_DEVICE ? Number(cfg.GPU_DEVICE) : best]?.[1] ?? 0
  if (vram < 15 * 2 ** 30) note(`⚠ ${gb(vram)} VRAM: YuE2 peaks at 11–14 GB; tested with 24 GB`)
}

// ---------- 3) YuE2 weights ----------

if (want('models')) {
  await downloadAll([...YUE2_FILES, ...VAE_FILES], cfg.MODELS_DIR, 'YuE2 models', [
    'YuE2-3B and YuE2-Vae are released under CC BY-NC 4.0 (non-commercial use),',
    'see https://huggingface.co/m-a-p/YuE2-3B. Interrupted? Run the installer again, it resumes.',
  ])
}

// ---------- 4) lyrics writer: llama.cpp + a small LLM ----------

if (lyrics && want('lyrics')) {
  const dir = path.dirname(cfg.LLM.server!)
  const stamp = path.join(dir, 'quadri-version.txt')
  const ours = dir === path.join(RUNTIME, 'llama.cpp')
  if (ours && (!fs.existsSync(stamp) || fs.readFileSync(stamp, 'utf8') !== LLAMA_CPP)) {
    say(`llama.cpp ${LLAMA_CPP} (Vulkan build, runs the lyrics writer)`)
    const asset = WIN ? `llama-${LLAMA_CPP}-bin-win-vulkan-x64.zip` : `llama-${LLAMA_CPP}-bin-ubuntu-vulkan-x64.tar.gz`
    const archive = path.join(RUNTIME, asset)
    await download(`https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP}/${asset}`, archive)
    extract(archive, dir)
    fs.writeFileSync(stamp, LLAMA_CPP)
  }
  if (!fs.existsSync(cfg.LLM.server!)) fail(`llama-server not found at ${cfg.LLM.server}`)
  if (tryRun(cfg.LLM.server!, ['--version']) === null) {
    note('⚠ llama-server does not start. Linux: install the Vulkan loader + GPU driver (e.g. libvulkan1 / vulkan-loader, mesa-vulkan-drivers).')
  }
  if (cfg.LLM.gguf === path.join(cfg.MODELS_DIR, LLM_FILE.file)) await downloadAll([LLM_FILE], cfg.MODELS_DIR, 'lyrics model (Gemma 4 E4B, Apache 2.0)')
  else if (!fs.existsSync(cfg.LLM.gguf)) fail(`LLM_GGUF points to ${cfg.LLM.gguf}, which does not exist`)
}

// ---------- 5) web UI ----------

if (want('frontend')) {
  const dist = path.join(ROOT, 'frontend', 'dist', 'index.html')
  const newest = (dir: string): number =>
    fs.readdirSync(dir, { withFileTypes: true }).reduce((t, e) => {
      const p = path.join(dir, e.name)
      return Math.max(t, e.isDirectory() ? newest(p) : fs.statSync(p).mtimeMs)
    }, 0)
  const sources = Math.max(newest(path.join(ROOT, 'frontend', 'src')), newest(path.join(ROOT, 'shared')), fs.statSync(path.join(ROOT, 'frontend', 'package-lock.json')).mtimeMs)
  if (!fs.existsSync(dist) || fs.statSync(dist).mtimeMs < sources) {
    say('building the web UI')
    // npm next to the running node (portable runtime/node or a system install), else from PATH
    const bin = path.dirname(process.execPath)
    const cli = [path.join(bin, 'node_modules/npm/bin/npm-cli.js'), path.join(bin, '../lib/node_modules/npm/bin/npm-cli.js')].find((p) => fs.existsSync(p))
    const cwd = path.join(ROOT, 'frontend')
    // npm scripts (vue-tsc, vite) run `node` from PATH: make that this node, not an older one installed system-wide
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
    const env = { ...process.env, [pathKey]: `${bin}${path.delimiter}${process.env[pathKey] ?? ''}` }
    // (npm.cmd can only be started through a shell)
    const npm = (args: string[]) =>
      cli ? run(process.execPath, [cli, ...args], { cwd, env }) : WIN ? run('cmd', ['/c', 'npm', ...args], { cwd, env }) : run('npm', args, { cwd, env })
    const installed = path.join(cwd, 'node_modules', '.package-lock.json')
    if (!fs.existsSync(installed) || fs.statSync(installed).mtimeMs < fs.statSync(path.join(cwd, 'package-lock.json')).mtimeMs) npm(['ci', '--no-audit', '--no-fund'])
    npm(['run', 'build'])
  }
}

// ---------- done ----------

if (only.length === 0 && skip.length === 0) fs.writeFileSync(path.join(RUNTIME, 'installed'), new Date().toISOString())
console.log(`\n✓ done. Start the studio with ${WIN ? 'start.bat' : './start.sh'} (opens http://localhost:${cfg.PORT}).`)
if (!(lyrics && want('lyrics')) && cfg.LLM.server !== null && !fs.existsSync(cfg.LLM.gguf))
  console.log(`  No lyrics model installed: Simple mode needs an OpenAI-compatible LLM at LLM_URL (${cfg.LLM.url}), see config.env.`)
