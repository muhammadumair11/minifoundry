// Regression check: real password authentication must preserve organization roles.
// Uses unique local fixtures and removes only those fixtures in finally.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const sql = (query) => execFileSync('docker', ['compose', 'exec', '-T', 'postgres', 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'minifoundry', '-c', query], { encoding: 'utf8' })
const prefix = `auth-role-check-${randomUUID()}`
const email = `${prefix}@example.invalid`
const invitedEmail = `${prefix}-invited@example.invalid`
const password = randomUUID()
const cookies = new Map()
const orgs = []
const request = async (path, method = 'GET', body, status = 200) => {
  const response = await fetch(`http://localhost:3000${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(';')[0]
    const separator = pair.indexOf('=')
    const key = pair.slice(0, separator)
    const value = pair.slice(separator + 1)
    if (value) cookies.set(key, value)
    else cookies.delete(key)
  }
  const data = await response.json()
  assert.equal(response.status, status, `${method} ${path}: ${data.error ?? response.status}`)
  return data
}
const checkUser = (user, role, org) => {
  assert.equal(user.organizationRole, role, 'Identity must expose the actual organization role, not only the legacy platform role')
  assert.equal(user.organizationId, org)
  assert.equal(user.role, ['owner', 'org_admin'].includes(role) ? 'admin' : role === 'editor' ? 'editor' : 'viewer')
  assert(!('password' in user) && !('passwordHash' in user))
}
try {
  const signup = await request('/api/auth/signup', 'POST', { organizationName: prefix, name: 'Auth role check', email, password }, 201)
  const { organizations } = await request('/api/organizations')
  const org = organizations.find((value) => value.name === prefix).id
  orgs.push(org)
  checkUser(signup.user, 'owner', org)
  const roles = ['owner', 'org_admin', 'access_manager', 'auditor', 'editor', 'viewer']
  for (const role of roles) {
    // Change only this test account's membership to cover every role with real passwords.
    sql(`UPDATE auth.organization_memberships SET role='${role}' WHERE user_id='${signup.user.id}' AND organization_id='${org}';`)
    await request('/api/auth/logout', 'POST')
    cookies.clear()
    const login = await request('/api/auth/login', 'POST', { email, password })
    checkUser(login.user, role, org)
    checkUser((await request('/api/auth/me')).user, role, org)
    const session = await request('/api/session')
    assert.equal(session.organizationRole, role)
    assert.equal(session.organizationId, org)
    // Drop the access cookie to exercise transparent refresh without waiting 15 minutes.
    cookies.delete('foundry-session')
    const refreshed = await request('/api/session')
    assert.equal(refreshed.organizationRole, role, 'Refresh must preserve the membership role')
    assert(cookies.has('foundry-session'), 'Refresh must issue a replacement access cookie')
    checkUser((await request('/api/auth/me')).user, role, org)
  }
  // Switching organizations must preserve the selection on the next password login.
  const secondOrg = `${prefix}-second`
  orgs.push(secondOrg)
  sql(`BEGIN; INSERT INTO auth.organizations (id,name,slug) VALUES ('${secondOrg}','Other auth role check','${secondOrg}'); INSERT INTO auth.organization_memberships (id,organization_id,user_id,role) VALUES ('${prefix}-second-membership','${secondOrg}','${signup.user.id}','owner'); COMMIT;`)
  await request('/api/session/organization', 'POST', { organizationId: secondOrg })
  checkUser((await request('/api/auth/me')).user, 'owner', secondOrg)
  await request('/api/auth/logout', 'POST')
  cookies.clear()
  checkUser((await request('/api/auth/login', 'POST', { email, password })).user, 'owner', secondOrg)
  assert.equal((await request('/api/session')).organizationRole, 'owner')
  const { invitation } = await request('/api/organization/invitations', 'POST', { email: invitedEmail, role: 'viewer' }, 201)
  await request('/api/auth/logout', 'POST')
  cookies.clear()
  const token = invitation.acceptUrl.split('/').at(-1)
  checkUser((await request(`/api/invitations/${token}/accept`, 'POST', { name: 'Invited auth role check', password }, 201)).user, 'viewer', secondOrg)
  checkUser((await request('/api/auth/me')).user, 'viewer', secondOrg)
  await request('/api/auth/logout', 'POST')
  cookies.clear()
  checkUser((await request('/api/auth/login', 'POST', { email: invitedEmail, password })).user, 'viewer', secondOrg)
  console.log('Auth role checks passed: signup, password signin for all six roles, identity, refresh, organization selection across signin, and invited accounts.')
} finally {
  // No production/user accounts are touched. Keep credentials and cookies in memory only.
  sql(`BEGIN; DELETE FROM auth.refresh_tokens WHERE user_id IN (SELECT id FROM auth.users WHERE email IN ('${email}','${invitedEmail}')); DELETE FROM auth.organization_invitations WHERE email='${invitedEmail}'; DELETE FROM auth.organization_memberships WHERE user_id IN (SELECT id FROM auth.users WHERE email IN ('${email}','${invitedEmail}')); DELETE FROM auth.users WHERE email IN ('${email}','${invitedEmail}'); ${orgs.length ? `DELETE FROM auth.organizations WHERE id IN (${orgs.map((id) => `'${id}'`).join(',')});` : ''} DELETE FROM governance.audit_entries WHERE actor_email IN ('${email}','${invitedEmail}'); COMMIT;`)
}
