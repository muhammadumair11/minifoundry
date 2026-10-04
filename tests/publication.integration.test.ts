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
          lifecycle, qualityState,
          schemaJson: '[{"name":"id","type":"number"},{"name":"secret","type":"string"}]',
          dataJson: JSON.stringify([{ id: versionNumber, secret: versionNumber === 1 ? 'published-secret' : 'draft-secret' }]),
          rowCount: 1,
        },
      })
    }
    const approval = await db.approvalRequest.create({
      data: {
        kind: 'publish_dataset', targetId: dataset.id, targetName: dataset.name,
        requestedBy: 'editor', versionNumber: 2,
      },
    })
    const marking = await db.marking.create({ data: { name: `secret-${randomUUID()}`, minRole: 'admin' } })
    await db.columnMarking.create({ data: { datasetId: dataset.id, columnName: 'secret', markingId: marking.id } })
    const { NextRequest } = await import('next/server')
    const rowsRoute = await import('../src/app/api/datasets/[id]/rows/route')
    const exportRoute = await import('../src/app/api/datasets/[id]/export/route')
    const viewer = (suffix = '') => new NextRequest(`http://localhost/api/datasets/${dataset.id}/rows${suffix}`, {
      headers: { cookie: 'foundry-role=viewer' },
    })
    const viewerRows = await rowsRoute.GET(viewer(), { params: Promise.resolve({ id: dataset.id }) })
    expect(viewerRows.status).toBe(200)
    const viewerText = await viewerRows.text()
    expect(viewerText).toContain('"id":1')
    expect(viewerText).not.toContain('draft-secret')
    expect(viewerText).not.toContain('published-secret')
    expect((await rowsRoute.GET(viewer('?version=2'), { params: Promise.resolve({ id: dataset.id }) })).status).toBe(403)
    const viewerExport = await exportRoute.GET(viewer(), { params: Promise.resolve({ id: dataset.id }) })
    expect(viewerExport.status).toBe(200)
    const csv = await viewerExport.text()
    expect(csv).not.toContain('published-secret')
    expect(csv).not.toContain('draft-secret')
    expect((await exportRoute.GET(viewer('?version=2'), { params: Promise.resolve({ id: dataset.id }) })).status).toBe(403)
    const editorDraft = await rowsRoute.GET(new NextRequest(`http://localhost/api/datasets/${dataset.id}/rows?version=2`, {
      headers: { cookie: 'foundry-role=editor' },
    }), { params: Promise.resolve({ id: dataset.id }) })
    expect(editorDraft.status).toBe(200)
    const editorText = await editorDraft.text()
    expect(editorText).toContain('"id":2')
    expect(editorText).not.toContain('draft-secret')
    const objectType = await db.objectType.create({ data: {
      apiName: `secret-${randomUUID().slice(0, 8)}`,
      displayName: 'Secret object', sourceDatasetId: dataset.id, primaryKey: 'id',
    } })
    await db.property.create({ data: {
      objectTypeId: objectType.id, apiName: 'secret', displayName: 'Secret', isTitle: true,
    } })
    const searchRoute = await import('../src/app/api/search/route')
    const search = async (term: string, role: string) => {
      const response = await searchRoute.GET(new NextRequest(`http://localhost/api/search?q=${term}`, {
        headers: { cookie: `foundry-role=${role}` },
      }))
      return await response.text()
    }
    expect(await search('published-secret', 'viewer')).not.toContain('published-secret')
    expect(await search('published-secret', 'admin')).toContain('published-secret')
    expect(await search('draft-secret', 'admin')).not.toContain('draft-secret')
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
