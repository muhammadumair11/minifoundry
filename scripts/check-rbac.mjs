// Integration regression checks for a local Docker Compose development stack.
// Fixture ids are unique; finally removes only the records created here.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHmac, randomUUID, createHash } from 'node:crypto'

const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim()
const sql = (query) => docker('compose', 'exec', '-T', 'postgres', 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'minifoundry', '-c', query)
const env = JSON.parse(docker('inspect', 'minifoundry-auth-1'))[0].Config.Env
const secret = env.find((value) => value.startsWith('AUTH_SECRET=')).slice('AUTH_SECRET='.length)
assert(env.includes('MF_DEMO_MODE=false'), 'Run this check against the local shared-mode development stack')
const prefix = `rbac-check-${randomUUID()}`
const org = `${prefix}-org`
const otherOrg = `${prefix}-other`
const roles = ['owner', 'org_admin', 'access_manager', 'auditor', 'editor', 'viewer']
const users = roles.map((role) => ({ id: `${prefix}-${role}`, email: `${prefix}-${role}@example.invalid`, role }))
const tokenId = `${prefix}-token`
const jwt = (user) => {
  const now = Math.floor(Date.now() / 1000)
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  // Claiming admin must never override the membership stored in the database.
  const body = Buffer.from(JSON.stringify({ uid: user.id, email: user.email, name: 'RBAC check', role: 'admin', organizationId: org, iat: now, exp: now + 600 })).toString('base64url')
  return `${header}.${body}.${createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url')}`
}
const request = async (user, path, status, method = 'GET', body) => {
  const result = await fetch(`http://localhost:8080${path}`, {
    method, headers: { Authorization: `Bearer ${jwt(user)}`, 'Content-Type': 'application/json', 'x-mf-organization-role': 'owner' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const data = await result.json()
  assert.equal(result.status, status, `${user.role}: ${method} ${path}: ${data.error ?? result.status}`)
  return data
}
try {
  sql(`BEGIN; INSERT INTO auth.organizations (id,name,slug) VALUES ('${org}','RBAC check','${org}'),('${otherOrg}','Other RBAC check','${otherOrg}'); ${users.map((user) => `INSERT INTO auth.users (id,email,name,role,password_hash) VALUES ('${user.id}','${user.email}','RBAC check','viewer','unused'); INSERT INTO auth.organization_memberships (id,organization_id,user_id,role) VALUES ('${user.id}-membership','${org}','${user.id}','${user.role}');`).join(' ')} INSERT INTO auth.api_tokens (id,name,token_hash,prefix,organization_id) VALUES ('${tokenId}','${tokenId}','${createHash('sha256').update(tokenId).digest('hex')}','rbac-check','${otherOrg}'); COMMIT;`)
  for (const user of users) {
    const session = await request(user, '/api/session', 200)
    assert.equal(session.organizationRole, user.role)
    assert.equal(session.role, ['owner', 'org_admin'].includes(user.role) ? 'admin' : user.role === 'editor' ? 'editor' : 'viewer')
    await request(user, '/api/organization/members', ['owner', 'org_admin', 'access_manager', 'auditor'].includes(user.role) ? 200 : 403)
    await request(user, '/api/tokens', ['owner', 'org_admin'].includes(user.role) ? 200 : 403)
    await request(user, '/api/audit', ['owner', 'org_admin', 'auditor'].includes(user.role) ? 200 : 403)
    await request(user, '/api/users', 403)
    await request(user, '/api/session/role', 403, 'POST', { role: 'admin' })
  }
  const manager = users.find((user) => user.role === 'access_manager')
  const owner = users.find((user) => user.role === 'owner')
  const editor = users.find((user) => user.role === 'editor')
  sql(`INSERT INTO auth.api_request_logs (id,token_id,route,status,duration_ms) VALUES ('${prefix}-log','${tokenId}','/rbac-check',200,1);`)
  assert(!JSON.stringify(await request(owner, '/api/tokens/usage', 200)).includes(tokenId), 'Usage must exclude another organization’s tokens')
  await request(manager, '/api/organization/invitations', 201, 'POST', { email: `${prefix}-invite@example.invalid`, role: 'viewer' })
  await request(manager, '/api/organization/invitations', 403, 'POST', { email: `${prefix}-invite@example.invalid`, role: 'org_admin' })
  await request(manager, `/api/organization/members/${owner.id}`, 403, 'PATCH', { role: 'viewer' })
  await request(manager, `/api/organization/members/${users.find((user) => user.role === 'org_admin').id}`, 403, 'PATCH', { role: 'viewer' })
  await request(owner, `/api/organization/members/${owner.id}`, 403, 'PATCH', { role: 'editor' })
  await request(owner, `/api/tokens/${tokenId}`, 404, 'DELETE')
  await request(owner, `/api/organization/members/${editor.id}`, 200, 'PATCH', { role: 'viewer' })
  assert.equal((await request(editor, '/api/session', 200)).role, 'viewer', 'Demotion must apply immediately to old access tokens')
  // Check write guards before malformed request bodies are considered.
  await request(editor, '/api/pipelines', 403, 'POST', {})
  sql(`UPDATE auth.users SET is_active=false WHERE id='${editor.id}';`)
  await request(editor, '/api/organization/members', 401)
  console.log('RBAC integration checks passed for all six organization roles, spoofed headers, demotion, protected owners, and cross-organization token revocation.')
} finally {
  sql(`BEGIN; DELETE FROM auth.api_request_logs WHERE id='${prefix}-log'; DELETE FROM auth.api_tokens WHERE id='${tokenId}'; DELETE FROM auth.organization_invitations WHERE organization_id='${org}'; DELETE FROM auth.organization_memberships WHERE organization_id='${org}'; DELETE FROM auth.users WHERE id IN (${users.map((user) => `'${user.id}'`).join(',')}); DELETE FROM auth.organizations WHERE id IN ('${org}','${otherOrg}'); COMMIT;`)
}
