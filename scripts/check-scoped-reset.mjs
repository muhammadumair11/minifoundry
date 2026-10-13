// Reset ONLY the disposable Integration Isolation Control organization, verify the
// primary Integration organization stays intact, then reseed the control separately.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { base, password, fixtureEmail } from './test-config.mjs'
async function login(role) {
  const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: fixtureEmail(role), password }) })
  assert.equal(response.status, 200)
  return response.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; ')
}
async function get(cookie, path) {
  const response = await fetch(base + path, { headers: { cookie } })
  assert.equal(response.status, 200, path)
  return response.json()
}
const owner = await login('owner'), control = await login('isolation')
const ownerOrg = (await get(owner, '/api/session')).organizationId
const controlOrg = (await get(control, '/api/session')).organizationId
assert.match(controlOrg, /^[a-f0-9-]{36}$/)
assert.notEqual(ownerOrg, controlOrg)
const resources = [['/api/projects', 'projects'], ['/api/datasets', 'datasets'], ['/api/pipelines', 'pipelines'], ['/api/transforms', 'transforms'], ['/api/ontology', 'objectTypes'], ['/api/applications', 'applications'], ['/api/tokens', 'tokens']]
const before = []
for (const [path, key] of resources) before.push((await get(owner, path))[key].map((item) => item.id).sort())
for (const [service, port] of [['catalog', 8082], ['orchestration', 8083], ['compute', 8084], ['ontology', 8085], ['governance', 8086], ['auth', 8081]]) {
  // Credentials remain inside their existing container environment. They are
  // never read into this process, printed, written to disk or put in argv.
  const unscoped = execFileSync('docker', ['compose', 'exec', '-T', service, 'sh', '-c', `curl -sS -o /dev/null -w '%{http_code}' -H "x-service-token: $MF_SERVICE_TOKEN" http://localhost:${port}/internal/stats`], { encoding: 'utf8' })
  assert.equal(unscoped, '403', `${service} rejects missing organization`)
  const result = execFileSync('docker', ['compose', 'exec', '-T', service, 'sh', '-c', `curl -fsS -X POST -H "x-service-token: $MF_SERVICE_TOKEN" -H "x-mf-organization-id: ${controlOrg}" http://localhost:${port}/internal/reset`], { encoding: 'utf8' })
  assert.ok(JSON.parse(result), `${service} reset response`)
  console.log(`PASS ${service} rejects unscoped calls and resets only the control organization`)
}
for (const [index, [path, key]] of resources.entries()) {
  assert.deepEqual((await get(owner, path))[key].map((item) => item.id).sort(), before[index], `primary Integration survives ${path}`)
  assert.deepEqual((await get(control, path))[key], [], `control reset ${path}`)
}
assert.equal((await get(owner, '/api/settings/overview')).users, 6)
assert.equal((await get(control, '/api/settings/overview')).users, 1)
console.log('PASS every primary Integration resource and all organization memberships survived the scoped reset')
