import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { cp, mkdir, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const standalone = path.join(root, '.next', 'standalone')
const serverFile = path.join(standalone, 'server.js')
const databaseFile = path.join(root, 'db', 'custom.db')
const port = Number(process.env.PORT || 3000)
const schedulerPort = Number(process.env.SCHEDULER_PORT || 3030)
const host = '127.0.0.1'
const env = {
  ...process.env,
  DATABASE_URL: `file:${databaseFile.replace(/\\/g, '/')}`,
  HOSTNAME: host,
  PORT: String(port),
  SCHEDULER_PORT: String(schedulerPort),
  NEXT_BASE_URL: `http://${host}:${port}`,
}

const buildInputs = [
  'src', 'public', 'prisma/schema.prisma', 'next.config.ts', 'package.json',
  'bun.lock', 'tsconfig.json', 'postcss.config.mjs', 'tailwind.config.ts',
  '.env', '.env.local', '.env.production',
]

async function latestChange(target) {
  if (!existsSync(target)) return 0
  const info = await stat(target)
  if (!info.isDirectory()) return info.mtimeMs
  const entries = await readdir(target, { withFileTypes: true })
  const times = await Promise.all(entries.map((entry) =>
    latestChange(path.join(target, entry.name))))
  return Math.max(0, ...times)
}

async function checkPort(portNumber) {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(portNumber, host, () => server.close(resolve))
  })
}

function runBuild() {
  console.log('Building MiniFoundry...')
  const nextBin = path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next')
  const result = spawnSync(process.execPath, [nextBin, 'build', '--webpack'], {
    cwd: root, env, stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Build failed (exit ${result.status}).`)
}

async function prepareBuild() {
  const builtAt = existsSync(serverFile) ? (await stat(serverFile)).mtimeMs : 0
  const changes = await Promise.all(buildInputs.map((input) =>
    latestChange(path.join(root, input))))
  if (process.argv.includes('--rebuild') || !builtAt || Math.max(...changes) > builtAt) {
    runBuild()
  } else {
    console.log('Using the existing production build.')
  }

  const staticFiles = path.join(root, '.next', 'static')
  if (!existsSync(serverFile) || !existsSync(staticFiles)) {
    throw new Error('The production build is incomplete.')
  }
  await mkdir(path.join(standalone, '.next'), { recursive: true })
  await cp(staticFiles, path.join(standalone, '.next', 'static'), { recursive: true, force: true })
  const publicFiles = path.join(root, 'public')
  if (existsSync(publicFiles)) {
    await cp(publicFiles, path.join(standalone, 'public'), { recursive: true, force: true })
  }
}

async function main() {
  if (!existsSync(databaseFile)) throw new Error(`Database not found: ${databaseFile}`)
  if (!Number.isInteger(port) || port < 1 || port > 65535 ||
      !Number.isInteger(schedulerPort) || schedulerPort < 1 || schedulerPort > 65535) {
    throw new Error('PORT and SCHEDULER_PORT must be valid port numbers.')
  }
  try {
    await checkPort(port)
    await checkPort(schedulerPort)
  } catch {
    throw new Error(`Port ${port} or ${schedulerPort} is in use. Stop the dev app or another local service first.`)
  }

  await prepareBuild()

  const children = []
  let stopping = false
  function stop(exitCode) {
    if (stopping) return
    stopping = true
    process.exitCode = exitCode
    for (const child of children) child.kill()
  }
  process.on('SIGINT', () => stop(0))
  process.on('SIGTERM', () => stop(0))

  console.log(`MiniFoundry: http://${host}:${port} (app, worker, scheduler)`)
  function startService(name, file) {
    const child = spawn('bun', [file], { cwd: root, env, stdio: 'inherit' })
    children.push(child)
    child.on('error', (error) => {
      console.error(`${name} failed to start: ${error.message}`)
      stop(1)
    })
    child.on('exit', (code) => {
      if (!stopping) {
        console.error(`${name} stopped unexpectedly (exit ${code}).`)
        stop(1)
      }
    })
  }

  startService('app', serverFile)
  startService('worker', path.join(root, 'scripts', 'job-worker.ts'))
  let ready = false
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && !stopping) {
    try {
      const response = await fetch(`http://${host}:${port}/api/health`, {
        signal: AbortSignal.timeout(1000),
      })
      if (response.ok) { ready = true; break }
    } catch { /* App is still starting. */ }
    await delay(500)
  }
  if (stopping) return
  if (!ready) {
    stop(1)
    throw new Error('The app did not become ready within 30 seconds.')
  }
  startService('scheduler', path.join(root, 'mini-services', 'scheduler-service', 'index.ts'))
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
