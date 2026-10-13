// Live local contract regression: disposable pipeline/output; no reset or secrets logged.
import assert from 'node:assert/strict'
import { base, password, fixtureEmail } from './test-config.mjs'
async function request(cookie, path, status = 200, method = 'GET', body) {
  const response = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const data = await response.json()
  assert.equal(response.status, status, `${method} ${path}: ${data.error ?? ''}`)
  return data
}
async function login(role) {
  const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: fixtureEmail(role), password }) })
  assert.equal(response.status, 200, `login ${role}`)
  return response.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
}
const owner = await login('owner'), admin = await login('admin'), editor = await login('editor'), viewer = await login('viewer'), foreign = await login('isolation')
const input = (await request(owner, '/api/datasets')).datasets.find(d => d.name === 'Inventory')
assert.ok(input)
const name = `Integration Publication Contract ${Date.now()}`
const graph = { nodes: [
  { id: 'source', type: 'source', data: { datasetId: input.id }, position: { x: 80, y: 120 } },
  { id: 'limit', type: 'limit', data: { n: 5 }, position: { x: 360, y: 120 } },
  { id: 'output', type: 'output', data: { name }, position: { x: 640, y: 120 } },
], edges: [{ id: 'e1', source: 'source', target: 'limit' }, { id: 'e2', source: 'limit', target: 'output' }] }
const pipeline = (await request(editor, '/api/pipelines', 201, 'POST', { name, graph })).pipeline
async function run() {
  const jobId = (await request(editor, `/api/pipelines/${pipeline.id}/run`, 202, 'POST')).job.id
  let job
  for (let i = 0; i < 60; i++) {
    job = (await request(editor, `/api/execution-jobs/${jobId}`)).job
    if (['succeeded', 'failed'].includes(job.status)) break
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  assert.equal(job.status, 'succeeded', job.error ?? 'pipeline must finish')
}
await run()
const output = (await request(owner, '/api/datasets')).datasets.find(d => d.name === name)
assert.ok(output)
await request(editor, `/api/datasets/${output.id}`, 200, 'PATCH', { qualityGate: true })
await run()
const evaluate = () => request(editor, `/api/datasets/${output.id}/quality/evaluate`, 200, 'POST')
let approvalId
try {
  const empty = await evaluate()
  assert.equal(empty.qualityState, 'not_evaluated')
  assert.equal(empty.results.length, 0)
  approvalId = (await request(editor, '/api/approvals', 201, 'POST', { kind: 'publish_dataset', targetId: output.id, note: 'Integration publication contract' })).approval.id
  const preview = async () => (await request(owner, '/api/approvals')).approvals.find(a => a.id === approvalId).publishPreview
  assert.equal((await preview()).qualityState, 'not_evaluated')
  await request(owner, `/api/approvals/${approvalId}/decide`, 403, 'POST', { decision: 'approved' })
  assert.equal((await request(owner, '/api/approvals')).approvals.find(a => a.id === approvalId).status, 'pending')
  console.log('PASS zero-rule draft is blocked and failed approval remains pending')
  await request(viewer, '/api/approvals', 403, 'POST', { kind: 'publish_dataset', targetId: output.id })
  await request(foreign, `/api/approvals/${approvalId}/decide`, 404, 'POST', { decision: 'approved' })
  const rule = await request(editor, `/api/datasets/${output.id}/quality`, 201, 'POST', { name: 'Integration minimum rows', kind: 'row_count_min', severity: 'error', config: { minRows: 10 } })
  assert.equal((await evaluate()).qualityState, 'failed')
  const failed = await preview()
  assert.equal(failed.status, 'blocked')
  assert.equal(failed.failing.length, 1, 'approval preview must include the real failing error rule')
  assert.equal(failed.failing[0].name, 'Integration minimum rows')
  assert.ok(failed.failing[0].message.includes('only 5 rows'))
  await request(owner, `/api/approvals/${approvalId}/decide`, 403, 'POST', { decision: 'approved' })
  console.log('PASS error-rule name, count and reason reach the blocked approval preview')
  await request(editor, `/api/datasets/${output.id}/quality/${rule.id}`, 200, 'PATCH', { severity: 'warn' })
  assert.equal((await evaluate()).qualityState, 'warned')
  assert.equal((await preview()).status, 'ready')
  const warningDecision = await request(owner, `/api/approvals/${approvalId}/decide`, 200, 'POST', { decision: 'approved' })
  assert.equal(warningDecision.approval.decidedBy, 'owner')
  approvalId = null
  assert.equal((await request(owner, `/api/datasets/${output.id}`)).dataset.publishedVersion, 2)
  console.log('PASS warning-only evaluation permits publishing the pinned draft')
  await run()
  await request(editor, `/api/datasets/${output.id}/quality/${rule.id}`, 200, 'PATCH', { severity: 'error', config: { minRows: 1 } })
  assert.equal((await evaluate()).qualityState, 'passed')
  approvalId = (await request(editor, `/api/datasets/${output.id}/publish`, 201, 'POST', { note: 'Integration passing rules' })).approval.id
  const passingDecision = await request(owner, `/api/approvals/${approvalId}/decide`, 200, 'POST', { decision: 'approved' })
  assert.equal(passingDecision.approval.decidedBy, 'owner')
  approvalId = null
  assert.equal((await request(owner, `/api/datasets/${output.id}`)).dataset.publishedVersion, 3)
  console.log('PASS passing evaluation publishes v3 and advances the consumer version')
  const pipelineRequest = (await request(owner, '/api/approvals', 201, 'POST', { kind: 'publish_pipeline', targetId: pipeline.id })).approval
  approvalId = pipelineRequest.id
  assert.equal(pipelineRequest.requestedBy, 'owner')
  const adminDecision = (await request(admin, `/api/approvals/${approvalId}/decide`, 200, 'POST', { decision: 'approved' })).approval
  assert.equal(adminDecision.decidedBy, 'org_admin')
  approvalId = null
  let publicationEntries = []
  for (let i = 0; i < 30; i++) {
    publicationEntries = (await request(owner, '/api/audit?action=dataset.publish&limit=200')).entries.filter(e => e.resourceId === output.id)
    if (publicationEntries.length >= 4) break
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.ok(publicationEntries.length >= 4, 'local and propagated publication audits must arrive')
  assert.ok(publicationEntries.every(e => e.actorRole === 'owner'), 'propagated publication audits retain the organization owner role')
  console.log('PASS approval history and publication audits preserve Owner and Organization Admin roles')
} finally {
  if (approvalId) await request(owner, `/api/approvals/${approvalId}/decide`, 200, 'POST', { decision: 'rejected', note: 'Integration cleanup after an incomplete check' })
}
