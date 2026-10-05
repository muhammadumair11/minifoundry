import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

// Action parameter contract: empty `oneOf` lists must never be persisted (they
// used to render as dropdowns with zero options in the run dialog), and apply
// must keep working for parameters without allowed values.
test('action parameters normalize empty oneOf and apply writes back by key', async () => {
  const root = join(import.meta.dir, '..')
  const dbName = `test-ontology-actions-${randomUUID()}.db`
  const dbFile = join(root, 'db', dbName)
  const dbUrl = `file:../db/${dbName}`
  const priorUrl = process.env.DATABASE_URL
  writeFileSync(dbFile, '')
  const init = spawnSync('node', [join(root, 'node_modules', 'prisma', 'build', 'index.js'), 'db', 'push', '--skip-generate'], {
    cwd: root, env: { ...process.env, DATABASE_URL: dbUrl }, encoding: 'utf8',
  })
  if (init.status !== 0) {
    unlinkSync(dbFile)
    throw new Error(`Could not create test database: ${init.stderr || init.stdout}`)
  }
  process.env.DATABASE_URL = dbUrl
  const { reloadDbClientForTests } = await import('../src/lib/db')
  const db = await reloadDbClientForTests()
  try {
    const rows = [
      { order_id: 'o1', status: 'pending', customer: 'Alice' },
      { order_id: 'o2', status: 'completed', customer: 'Bob' },
    ]
    const dataset = await db.dataset.create({ data: { name: 'orders', tags: '[]' } })
    const schema = Object.keys(rows[0]).map((column) => ({ name: column, type: 'string' }))
    await db.datasetVersion.create({ data: {
      datasetId: dataset.id, versionNumber: 1, rowCount: rows.length,
      schemaJson: JSON.stringify(schema), dataJson: JSON.stringify(rows),
    } })
    const order = await db.objectType.create({ data: {
      apiName: 'order', displayName: 'Order', sourceDatasetId: dataset.id, primaryKey: 'order_id',
      properties: { create: [
        { apiName: 'order_id', displayName: 'Order Id' },
        { apiName: 'status', displayName: 'Status' },
        { apiName: 'customer', displayName: 'Customer', isTitle: true },
      ] },
    } })

    const { NextRequest } = await import('next/server')
    const createRoute = await import('../src/app/api/ontology/actions/route')
    const itemRoute = await import('../src/app/api/ontology/actions/[id]/route')
    const applyRoute = await import('../src/app/api/actions/[apiName]/apply/route')
    const detailRoute = await import('../src/app/api/actions/[apiName]/route')
    const request = (url: string, method: string, body: unknown, role = 'editor') => new NextRequest(url, {
      method, headers: { cookie: `foundry-role=${role}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })

    // ── create with empty oneOf lists (the legacy broken payload) ──
    const created = await createRoute.POST(request('http://localhost/api/ontology/actions', 'POST', {
      displayName: 'Update Order Status',
      objectTypeId: order.id,
      operation: 'update',
      parameters: [
        { apiName: 'order_id', displayName: 'Order Id', dataType: 'string', required: true, mapsTo: 'order_id', isPk: true, oneOf: [] },
        { apiName: 'status', displayName: 'Status', dataType: 'string', required: true, mapsTo: 'status', oneOf: [] },
      ],
      writeback: { targetDatasetId: dataset.id, writeMode: 'upsert', keyProperty: 'order_id' },
    }))
    expect(created.status).toBe(201)
    const actionId = (await created.json()).action.id as string
    const stored = await db.actionType.findUnique({ where: { id: actionId }, select: { parametersJson: true } })
    const storedParams = JSON.parse(stored!.parametersJson) as Array<Record<string, unknown>>
    expect(storedParams).toHaveLength(2)
    for (const p of storedParams) expect('oneOf' in p).toBe(false)

    // ── non-empty oneOf survives (with blank entries filtered) ──
    const withOneOf = await createRoute.POST(request('http://localhost/api/ontology/actions', 'POST', {
      displayName: 'Set Priority',
      objectTypeId: order.id,
      operation: 'update',
      parameters: [
        { apiName: 'order_id', dataType: 'string', required: true, mapsTo: 'order_id', isPk: true },
        { apiName: 'status', dataType: 'string', required: true, mapsTo: 'status', oneOf: ['urgent', '', 'low'] },
      ],
      writeback: { targetDatasetId: dataset.id, writeMode: 'upsert', keyProperty: 'order_id' },
    }))
    expect(withOneOf.status).toBe(201)
    const withOneOfBody = (await withOneOf.json()) as {
      action: { apiName: string; parameters: Array<{ apiName: string; oneOf?: string[] }> }
    }
    const withOneOfParams = withOneOfBody.action.parameters
    expect(withOneOfParams.find((p) => p.apiName === 'status')?.oneOf).toEqual(['urgent', 'low'])

    // ── detail endpoint exposes parameters without oneOf for the run form ──
    const detail = await detailRoute.GET(
      request('http://localhost/api/actions/update-order-status', 'GET', undefined),
      { params: Promise.resolve({ apiName: 'update-order-status' }) },
    )
    expect(detail.status).toBe(200)
    const detailParams = (await detail.json()).action.parameters as Array<{ apiName: string; oneOf?: string[] }>
    expect(detailParams.find((p) => p.apiName === 'status')?.oneOf).toBeUndefined()

    // ── apply: upsert by key updates the existing row and publishes v2 ──
    const applied = await applyRoute.POST(
      request('http://localhost/api/actions/update-order-status/apply', 'POST', {
        params: { order_id: 'o1', status: 'completed' },
      }),
      { params: Promise.resolve({ apiName: 'update-order-status' }) },
    )
    expect(applied.status).toBe(200)
    const appliedBody = await applied.json()
    expect(appliedBody.versionNumber).toBe(2)
    expect(appliedBody.objectPk).toBe('o1')
    const version2 = await db.datasetVersion.findUnique({
      where: { datasetId_versionNumber: { datasetId: dataset.id, versionNumber: 2 } },
    })
    const v2Rows = JSON.parse(version2!.dataJson) as Array<Record<string, unknown>>
    expect(v2Rows.find((r) => r.order_id === 'o1')?.status).toBe('completed')
    expect(v2Rows.find((r) => r.order_id === 'o2')?.status).toBe('completed')

    // ── apply: missing required parameter is rejected ──
    const missing = await applyRoute.POST(
      request('http://localhost/api/actions/update-order-status/apply', 'POST', { params: { order_id: 'o1' } }),
      { params: Promise.resolve({ apiName: 'update-order-status' }) },
    )
    expect(missing.status).toBe(400)

    // ── apply: value outside oneOf is rejected ──
    const setPriorityApi = withOneOfBody.action.apiName
    const badEnum = await applyRoute.POST(
      request(`http://localhost/api/actions/${setPriorityApi}/apply`, 'POST', { params: { order_id: 'o2', status: 'medium' } }),
      { params: Promise.resolve({ apiName: setPriorityApi }) },
    )
    expect(badEnum.status).toBe(400)

    // ── PATCH with empty oneOf drops it from storage ──
    const patched = await itemRoute.PATCH(
      request(`http://localhost/api/ontology/actions/${actionId}`, 'PATCH', {
        parameters: [
          { apiName: 'order_id', dataType: 'string', required: true, mapsTo: 'order_id', isPk: true, oneOf: [] },
          { apiName: 'status', dataType: 'string', required: true, mapsTo: 'status', oneOf: [] },
        ],
      }),
      { params: Promise.resolve({ id: actionId }) },
    )
    expect(patched.status).toBe(200)
    const storedAfterPatch = await db.actionType.findUnique({ where: { id: actionId }, select: { parametersJson: true } })
    for (const p of JSON.parse(storedAfterPatch!.parametersJson) as Array<Record<string, unknown>>) {
      expect('oneOf' in p).toBe(false)
    }
  } finally {
    await db.$disconnect()
    if (priorUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = priorUrl
    if (existsSync(dbFile)) unlinkSync(dbFile)
  }
}, 30_000)
