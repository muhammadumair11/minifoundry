// Local signup regression. Creates two isolated temporary owners, then removes
// only those exact accounts/organizations; existing Integration memberships survive.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { base, password } from './test-config.mjs'
const sql = command => execFileSync('docker', ['compose', 'exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'minifoundry', '-At', '-v', 'ON_ERROR_STOP=1', '-c', command], { encoding: 'utf8' }).trim()
const before = sql('SELECT count(*) FROM auth.users')
const nonce = Date.now()
const temporary = []
try {
  for (const index of [1, 2]) {
    const email = `integration.signup.${nonce}.${index}@example.test`
    const name = `Integration Signup Regression ${nonce} ${index}`
    const response = await fetch(base + '/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, name: 'Integration temporary signup', organizationName: name }) })
    assert.equal(response.status, 201, `consecutive signup ${index}`)
    const cookie = response.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
    const sessionResponse = await fetch(base + '/api/session', { headers: { cookie } })
    assert.equal(sessionResponse.status, 200)
    const session = await sessionResponse.json()
    assert.match(session.organizationId, /^[a-f0-9-]{36}$/)
    temporary.push({ id: session.organizationId, email, name })
  }
  assert.notEqual(temporary[0].id, temporary[1].id)
  const ids = temporary.map(item => `'${item.id}'`).join(',')
  assert.equal(sql(`SELECT bool_and(slug = 'org-' || id) FROM auth.organizations WHERE id IN (${ids})`), 't')
  console.log(`PASS rapid consecutive signups use unique full-UUID slugs (shared timestamp prefix: ${temporary[0].id.slice(0, 8) === temporary[1].id.slice(0, 8)})`)
} finally {
  for (const item of temporary) {
    // The service credential remains inside the container and is never logged.
    execFileSync('docker', ['compose', 'exec', '-T', 'governance', 'sh', '-c', `curl -fsS -X POST -H "x-service-token: $MF_SERVICE_TOKEN" -H "x-mf-organization-id: ${item.id}" http://localhost:8086/internal/reset`], { encoding: 'utf8' })
    sql(`BEGIN; DELETE FROM auth.users WHERE email = '${item.email}' AND default_organization_id = '${item.id}'; DELETE FROM auth.organizations WHERE id = '${item.id}' AND name = '${item.name}'; COMMIT;`)
  }
  assert.equal(sql('SELECT count(*) FROM auth.users'), before, 'temporary signup cleanup must preserve existing accounts')
  console.log('PASS temporary signup accounts removed; existing Integration accounts preserved')
}
