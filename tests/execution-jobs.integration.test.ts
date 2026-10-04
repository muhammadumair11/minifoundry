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
  const { runPipeline } = await import('../src/lib/engine')
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

    const activeRun = await db.pipelineRun.create({ data: { pipelineId: pipeline.id, status: 'running' } })
    const busyJob = await enqueuePipelineJob(pipeline.id, {
      trigger: 'manual', eventKey: 'busy-manual-job', maxAttempts: 1,
    })
    const busyLease = await claimExecutionJob('busy-worker')
    expect(busyLease?.id).toBe(busyJob.id)
    await processExecutionJob(busyLease!, 'busy-worker')
    const deferred = await db.executionJob.findUniqueOrThrow({ where: { id: busyJob.id } })
    expect(deferred.status).toBe('queued')
    expect(deferred.attempt).toBe(0)
    await db.pipelineRun.update({ where: { id: activeRun.id }, data: { status: 'failed', finishedAt: new Date() } })

    const input = await db.dataset.create({ data: { name: 'queue-input', publishedVersion: 1 } })
    await db.datasetVersion.create({ data: {
      datasetId: input.id, versionNumber: 1, schemaJson: '[{"name":"id","type":"number"}]',
      dataJson: '[{"id":1}]', rowCount: 1,
    } })
    const graph = JSON.stringify({
      nodes: [
        { id: 'source', type: 'source', data: { datasetId: input.id } },
        { id: 'output', type: 'output', data: { name: 'queue-output' } },
      ],
      edges: [{ id: 'source-output', source: 'source', target: 'output' }],
    })
    const outputPipeline = await db.pipeline.create({ data: { name: 'queue-output-test', graphJson: graph } })
    const outputJob = await enqueuePipelineJob(outputPipeline.id, {
      trigger: 'upstream', eventKey: 'queue-output-event', maxAttempts: 1,
    })
    const firstLease = await claimExecutionJob('worker-three')
    expect(firstLease?.id).toBe(outputJob.id)
    const firstRun = await runPipeline(outputPipeline.id, {
      graphOverride: graph, versionNumber: outputJob.versionNumber, outputJobId: outputJob.id,
    })
    expect(firstRun.status).toBe('success')
    // The run committed its output, but the worker died before acknowledging the job.
    await db.executionJob.update({ where: { id: outputJob.id }, data: { leaseUntil: new Date(0) } })
    const secondLease = await claimExecutionJob('worker-four')
    expect(secondLease?.id).toBe(outputJob.id)
    await processExecutionJob(secondLease!, 'worker-four')
    expect((await db.executionJob.findUniqueOrThrow({ where: { id: outputJob.id } })).status).toBe('succeeded')
    expect(await db.datasetVersion.count({ where: { outputJobId: outputJob.id } })).toBe(1)

    const { NextRequest } = await import('next/server')
    const { POST } = await import('../src/app/api/pipelines/[id]/run/route')
    const response = await POST(
      new NextRequest(`http://localhost/api/pipelines/${outputPipeline.id}/run`, { method: 'POST' }),
      { params: Promise.resolve({ id: outputPipeline.id }) },
    )
    expect(response.status).toBe(202)
    const submitted = await response.json() as { job: { id: string; status: string } }
    expect(submitted.job.status).toBe('queued')
    expect(await db.executionJob.count({ where: { id: submitted.job.id } })).toBe(1)
  } finally {
    await db.$disconnect()
    if (priorUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = priorUrl
    if (existsSync(dbFile)) unlinkSync(dbFile)
  }
}, 30_000)
