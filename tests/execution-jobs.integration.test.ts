import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

test('jobs deduplicate events, allow one lease, recover an expired lease, and exhaust retries', async () => {
  const root = join(import.meta.dir, '..')
  const dbName = `test-jobs-${randomUUID()}.db`
  const dbFile = join(root, 'db', dbName)
  const priorUrl = process.env.DATABASE_URL
  const dbUrl = `file:../db/${dbName}`
  writeFileSync(dbFile, '')
  const init = spawnSync('node', [join(root, 'node_modules', 'prisma', 'build', 'index.js'), 'db', 'push', '--skip-generate'], {
    cwd: root, env: { ...process.env, DATABASE_URL: dbUrl }, encoding: 'utf8',
  })
  if (init.status !== 0) {
    unlinkSync(dbFile)
    throw new Error(`Could not create test database: ${init.stderr || init.stdout}`)
  }
  process.env.DATABASE_URL = dbUrl
  const { db } = await import('../src/lib/db')
  const { enqueuePipelineJob, claimExecutionJob, processExecutionJob } = await import('../src/lib/execution-jobs')
  try {
    const pipeline = await db.pipeline.create({
      data: { name: 'queue-test', graphJson: '{"nodes":[],"edges":[]}' },
    })
    const key = `upstream:${pipeline.id}:input:1`
    const first = await enqueuePipelineJob(pipeline.id, { trigger: 'upstream', eventKey: key, maxAttempts: 2 })
    const duplicate = await enqueuePipelineJob(pipeline.id, { trigger: 'upstream', eventKey: key, maxAttempts: 2 })
    expect(duplicate.id).toBe(first.id)
    expect(first.versionNumber).toBe(1)

    const claimed = await claimExecutionJob('worker-one')
    expect(claimed?.id).toBe(first.id)
    expect(await claimExecutionJob('worker-two')).toBeNull()
    // Simulate a killed worker and a restarted worker with a new identity.
    await db.executionJob.update({ where: { id: first.id }, data: { leaseUntil: new Date(0) } })
    const recovered = await claimExecutionJob('worker-two')
    expect(recovered?.attempt).toBe(2)
    expect(recovered?.leaseOwner).toBe('worker-two')
    await processExecutionJob(recovered!, 'worker-two')
    const final = await db.executionJob.findUniqueOrThrow({ where: { id: first.id } })
    expect(final.status).toBe('failed')
    expect(final.error).toBeTruthy()
    expect(final.lastRunId).toBeTruthy()
    expect(final.finishedAt).not.toBeNull()
  } finally {
    await db.$disconnect()
    if (priorUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = priorUrl
    if (existsSync(dbFile)) unlinkSync(dbFile)
  }
}, 30_000)
