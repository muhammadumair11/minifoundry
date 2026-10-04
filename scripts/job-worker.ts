/// <reference types="bun-types" />
// Run separately from Next.js: bun run jobs:worker
import { randomUUID } from 'node:crypto'
import { processNextExecutionJob } from '@/lib/execution-jobs'

const workerId = `${process.pid}:${randomUUID()}`
const idleMs = 1_000
let stopping = false

process.on('SIGTERM', () => { stopping = true })
process.on('SIGINT', () => { stopping = true })

console.log(`[job-worker] started ${workerId}`)
while (!stopping) {
  try {
    const worked = await processNextExecutionJob(workerId)
    if (!worked) await Bun.sleep(idleMs)
  } catch (error) {
    console.error('[job-worker] poll failed:', error)
    await Bun.sleep(idleMs)
  }
}
console.log('[job-worker] stopped')
