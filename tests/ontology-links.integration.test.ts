import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

test('links can be created, traversed, edited and deleted without removing source data', async () => {
  const root = join(import.meta.dir, '..')
  const dbName = `test-ontology-links-${randomUUID()}.db`
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
  const { reloadDbClientForTests } = await import('../src/lib/db')
  const db = await reloadDbClientForTests()
  try {
    const makeDataset = async (name: string, rows: Record<string, unknown>[]) => {
      const dataset = await db.dataset.create({ data: { name, tags: '[]' } })
      const schema = Object.keys(rows[0]).map((column) => ({ name: column, type: 'string' }))
      await db.datasetVersion.create({ data: {
        datasetId: dataset.id, versionNumber: 1, rowCount: rows.length,
        schemaJson: JSON.stringify(schema), dataJson: JSON.stringify(rows),
      } })
      return dataset
    }
    const customerData = await makeDataset('customers', [{ cid: 'c1', name: 'Alice' }])
    const orderData = await makeDataset('orders', [{ oid: 'o1', cid: 'c1', title: 'First order' }])
    const relationData = await makeDataset('relationship', [{ note: 'extra first column', oid: 'o1', cid: 'c1' }])
    const customer = await db.objectType.create({ data: {
      apiName: 'customer', displayName: 'Customer', sourceDatasetId: customerData.id, primaryKey: 'cid',
      properties: { create: [{ apiName: 'cid', displayName: 'ID' }, { apiName: 'name', displayName: 'Name', isTitle: true }] },
    } })
    const order = await db.objectType.create({ data: {
      apiName: 'order', displayName: 'Order', sourceDatasetId: orderData.id, primaryKey: 'oid',
      properties: { create: [{ apiName: 'oid', displayName: 'ID' }, { apiName: 'cid', displayName: 'Customer ID' }, { apiName: 'title', displayName: 'Title', isTitle: true }] },
    } })
    const { NextRequest } = await import('next/server')
    const createRoute = await import('../src/app/api/ontology/links/route')
    const itemRoute = await import('../src/app/api/ontology/links/[id]/route')
    const ontologyRoute = await import('../src/app/api/ontology/route')
    const appRoute = await import('../src/app/api/applications/[id]/route')
    const { getLinksFor } = await import('../src/lib/ontology-service')
    const request = (url: string, method: string, body: unknown, role = 'editor') => new NextRequest(url, {
      method, headers: { cookie: `foundry-role=${role}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const base = { displayName: 'Customer orders', apiName: 'customer-orders', fromTypeId: customer.id,
      toTypeId: order.id, cardinality: 'one-to-many', fkProperty: 'cid' }
    expect((await createRoute.POST(request('http://localhost/api/ontology/links', 'POST', base, 'viewer'))).status).toBe(403)
    expect((await createRoute.POST(request('http://localhost/api/ontology/links', 'POST', { ...base, fkProperty: 'missing' }))).status).toBe(400)
    const created = await createRoute.POST(request('http://localhost/api/ontology/links', 'POST', base))
    expect(created.status).toBe(201)
    const linkId = (await created.json()).link.id as string
    const list = await ontologyRoute.GET()
    const serialized = (await list.json()).objectTypes.find((type: { id: string }) => type.id === customer.id)
    expect(serialized.linksOut[0].fkProperty).toBe('cid')
    const withLinks = await db.objectType.findUniqueOrThrow({ where: { id: customer.id }, include: {
      outgoingLinks: { include: { toType: { include: { properties: true } } } },
    } })
    const targets = await getLinksFor(withLinks, 'c1')
    expect(targets[0].total).toBe(1)
    expect(targets[0].targets[0].pk).toBe('o1')

    const orderToCustomer = { ...base, displayName: 'Order customer', apiName: 'order-customer',
      fromTypeId: order.id, toTypeId: customer.id, cardinality: 'many-to-one', fkSide: 'from', fkProperty: 'cid' }
    expect((await itemRoute.PATCH(request(`http://localhost/api/ontology/links/${linkId}`, 'PATCH',
      { ...orderToCustomer, fkSide: 'to' }), { params: Promise.resolve({ id: linkId }) })).status).toBe(400)
    expect((await itemRoute.PATCH(request(`http://localhost/api/ontology/links/${linkId}`, 'PATCH', orderToCustomer),
      { params: Promise.resolve({ id: linkId }) })).status).toBe(200)
    const orderWithLink = await db.objectType.findUniqueOrThrow({ where: { id: order.id }, include: {
      outgoingLinks: { include: { toType: { include: { properties: true } } } },
    } })
    expect((await getLinksFor(orderWithLink, 'o1'))[0].targets[0].pk).toBe('c1')
    const customerWithIncoming = await db.objectType.findUniqueOrThrow({ where: { id: customer.id }, include: {
      incomingLinks: { include: { fromType: { include: { properties: true } } } },
    } })
    const reverse = (await getLinksFor(customerWithIncoming, 'c1'))[0]
    expect(reverse.targets[0].pk).toBe('o1')
    expect(reverse.fkProperty).toBe('cid')

    expect((await itemRoute.PATCH(request(`http://localhost/api/ontology/links/${linkId}`, 'PATCH',
      { ...orderToCustomer, cardinality: 'one-to-one' }), { params: Promise.resolve({ id: linkId }) })).status).toBe(200)
    expect((await getLinksFor(await db.objectType.findUniqueOrThrow({ where: { id: order.id }, include: {
      outgoingLinks: { include: { toType: { include: { properties: true } } } },
    } }), 'o1'))[0].targets[0].pk).toBe('c1')

    const many = { ...base, cardinality: 'many-to-many', fkProperty: null,
      linkDatasetId: relationData.id, fromKeyColumn: 'cid', toKeyColumn: 'oid' }
    expect((await itemRoute.PATCH(request(`http://localhost/api/ontology/links/${linkId}`, 'PATCH',
      { ...many, toKeyColumn: 'missing' }), { params: Promise.resolve({ id: linkId }) })).status).toBe(400)
    expect((await itemRoute.PATCH(request(`http://localhost/api/ontology/links/${linkId}`, 'PATCH', many),
      { params: Promise.resolve({ id: linkId }) })).status).toBe(200)
    const updated = await db.objectType.findUniqueOrThrow({ where: { id: customer.id }, include: {
      outgoingLinks: { include: { toType: { include: { properties: true } } } },
    } })
    const manyTargets = await getLinksFor(updated, 'c1')
    expect(manyTargets[0].targets[0].pk).toBe('o1')
    const incoming = await db.objectType.findUniqueOrThrow({ where: { id: order.id }, include: {
      incomingLinks: { include: { fromType: { include: { properties: true } } } },
    } })
    expect((await getLinksFor(incoming, 'o1'))[0].targets[0].pk).toBe('c1')

    const application = await db.application.create({ data: { name: 'Old app', configJson: '{}', createdBy: 'test' } })
    expect((await appRoute.DELETE(new NextRequest(`http://localhost/api/applications/${application.id}`, {
      method: 'DELETE', headers: { cookie: 'foundry-role=editor' },
    }), { params: Promise.resolve({ id: application.id }) })).status).toBe(200)
    expect(await db.application.findUnique({ where: { id: application.id } })).toBeNull()
    expect(await db.dataset.count()).toBe(3)
    expect((await itemRoute.DELETE(new NextRequest(`http://localhost/api/ontology/links/${linkId}`, {
      method: 'DELETE', headers: { cookie: 'foundry-role=editor' },
    }), { params: Promise.resolve({ id: linkId }) })).status).toBe(204)
    expect(await db.linkType.findUnique({ where: { id: linkId } })).toBeNull()
    expect(await db.objectType.count()).toBe(2)
  } finally {
    await db.$disconnect()
    if (priorUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = priorUrl
    if (existsSync(dbFile)) unlinkSync(dbFile)
  }
}, 30_000)
