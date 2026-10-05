import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { PipelineGraph } from '../src/lib/foundry-types'
import { inferPipelineSchemas } from '../src/lib/pipeline-schema'

test('column inference follows join handles and flags missing references', () => {
  const graph: PipelineGraph = {
    nodes: [
      { id: 'left', type: 'source', data: { datasetId: 'a' }, position: { x: 0, y: 0 } },
      { id: 'right', type: 'source', data: { datasetId: 'b' }, position: { x: 0, y: 0 } },
      { id: 'join', type: 'join', data: { leftKey: 'id', rightKey: 'id' }, position: { x: 0, y: 0 } },
      { id: 'select', type: 'select', data: { columns: ['id', 'right_id', 'missing'] }, position: { x: 0, y: 0 } },
    ],
    edges: [
      { id: 'right-edge', source: 'right', target: 'join', targetHandle: 'in-1' },
      { id: 'left-edge', source: 'left', target: 'join', targetHandle: 'in' },
      { id: 'result-edge', source: 'join', target: 'select' },
    ],
  }
  const sourceSchemas = new Map([
    ['a', [{ name: 'id', type: 'number' as const }, { name: 'name', type: 'string' as const }]],
    ['b', [{ name: 'id', type: 'number' as const }, { name: 'quantity', type: 'number' as const }]],
  ])
  const inferred = inferPipelineSchemas(graph, sourceSchemas)
  expect(inferred.get('join')?.inputs[0]?.map((column) => column.name)).toEqual(['id', 'name'])
  expect(inferred.get('join')?.inputs[1]?.map((column) => column.name)).toEqual(['id', 'quantity'])
  expect(inferred.get('join')?.output?.map((column) => column.name)).toEqual(['id', 'name', 'right_id', 'quantity'])
  expect(inferred.get('select')?.missing).toEqual(['missing'])
  graph.nodes[2].data.rightKey = 'product_id'
  expect(inferPipelineSchemas(graph, sourceSchemas).get('join')?.missing).toEqual(['Input 2: product_id'])
})

