// Read and denial matrix for the disposable example.test role accounts.
import assert from 'node:assert/strict'
import { base, password, fixtureEmail } from './test-config.mjs'
async function login(role) {
  const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: fixtureEmail(role), password }) })
  assert.equal(response.status, 200, `login ${role}`)
  return response.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
}
async function expect(cookie, path, status, method = 'GET', body) {
  const response = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  assert.equal(response.status, status, `${method} ${path}`)
  return response.json()
}
for (const role of ['owner', 'admin', 'editor', 'access', 'auditor', 'viewer']) {
  const cookie = await login(role)
  const data = await expect(cookie, '/api/datasets', 200)
  const input = data.datasets.find(d => d.name === 'Inventory')
  assert.ok(input)
  for (const path of ['/api/projects', '/api/pipelines', '/api/transforms', '/api/ontology', '/api/applications']) await expect(cookie, path, 200)
  await expect(cookie, '/api/audit', ['owner', 'admin', 'auditor'].includes(role) ? 200 : 403)
  await expect(cookie, '/api/organization/members', ['owner', 'admin', 'access', 'auditor'].includes(role) ? 200 : 403)
  await expect(cookie, '/api/tokens', ['owner', 'admin'].includes(role) ? 200 : 403)
  if (['access', 'auditor', 'viewer'].includes(role)) {
    await expect(cookie, `/api/datasets/${input.id}`, 403, 'PATCH', { description: 'Forbidden reader edit' })
    for (const path of ['/api/projects', '/api/pipelines', '/api/applications', '/api/schedules', '/api/tokens', '/api/transforms/seed-demo', '/api/ontology/seed-demo', `/api/datasets/${input.id}/quality/evaluate`]) await expect(cookie, path, 403, 'POST', {})
  }
  if (role === 'access') await expect(cookie, '/api/organization/invitations', 403, 'POST', { email: 'integration.forbidden.admin@example.test', role: 'org_admin' })
  console.log(`PASS ${role}: resource reads, member/audit/token access and mutation denials`)
}
