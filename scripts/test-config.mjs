// Configuration shared by the local organization integration checks.
import assert from 'node:assert/strict'

export const base = process.env.BASE_URL ?? 'http://localhost:3000'
assert.match(base, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/, 'Integration checks require a local test stack')
export const fixtureNamespace = process.env.TEST_NAMESPACE ?? 'minifoundry-integration'
assert.match(fixtureNamespace, /^[a-z0-9-]{1,64}$/, 'TEST_NAMESPACE must contain lowercase letters, numbers or hyphens')
export const password = process.env.TEST_PASSWORD
assert.ok(password, 'Set TEST_PASSWORD for the disposable integration accounts; see docs/testing.md')
export const fixtureEmail = role => `${fixtureNamespace}.${role}@example.test`
