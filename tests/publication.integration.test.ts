import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

test('a draft stays hidden until its exact approval and quality evaluation succeed', async () => {
  const root = join(import.meta.dir, '..')
  const dbName = `test-publication-${randomUUID()}.db`
  const dbFile = join(root, 'db', dbName)
  const priorUrl = process.env.DATABASE_URL
  const dbUrl = `file:../db/${dbName}`
  // Prisma's Windows schema engine expects the SQLite file to exist first.
  writeFileSync(dbFile, '')
  const init = spawnSync('node', [join(root, 'node_modules', 'prisma', 'build', 'index.js'), 'db', 'push', '--skip-generate'], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: dbUrl },
    encoding: 'utf8',
  })
  if (init.status !== 0) {
    unlinkSync(dbFile)
    throw new Error(`Could not create test database: ${init.stderr || init.stdout}`)
  }
  process.env.DATABASE_URL = dbUrl
  const { db } = await import('../src/lib/db')
  const { resolveConsumerVersion } = await import('../src/lib/dataset-service')
  const { MAX_ROWS, createDatasetFromRows, normalizeValue } = await import('../src/lib/dataset-service')
  const { publishDatasetVersion, PublicationError } = await import('../src/lib/publication')
  const { createBranch, commitBranchVersion, mergeBranch } = await import('../src/lib/branching')
  try {
    expect(normalizeValue('00123')).toBe('00123')
    expect(normalizeValue('9007199254740993')).toBe('9007199254740993')
    await expect(createDatasetFromRows({
      name: 'oversized-must-not-write',
      rows: Array.from({ length: MAX_ROWS + 1 }, (_, i) => ({ i })),
    })).rejects.toThrow('No rows were written')
    const dataset = await db.dataset.create({
      data: { name: `publication-test-${randomUUID()}`, tags: '[]', qualityGate: true, publishedVersion: 1 },
    })
    for (const [versionNumber, lifecycle, qualityState] of [
      [1, 'published', 'passed'],
      [2, 'draft', 'not_evaluated'],
    ] as const) {
      await db.datasetVersion.create({
        data: {
          datasetId: dataset.id, versionNumber, branch: 'main',
          lifecycle, qualityState, schemaJson: '[]', dataJson: '[]', rowCount: 0,
        },
      })
    }
    const approval = await db.approvalRequest.create({
      data: {
        kind: 'publish_dataset', targetId: dataset.id, targetName: dataset.name,
        requestedBy: 'editor', versionNumber: 2,
      },
    })
    expect((await resolveConsumerVersion(dataset.id))?.versionNumber).toBe(1)
    await expect(publishDatasetVersion(dataset.id, 2, approval.id, 'admin')).rejects.toBeInstanceOf(PublicationError)
    expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: approval.id } })).status).toBe('pending')
    await db.datasetVersion.update({
      where: { datasetId_versionNumber: { datasetId: dataset.id, versionNumber: 2 } },
      data: { qualityState: 'passed', qualitySummaryJson: '{"passed":1,"failed":0}' },
    })
    await publishDatasetVersion(dataset.id, 2, approval.id, 'admin')
    expect((await resolveConsumerVersion(dataset.id))?.versionNumber).toBe(2)
    expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: approval.id } })).status).toBe('approved')
    const branch = await createBranch(dataset.id, { name: 'experiment' }, 'admin')
    const commit = await commitBranchVersion(dataset.id, branch.id, [{ sample: 'isolated' }], 2, 'admin')
    expect(commit.versionNumber).toBe(3)
    expect((await resolveConsumerVersion(dataset.id))?.versionNumber).toBe(2)
    const merge = await mergeBranch(dataset.id, branch.id)
    expect(merge.mergedVersion).toBe(4)
    expect((await resolveConsumerVersion(dataset.id))?.versionNumber).toBe(2)
  } finally {
    await db.$disconnect()
    if (priorUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = priorUrl
    if (existsSync(dbFile)) unlinkSync(dbFile)
  }
}, 30_000)