test('run output cleanup protects consumers and removes only the selected latest output', async () => {
  const root = join(import.meta.dir, '..')
  const dbName = `test-pipeline-ux-${randomUUID()}.db`
  const dbFile = join(root, 'db', dbName)
  const priorUrl = process.env.DATABASE_URL
  writeFileSync(dbFile, '')
  const init = spawnSync('node', [join(root, 'node_modules', 'prisma', 'build', 'index.js'), 'db', 'push', '--skip-generate'], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: `file:../db/${dbName}` },
    encoding: 'utf8',
  })
  if (init.status !== 0) {
    unlinkSync(dbFile)
    throw new Error(`Could not create test database: ${init.stderr || init.stdout}`)
  }
  process.env.DATABASE_URL = `file:../db/${dbName}`
  const { reloadDbClientForTests } = await import('../src/lib/db')
  const db = await reloadDbClientForTests()
  const { NextRequest } = await import('next/server')
  const route = await import('../src/app/api/pipelines/[id]/runs/[runId]/output/route')
  const request = (pipelineId: string, runId: string, method = 'GET', role = 'editor') =>
    new NextRequest(`http://localhost/api/pipelines/${pipelineId}/runs/${runId}/output`, {
      method, headers: { cookie: `foundry-role=${role}` },
    })
  try {
    const pipeline = await db.pipeline.create({ data: { name: 'cleanup test' } })
    const dataset = await db.dataset.create({ data: { name: 'cleanup output', publishedVersion: 2 } })
    const run = await db.pipelineRun.create({ data: {
      pipelineId: pipeline.id, status: 'success', outputDatasetId: dataset.id, outputVersionNumber: 2,
    } })
    await db.datasetVersion.createMany({ data: [
      { datasetId: dataset.id, versionNumber: 1, schemaJson: '[]', rowCount: 0, createdBy: 'seed' },
      { datasetId: dataset.id, versionNumber: 2, schemaJson: '[{"name":"id","type":"number"}]', rowCount: 1, createdBy: run.id },
    ] })
    await db.datasetVersionRow.create({ data: { datasetId: dataset.id, versionNumber: 2, rowIndex: 0, rowData: '{"id":2}' } })
    const params = { params: Promise.resolve({ id: pipeline.id, runId: run.id }) }
    expect((await route.DELETE(request(pipeline.id, run.id, 'DELETE', 'viewer'), params)).status).toBe(403)
    const allowed = await route.GET(request(pipeline.id, run.id), params)
    expect((await allowed.json()).mode).toBe('version')
    expect((await route.DELETE(request(pipeline.id, run.id, 'DELETE'), params)).status).toBe(200)
    expect(await db.datasetVersion.count({ where: { datasetId: dataset.id } })).toBe(1)
    expect(await db.datasetVersionRow.count({ where: { datasetId: dataset.id, versionNumber: 2 } })).toBe(0)
    expect((await db.dataset.findUnique({ where: { id: dataset.id } }))?.publishedVersion).toBe(1)
    expect((await (await route.GET(request(pipeline.id, run.id), params)).json()).state).toBe('removed')
    expect(await db.pipelineRun.count({ where: { id: run.id } })).toBe(1)

    const only = await db.dataset.create({ data: { name: 'single output', publishedVersion: 1 } })
    const run2 = await db.pipelineRun.create({ data: {
      pipelineId: pipeline.id, status: 'success', outputDatasetId: only.id, outputVersionNumber: 1,
    } })
    await db.datasetVersion.create({ data: { datasetId: only.id, versionNumber: 1, schemaJson: '[]', createdBy: run2.id } })
    const params2 = { params: Promise.resolve({ id: pipeline.id, runId: run2.id }) }
    const consumer = await db.pipeline.create({ data: { name: 'consumer', graphJson: JSON.stringify({
      nodes: [{ id: 's', type: 'source', data: { datasetId: only.id } }], edges: [],
    }) } })
    expect((await (await route.GET(request(pipeline.id, run2.id), params2)).json()).allowed).toBe(false)
    expect((await route.DELETE(request(pipeline.id, run2.id, 'DELETE'), params2)).status).toBe(409)
    await db.pipeline.delete({ where: { id: consumer.id } })
    expect((await (await route.GET(request(pipeline.id, run2.id), params2)).json()).mode).toBe('dataset')
    expect((await route.DELETE(request(pipeline.id, run2.id, 'DELETE'), params2)).status).toBe(200)
    expect(await db.dataset.findUnique({ where: { id: only.id } })).toBeNull()
    expect(await db.pipelineRun.count({ where: { id: run2.id } })).toBe(1)

    const left = await db.dataset.create({ data: { name: 'join left', publishedVersion: 1 } })
    const right = await db.dataset.create({ data: { name: 'join right', publishedVersion: 1 } })
    await db.datasetVersion.createMany({ data: [
      { datasetId: left.id, versionNumber: 1, schemaJson: '[{"name":"fk","type":"number"}]', dataJson: '[{"fk":2,"label":"left"}]', rowCount: 1 },
      { datasetId: right.id, versionNumber: 1, schemaJson: '[{"name":"id","type":"number"}]', dataJson: '[{"id":2,"label":"right"}]', rowCount: 1 },
    ] })
    const graph = {
      nodes: [
        { id: 'left', type: 'source', data: { datasetId: left.id } },
        { id: 'right', type: 'source', data: { datasetId: right.id } },
        { id: 'join', type: 'join', data: { leftKey: 'fk', rightKey: 'id', how: 'inner' } },
        { id: 'output', type: 'output', data: { name: 'joined output' } },
      ],
      edges: [
        { id: 'right-first', source: 'right', target: 'join', targetHandle: 'in-1' },
        { id: 'left-second', source: 'left', target: 'join', targetHandle: 'in' },
        { id: 'join-output', source: 'join', target: 'output' },
      ],
    }
    const joinPipeline = await db.pipeline.create({ data: { name: 'join order test', graphJson: JSON.stringify(graph) } })
    const { runPipeline } = await import('../src/lib/engine')
    const joinedRun = await runPipeline(joinPipeline.id)
    expect(joinedRun.status).toBe('success')
    const joinedVersion = await db.datasetVersion.findUnique({
      where: { datasetId_versionNumber: { datasetId: joinedRun.outputDatasetId!, versionNumber: joinedRun.outputVersionNumber! } },
    })
    expect(JSON.parse(joinedVersion!.dataJson)).toEqual([{ fk: 2, label: 'left', id: 2, right_label: 'right' }])
  } finally {
    await db.$disconnect()
    if (priorUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = priorUrl
    if (existsSync(dbFile)) unlinkSync(dbFile)
  }
}, 20_000)
