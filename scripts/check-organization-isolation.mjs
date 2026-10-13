// Local API regression journey. TEST_CREATE_FIXTURES=1 creates only disposable
// example.test accounts; this script never resets the database automatically.
import assert from 'node:assert/strict'
import { base, password, fixtureEmail, fixtureNamespace } from './test-config.mjs'
const email = fixtureEmail
const cookieFrom = (response) => response.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
async function request(cookie, path, method = 'GET', body, extra = {}) {
  const response = await fetch(base + path, { method, headers: { cookie, ...extra, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const text = await response.text()
  let data
  try { data = JSON.parse(text) } catch { data = text }
  return { status: response.status, data, cookie: cookieFrom(response) }
}
async function expect(cookie, path, status = 200, method = 'GET', body, extra) {
  const result = await request(cookie, path, method, body, extra)
  assert.equal(result.status, status, `${method} ${path}: ${typeof result.data === 'object' ? result.data.error ?? '' : 'unexpected response'}`)
  return result.data
}
async function login(role) {
  const result = await request('', '/api/auth/login', 'POST', { email: email(role), password })
  assert.equal(result.status, 200, `login ${role}`)
  return result.cookie
}
async function seedRole(role) {
    const cookie = await login(role)
    await expect(cookie, '/api/seed', 200, 'POST')
    await expect(cookie, '/api/projects', 201, 'POST', { name: `Integration ${role} Project` })
    const { datasets } = await expect(cookie, '/api/datasets')
    const inventory = datasets.find((d) => d.name === 'Inventory')
    await expect(cookie, '/api/transforms', 201, 'POST', { name: 'Integration Workbook', language: 'sql', sourceCode: 'SELECT * FROM "inventory" LIMIT 5', inputs: [inventory.id], outputDatasetName: 'Integration Workbook Output' })
    await expect(cookie, '/api/ontology/seed-demo', 200, 'POST')
    await expect(cookie, '/api/applications', 201, 'POST', { name: 'Integration Application', template: 'blank' })
    const graph = { nodes: [
      { id: 'source', type: 'source', data: { datasetId: inventory.id }, position: { x: 80, y: 120 } },
      { id: 'limit', type: 'limit', data: { n: 5 }, position: { x: 360, y: 120 } },
      { id: 'output', type: 'output', data: { name: 'Integration Output' }, position: { x: 640, y: 120 } },
    ], edges: [{ id: 'e1', source: 'source', target: 'limit' }, { id: 'e2', source: 'limit', target: 'output' }] }
    await expect(cookie, '/api/pipelines', 201, 'POST', { name: 'Integration Pipeline', graph })
}
if (process.env.TEST_CREATE_FIXTURES === '1') {
  for (const [role, organizationName] of [['owner', `Integration ${fixtureNamespace} primary`], ['isolation', `Integration ${fixtureNamespace} control`]]) {
    const signup = await request('', '/api/auth/signup', 'POST', { organizationName, name: `Integration ${role}`, email: email(role), password })
    assert.equal(signup.status, 201, `create fresh ${role}: ${signup.data.error ?? ''}; choose a fresh TEST_NAMESPACE for fixture creation`)
  }
  const owner = await login('owner')
  for (const [role, organizationRole] of [['admin', 'org_admin'], ['access', 'access_manager'], ['auditor', 'auditor'], ['editor', 'editor'], ['viewer', 'viewer']]) {
    const invitation = await expect(owner, '/api/organization/invitations', 201, 'POST', { email: email(role), role: organizationRole })
    const token = invitation.invitation.acceptUrl.split('/').pop()
    await expect('', `/api/invitations/${token}/accept`, 201, 'POST', { name: `Integration ${role}`, password })
  }
  for (const role of ['owner', 'isolation']) await seedRole(role)
  console.log('PASS recreated two organizations and all six roles')
}
if (process.env.TEST_RESEED_CONTROL === '1') await seedRole('isolation')
// Browser onboarding can create the accounts first; seed only their resources.
if (process.env.TEST_SEED_FIXTURES === '1') for (const role of ['owner', 'isolation']) await seedRole(role)
const owner = await login('owner'), foreign = await login('isolation')
const roles = Object.fromEntries(await Promise.all(['admin', 'access', 'auditor', 'editor', 'viewer'].map(async (role) => [role, await login(role)])))
const a = (await expect(owner, '/api/session')).organizationId
const b = (await expect(foreign, '/api/session')).organizationId
assert.notEqual(a, b)
const datasetsA = (await expect(owner, '/api/datasets')).datasets
const datasetsB = (await expect(foreign, '/api/datasets')).datasets
assert.ok(datasetsA.length && datasetsB.length)
assert.ok(datasetsA.every((d) => !datasetsB.some((other) => other.id === d.id)))
const dsA = datasetsA.find((d) => d.name === 'Inventory'), dsB = datasetsB.find((d) => d.name === 'Inventory')
assert.notEqual(dsA.id, dsB.id)
for (const suffix of ['', '/rows', '/export', '/quality', '/branches', '/comments']) await expect(foreign, `/api/datasets/${dsA.id}${suffix}`, 404)
await expect(foreign, `/api/datasets/${dsA.id}`, 404, 'PATCH', { name: 'Forbidden rename' })
await expect(owner, `/api/datasets/${dsB.id}`, 404, 'GET', undefined, { 'x-mf-organization-id': b, 'x-mf-actor-role': 'admin' })
await expect(owner, '/api/transforms', 400, 'POST', { name: 'Foreign input', sourceCode: 'SELECT 1', inputs: [dsB.id], outputDatasetName: 'Forbidden' })
console.log('PASS dataset lists, direct reads, exports, mutations, bindings and spoofed headers are isolated')

for (const [path, key, detail] of [['/api/projects', 'projects', false], ['/api/pipelines', 'pipelines', true], ['/api/transforms', 'transforms', true], ['/api/applications', 'applications', true], ['/api/ontology', 'objectTypes', false]]) {
  const left = (await expect(owner, path))[key], right = (await expect(foreign, path))[key]
  assert.ok(left?.length && right?.length, `fixtures for ${path}`)
  assert.ok(left.every((item) => !right.some((other) => other.id === item.id)), path)
  if (detail) await expect(foreign, `${path}/${left[0].id}`, 404)
}
await Promise.all(Array.from({ length: 32 }, async (_, index) => {
  const own = index % 2 ? owner : foreign, ownId = index % 2 ? dsA.id : dsB.id, otherId = index % 2 ? dsB.id : dsA.id
  await expect(own, `/api/datasets/${ownId}`)
  await expect(own, `/api/datasets/${otherId}`, 404)
}))
console.log('PASS resources and concurrent requests remain separated')

for (const cookie of [owner, foreign]) {
  const pipeline = (await expect(cookie, '/api/pipelines')).pipelines.find((p) => p.name === 'Integration Pipeline')
  const queued = await expect(cookie, `/api/pipelines/${pipeline.id}/run`, 202, 'POST')
  let job
  for (let attempt = 0; attempt < 40; attempt++) {
    job = (await expect(cookie, `/api/execution-jobs/${queued.job.id}`)).job
    if (['succeeded', 'failed'].includes(job.status)) break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  assert.equal(job.status, 'succeeded', `worker job: ${job.error ?? ''}`)
  const output = (await expect(cookie, '/api/datasets')).datasets.find((d) => d.name === 'Integration Output')
  assert.ok(output, 'worker output retained tenant')
  await expect(cookie === owner ? foreign : owner, `/api/execution-jobs/${queued.job.id}`, 404)
  await expect(cookie === owner ? foreign : owner, `/api/datasets/${output.id}`, 404)
}
console.log('PASS background jobs and outputs keep their organization ownership')

for (const cookie of [owner, foreign]) {
  const output = (await expect(cookie, '/api/datasets')).datasets.find((d) => d.name === 'Integration Output')
  const graph = { nodes: [
    { id: 'source', type: 'source', data: { datasetId: output.id }, position: { x: 80, y: 120 } },
    { id: 'output', type: 'output', data: { name: 'Integration Trigger Output' }, position: { x: 360, y: 120 } },
  ], edges: [{ id: 'edge', source: 'source', target: 'output' }] }
  const pipelines = (await expect(cookie, '/api/pipelines')).pipelines
  let trigger = pipelines.find((p) => p.name === 'Integration Trigger Pipeline')
  if (!trigger) trigger = (await expect(cookie, '/api/pipelines', 201, 'POST', { name: 'Integration Trigger Pipeline', graph })).pipeline
  await expect(cookie, `/api/pipelines/${trigger.id}`, 200, 'PATCH', { graph, triggerMode: 'upstream', upstreamDatasetIds: [output.id] })
  const basePipeline = pipelines.find((p) => p.name === 'Integration Pipeline')
  await expect(cookie, `/api/pipelines/${basePipeline.id}/run`, 202, 'POST')
  let triggered
  for (let attempt = 0; attempt < 50; attempt++) {
    triggered = (await expect(cookie, '/api/datasets')).datasets.find((d) => d.name === 'Integration Trigger Output')
    if (triggered) break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  assert.ok(triggered, 'scoped version event triggered a downstream pipeline')
  await expect(cookie === owner ? foreign : owner, `/api/datasets/${triggered.id}`, 404)
}
console.log('PASS version events trigger pipelines inside their own organization')

const tokenName = `Integration Isolation Token ${Date.now()}`
const tokenA = await expect(owner, '/api/tokens', 201, 'POST', { name: tokenName })
const tokenB = await expect(foreign, '/api/tokens', 201, 'POST', { name: tokenName })
try {
  const v1A = await expect('', '/api/foundry/v1/datasets', 200, 'GET', undefined, { authorization: `Bearer ${tokenA.secret}` })
  const v1B = await expect('', '/api/foundry/v1/datasets', 200, 'GET', undefined, { authorization: `Bearer ${tokenB.secret}` })
  assert.ok(JSON.stringify(v1A).includes(dsA.id) && !JSON.stringify(v1A).includes(dsB.id))
  assert.ok(JSON.stringify(v1B).includes(dsB.id) && !JSON.stringify(v1B).includes(dsA.id))
  const tokenOverSession = await expect(owner, '/api/foundry/v1/datasets', 200, 'GET', undefined, { authorization: `Bearer ${tokenB.secret}` })
  assert.ok(JSON.stringify(tokenOverSession).includes(dsB.id) && !JSON.stringify(tokenOverSession).includes(dsA.id), 'token organization overrides a different browser session')
  await expect('', `/api/foundry/v1/datasets/${dsB.id}`, 404, 'GET', undefined, { authorization: `Bearer ${tokenA.secret}`, 'x-mf-organization-id': b })
} finally {
  await expect(owner, `/api/tokens/${tokenA.token.id}`, 200, 'DELETE')
  await expect(foreign, `/api/tokens/${tokenB.token.id}`, 200, 'DELETE')
}
console.log('PASS API tokens select their stored organization and cannot spoof scope')

for (const role of ['access', 'auditor', 'viewer']) await expect(roles[role], '/api/projects', 403, 'POST', { name: 'Reader mutation' })
await expect(roles.viewer, '/api/audit', 403)
await expect(roles.auditor, '/api/audit')
await expect(roles.access, '/api/organization/members')
await expect(roles.editor, '/api/organization/members', 403)
const editor = (await expect(owner, '/api/organization/members')).members.find((member) => member.email === email('editor'))
assert.ok(editor)
try {
  await expect(owner, `/api/organization/members/${editor.id}`, 200, 'PATCH', { role: 'viewer' })
  // Retain the old editor cookie: authorization must use current membership.
  await expect(roles.editor, '/api/projects', 403, 'POST', { name: 'Stale editor claim' })
} finally {
  await expect(owner, `/api/organization/members/${editor.id}`, 200, 'PATCH', { role: 'editor' })
}
console.log('PASS membership changes immediately invalidate stale role claims')
const auditA = await expect(owner, '/api/audit'), auditB = await expect(foreign, '/api/audit')
assert.ok(!JSON.stringify(auditB).includes(email('owner')) && !JSON.stringify(auditA).includes(email('isolation')))
const searchB = await expect(foreign, '/api/search?q=Integration%20owner%20Project')
assert.ok(!JSON.stringify(searchB).includes('Integration owner Project'))
const overviewA = await expect(owner, '/api/settings/overview'), overviewB = await expect(foreign, '/api/settings/overview')
assert.equal(overviewA.users, 6)
assert.equal(overviewB.users, 1)
console.log('PASS role guards, audit, search and organization counts')
console.log('Organization isolation journey passed')
