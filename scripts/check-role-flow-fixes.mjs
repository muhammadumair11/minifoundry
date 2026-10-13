// Regression checks against the retained local Integration organization. No real email
// is sent; the temporary invitation is revoked and secrets are never logged.
import assert from 'node:assert/strict'

import { base, password, fixtureEmail } from './test-config.mjs'
let passed = 0
async function login(role) {
  const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: fixtureEmail(role), password }) })
  assert.equal(response.status, 200, `signin ${role}`)
  return response.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; ')
}
async function request(cookie, path, method = 'GET', body) {
  const response = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  return { status: response.status, data: await response.json() }
}
function check(label, callback) { callback(); passed++; console.log(`PASS ${label}`) }

const owner = await login('owner')
const viewer = await login('viewer')
const access = await login('access')
const foreign = await login('isolation')
let pendingId
try {
  const email = `integration.invitation.${Date.now()}@example.test`
  const invited = await request(owner, '/api/organization/invitations', 'POST', { email, role: 'viewer' })
  check('invitation created', () => assert.equal(invited.status, 201))
  pendingId = invited.data.invitation.id
  const listing = await request(owner, '/api/organization/invitations')
  check('pending status is visible without leaking token hashes', () => {
    assert.equal(listing.status, 200)
    assert.ok(listing.data.invitations.some((item) => item.id === pendingId && item.status === 'pending'))
    assert.ok(!JSON.stringify(listing.data).includes('tokenHash'))
  })
  assert.equal((await request(viewer, '/api/organization/invitations')).status, 403)
  check('viewer cannot list invitations', () => {})
  assert.equal((await request(foreign, `/api/organization/invitations/${pendingId}`, 'DELETE')).status, 404)
  const reissued = await request(access, `/api/organization/invitations/${pendingId}/reissue`, 'POST')
  check('access manager can reissue viewer invitation', () => assert.equal(reissued.status, 201))
  assert.equal((await request('', `/api/invitations/${invited.data.invitation.acceptUrl.split('/').pop()}`)).status, 404)
  pendingId = reissued.data.invitation.id
  assert.equal((await request(owner, `/api/organization/invitations/${pendingId}`, 'DELETE')).status, 200)
  assert.equal((await request('', `/api/invitations/${reissued.data.invitation.acceptUrl.split('/').pop()}`)).status, 404)
  check('reissue and revoke invalidate old links', () => {})

  const privileged = await request(owner, '/api/organization/invitations', 'POST', { email: `integration.admin.invitation.${Date.now()}@example.test`, role: 'org_admin' })
  pendingId = privileged.data.invitation.id
  assert.equal((await request(access, `/api/organization/invitations/${pendingId}/reissue`, 'POST')).status, 403)
  assert.equal((await request(access, `/api/organization/invitations/${pendingId}`, 'DELETE')).status, 403)
  check('access manager cannot manage admin invitations', () => {})
  await request(owner, `/api/organization/invitations/${pendingId}`, 'DELETE')
  pendingId = null

  const datasets = (await request(owner, '/api/datasets')).data.datasets
  const inventory = datasets.find((item) => item.name === 'Inventory')
  assert.ok(inventory, 'load catalog samples first')
  const evaluation = await request(owner, `/api/datasets/${inventory.id}/quality/evaluate`, 'POST')
  check('empty evaluation explicitly returns not_evaluated', () => {
    assert.equal(evaluation.status, 200)
    assert.equal(evaluation.data.qualityState, 'not_evaluated')
    assert.equal(evaluation.data.results.length, 0)
  })
  check('dataset picker can determine draft eligibility', () => assert.ok(datasets.every((item) => Object.hasOwn(item, 'latestDraftVersion'))))
  const seeded = await request(owner, '/api/transforms/seed-demo', 'POST')
  check('workbook examples seed without Active Shipments', () => {
    assert.equal(seeded.status, 200)
    assert.equal(seeded.data.created.length + seeded.data.skipped.length, 3)
  })
  const pipelines = (await request(owner, '/api/pipelines')).data.pipelines
  const pipeline = pipelines.find((item) => item.name === 'Integration Pipeline')
  const versions = (await request(owner, `/api/pipelines/${pipeline.id}/versions`)).data.versions
  const versionLists = await Promise.all(pipelines.map(async (item) => (await request(owner, `/api/pipelines/${item.id}/versions`)).data.versions))
  const totalVersions = versionLists.reduce((sum, list) => sum + list.length, 0)
  const overview = (await request(owner, '/api/settings/overview')).data
  check('Settings counts saved pipeline versions', () => {
    assert.ok(versions.length > 0)
    assert.equal(overview.pipelineVersions, totalVersions)
  })
  console.log(`${passed} role-flow checks passed`)
} finally {
  if (pendingId) await request(owner, `/api/organization/invitations/${pendingId}`, 'DELETE')
}
