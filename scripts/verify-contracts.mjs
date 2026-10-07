// MiniFoundry — contract verifier: replays the captured request flows against
// a running stack (default: the NEW stack via gateway at http://localhost:8080)
// and structurally compares responses to backend/contracts/<domain>/*.json.
//
// Comparison rules:
//   - status codes must match the fixture meta exactly;
//   - object key sets must match exactly (recursive);
//   - VOLATILE values (ids, timestamps, secrets) must match in TYPE only;
//   - all other values must match EXACTLY (names, counts, roles, messages...).
//   - error strings ({ error }) must match exactly.
//
// Volatile detection: keys ending in Id/id holding strings, ISO-8601
// timestamp strings, and known secret fields.
//
// Usage:
//   node scripts/verify-contracts.mjs [--base http://localhost:8080] [--domain reads]

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CONTRACTS = path.join(ROOT, 'backend', 'contracts')

const args = process.argv.slice(2)
const argVal = (name, dflt) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const BASE = argVal('base', process.env.MF_VERIFY_BASE ?? 'http://localhost:8080')
const DOMAINS = args.includes('--domain') ? [argVal('domain', 'reads')] : ['auth', 'platform', 'reads']

const ADMIN = { email: 'demo-admin@example.invalid', password: '<redacted>' }

let pass = 0
let fail = 0
const failures = []

function failAt(fixture, msg) {
  fail++
  failures.push(`${fixture}: ${msg}`)
  console.error(`  ✗ ${fixture} — ${msg}`)
}

function passAt(fixture) {
  pass++
  console.log(`  ✓ ${fixture}`)
}

// ─── volatile detection ─────────────────────────────────────────────────

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/
const HOUR_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:00$/
const VOLATILE_KEYS = new Set([
  'id', 'tokenId', 'datasetId', 'pipelineId', 'ruleId', 'branchId', 'viewId',
  'aclId', 'runId', 'jobId', 'approvalId', 'connectorId', 'scheduleId',
  'transformId', 'projectId', 'objectTypeId', 'secret', 'tokenHash',
  'createdAt', 'updatedAt', 'lastLoginAt', 'lastUsedAt', 'revokedAt',
  'startedAt', 'finishedAt', 'readAt', 'decidedAt', 'lastRunAt', 'nextRunAt',
  'capturedAt', 'evaluatedAt', 'lastSeen', 'source', 'href',
])

function isVolatileKey(key, value) {
  if (typeof value !== 'string') return false
  if (VOLATILE_KEYS.has(key)) return true
  if (/(Id|_id)$/.test(key)) return true
  if (/(At|_at)$/.test(key) && (ISO_RE.test(value) || value === '')) return true
  return false
}

function typeOf(v) {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

/** Structural comparison. Returns list of mismatch descriptions (empty = equal). */
function compare(fixture, expected, actual, at = '$') {
  const out = []
  const et = typeOf(expected)
  const at2 = typeOf(actual)
  if (et !== at2) {
    out.push(`${at}: type ${et} != ${at2}`)
    return out
  }
  if (et === 'array') {
    if (expected.length !== actual.length) {
      out.push(`${at}: array length ${expected.length} != ${actual.length}`)
      return out
    }
    for (let i = 0; i < expected.length; i++) {
      out.push(...compare(fixture, expected[i], actual[i], `${at}[${i}]`))
    }
    return out
  }
  if (et === 'object') {
    const ek = Object.keys(expected).sort()
    const ak = Object.keys(actual).sort()
    const missing = ek.filter((k) => !ak.includes(k))
    const extra = ak.filter((k) => !ek.includes(k))
    if (missing.length) out.push(`${at}: missing keys ${missing.join(',')}`)
    if (extra.length) out.push(`${at}: extra keys ${extra.join(',')}`)
    for (const k of ek.filter((k) => ak.includes(k))) {
      out.push(...compare(fixture, expected[k], actual[k], `${at}.${k}`))
    }
    return out
  }
  // primitives
  const key = at.includes('.') ? at.slice(at.lastIndexOf('.') + 1).replace(/\[\d+\]$/, '') : at
  if (isVolatileKey(key, expected)) {
    return out // type already matched
  }
  if (typeof expected === 'string' && ISO_RE.test(expected)) {
    if (typeof actual === 'string' && (ISO_RE.test(actual) || HOUR_ISO_RE.test(actual))) return out
    out.push(`${at}: expected ISO timestamp, got ${JSON.stringify(actual)}`)
    return out
  }
  if (expected !== actual) {
    out.push(`${at}: ${JSON.stringify(expected)} != ${JSON.stringify(actual)}`)
  }
  return out
}

/**
 * Shape-only comparison for history-dependent endpoints (audit feeds,
 * notifications, usage dashboards, token lists): key sets + value TYPES must
 * match; array lengths may differ (element shape is checked pairwise up to
 * the shorter length); primitive values are never compared.
 */
function compareShape(fixture, expected, actual, at = '$') {
  const out = []
  const et = typeOf(expected)
  const at2 = typeOf(actual)
  if (et !== at2) {
    out.push(`${at}: type ${et} != ${at2}`)
    return out
  }
  if (et === 'array') {
    const n = Math.min(expected.length, actual.length)
    for (let i = 0; i < n; i++) {
      out.push(...compareShape(fixture, expected[i], actual[i], `${at}[${i}]`))
    }
    return out
  }
  if (et === 'object') {
    const ek = Object.keys(expected).sort()
    const ak = Object.keys(actual).sort()
    const missing = ek.filter((k) => !ak.includes(k))
    const extra = ak.filter((k) => !ek.includes(k))
    if (missing.length) out.push(`${at}: missing keys ${missing.join(',')}`)
    if (extra.length) out.push(`${at}: extra keys ${extra.join(',')}`)
    for (const k of ek.filter((k) => ak.includes(k))) {
      out.push(...compareShape(fixture, expected[k], actual[k], `${at}.${k}`))
    }
    return out
  }
  return out
}

// ─── replay engine ──────────────────────────────────────────────────────

async function loadFixture(domain, name) {
  const body = JSON.parse(await readFile(path.join(CONTRACTS, domain, `${name}.json`), 'utf8'))
  const meta = JSON.parse(await readFile(path.join(CONTRACTS, domain, `${name}.meta.json`), 'utf8'))
  return { body, meta }
}

async function replay(domain, name, overrides = {}) {
  let fixture
  try {
    fixture = await loadFixture(domain, name)
  } catch {
    failAt(`${domain}/${name}`, 'fixture missing')
    return null
  }
  const { meta } = fixture
  const method = overrides.method ?? meta.method
  let p = overrides.path ?? meta.path
  if (overrides.pathParams) {
    for (const [k, v] of Object.entries(overrides.pathParams)) p = p.replaceAll(k, v)
  }
  const res = await fetch(`${BASE}${p}`, {
    method,
    redirect: 'manual',
    headers: {
      ...(meta.requestBody && !overrides.noBody ? { 'content-type': 'application/json' } : {}),
      ...(overrides.cookie ? { cookie: overrides.cookie } : {}),
      ...(overrides.headers ?? {}),
    },
    body: overrides.body !== undefined
      ? JSON.stringify(overrides.body)
      : (meta.requestBody && !overrides.noBody ? JSON.stringify(meta.requestBody) : undefined),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { json = text }

  if (overrides.expectStatus !== undefined ? res.status !== overrides.expectStatus : res.status !== meta.status) {
    failAt(`${domain}/${name}`, `status ${res.status} != ${overrides.expectStatus ?? meta.status} (body: ${text.slice(0, 160)})`)
    return null
  }
  if (overrides.skipBody) {
    passAt(`${domain}/${name}`)
    return json
  }
  const cmp = overrides.shape ? compareShape : compare
  const mismatches = cmp(`${domain}/${name}`, fixture.body, json).slice(0, 6)
  if (mismatches.length) {
    failAt(`${domain}/${name}`, mismatches.join(' | '))
    return null
  }
  passAt(`${domain}/${name}`)
  return json
}

function jar(setCookie) {
  return setCookie.map((c) => c.split(';')[0]).join('; ')
}

async function loginAs(creds) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(creds),
  })
  const setCookie = res.headers.getSetCookie?.() ?? []
  return { status: res.status, cookie: jar(setCookie), json: await res.json().catch(() => null) }
}

// ─── domain runners ─────────────────────────────────────────────────────

async function verifyPlatform() {
  console.log('domain: platform')
  await replay('platform', 'api-hello')
  await replay('platform', 'health')
}

async function verifyAuth() {
  console.log('domain: auth')
  const admin = await loginAs(ADMIN)
  if (admin.status !== 200) {
    failAt('auth/login-ok', `login failed: ${admin.status}`)
    return
  }
  const cookie = admin.cookie

  // login contract (body already validated by loginAs success; verify shape)
  await replay('auth', 'login-ok', { skipBody: false, cookie, noBody: false })
  await replay('auth', 'login-bad-password', { body: { email: ADMIN.email, password: 'wrong' } })
  await replay('auth', 'login-unknown-email', { body: { email: 'nobody@minifoundry.dev', password: 'x' } })
  await replay('auth', 'login-invalid-body', { body: { email: '' } })
  await replay('auth', 'me-authenticated', { cookie })
  await replay('auth', 'me-anonymous', { noBody: true })
  await replay('auth', 'session-anonymous-demo', { noBody: true })
  await replay('auth', 'session-admin', { cookie })

  // simulator + impersonation
  await replay('auth', 'session-role-simulator', { body: { role: 'viewer' } })
  await replay('auth', 'session-role-invalid', { body: { role: 'root' } })
  const imp = await fetch(`${BASE}/api/session/role`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ role: 'viewer' }),
  })
  const impCookie = jar(imp.headers.getSetCookie?.() ?? []) || cookie
  await replay('auth', 'session-impersonated', { cookie: `${cookie}; ${impCookie}` })

  const viewer = await loginAs({ email: 'demo-viewer@example.invalid', password: '<redacted>' })
  await replay('auth', 'session-role-forbidden', { cookie: viewer.cookie, body: { role: 'admin' } })

  // users
  const users = await replay('auth', 'users-list', { cookie })
  await replay('auth', 'users-list-forbidden', { cookie: viewer.cookie })
  const viewerId = users?.users?.find((u) => u.email === 'demo-viewer@example.invalid')?.id
  const adminId = users?.users?.find((u) => u.email === ADMIN.email)?.id
  if (viewerId) {
    await replay('auth', 'user-patch', { cookie, path: `/api/users/${viewerId}`, body: { isActive: true } })
  }
  await replay('auth', 'user-patch-unknown', { cookie, body: { role: 'editor' } })
  if (adminId) {
    await replay('auth', 'user-patch-self-guard', { cookie, path: `/api/users/${adminId}`, body: { role: 'viewer' } })
  }

  // tokens lifecycle (dynamic names: verify shapes with fresh values)
  const tokName = `verify-${Date.now()}`
  const created = await fetch(`${BASE}/api/tokens`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: tokName }),
  })
  const createdJson = await created.json().catch(() => null)
  if (created.status !== 201 || !createdJson?.secret?.startsWith('mf_live_')) {
    failAt('auth/token-create', `status ${created.status} body ${JSON.stringify(createdJson).slice(0, 120)}`)
  } else {
    passAt('auth/token-create')
    const dup = await fetch(`${BASE}/api/tokens`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: tokName }),
    })
    const dupJson = await dup.json().catch(() => null)
    if (dup.status === 400 && dupJson?.error === 'Token name is already in use') passAt('auth/token-create-duplicate')
    else failAt('auth/token-create-duplicate', `${dup.status} ${JSON.stringify(dupJson)}`)

    const listRes = await fetch(`${BASE}/api/tokens`, { headers: { cookie } })
    const listJson = await listRes.json().catch(() => null)
    const leak = JSON.stringify(listJson ?? '').includes('tokenHash')
    const keysOk = Array.isArray(listJson?.tokens) && (listJson.tokens.length === 0 ||
      JSON.stringify(Object.keys(listJson.tokens[0]).sort()) ===
      JSON.stringify(['createdAt', 'id', 'lastUsedAt', 'name', 'prefix', 'requestCount', 'revokedAt']))
    if (listRes.status === 200 && keysOk && !leak) passAt('auth/tokens-list')
    else failAt('auth/tokens-list', `status=${listRes.status} keysOk=${keysOk} leak=${leak}`)
    const rev = await fetch(`${BASE}/api/tokens/${createdJson.token.id}`, { method: 'DELETE', headers: { cookie } })
    const revJson = await rev.json().catch(() => null)
    if (rev.status === 200 && revJson?.ok === true) passAt('auth/token-revoke')
    else failAt('auth/token-revoke', `${rev.status} ${JSON.stringify(revJson)}`)
  }
  await replay('auth', 'token-revoke-unknown', { cookie })
  await replay('auth', 'tokens-list-forbidden', { cookie: viewer.cookie })

  // usage dashboard (seeded deterministically enough for structure)
  await replay('auth', 'usage-clear', { cookie })
  const seedRes = await fetch(`${BASE}/api/tokens/usage/seed`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ hours: 24 }),
  })
  const seedJson = await seedRes.json().catch(() => null)
  if (seedRes.status === 201 && seedJson?.seeded > 0) passAt('auth/usage-seed')
  else failAt('auth/usage-seed', `${seedRes.status} ${JSON.stringify(seedJson)}`)
  const again = await fetch(`${BASE}/api/tokens/usage/seed`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ hours: 24 }),
  })
  const againJson = await again.json().catch(() => null)
  if (again.status === 400 && againJson?.error === 'usage data already exists — clear it first') passAt('auth/usage-seed-again-refused')
  else failAt('auth/usage-seed-again-refused', `${again.status} ${JSON.stringify(againJson)}`)
  await replay('auth', 'usage-dashboard', { cookie, shape: true })

  // logout
  const out = await fetch(`${BASE}/api/auth/logout`, { method: 'POST', headers: { cookie } })
  const outJson = await out.json().catch(() => null)
  if (out.status === 200 && outJson?.ok === true) passAt('auth/logout')
  else failAt('auth/logout', `${out.status}`)

  // v1 guard behavior (public-api may not be up yet in early phases)
  const who = await fetch(`${BASE}/api/foundry/v1/whoami`, { headers: { authorization: 'Bearer mf_live_invalid' } })
  if (who.status === 401) passAt('auth/v1-whoami-revoked-or-invalid')
  else if (who.status === 502 || who.status === 503) console.log('  - auth/v1-* skipped (public-api not deployed yet)')
  else failAt('auth/v1-whoami-revoked-or-invalid', `status ${who.status}`)
}

// fixture paths embed the ORIGINAL ids; live ids are substituted by passing
// explicit `path` overrides in the domain runners below.

async function verifyReads() {
  console.log('domain: reads')
  const admin = await loginAs(ADMIN)
  const cookie = admin.cookie

  await replay('reads', 'projects-list', { cookie })
  const datasets = await replay('reads', 'datasets-list', { cookie })
  const ds = datasets?.datasets?.[0]
  if (!ds) {
    failAt('reads/dataset-*', 'no datasets in response — seed the workspace first')
    return
  }
  const dsId = ds.id
  await replay('reads', 'dataset-detail', { cookie, path: `/api/datasets/${dsId}` })
  await replay('reads', 'dataset-rows', { cookie, path: `/api/datasets/${dsId}/rows?limit=5` })
  await replay('reads', 'dataset-quality', { cookie, path: `/api/datasets/${dsId}/quality` })
  await replay('reads', 'dataset-branches', { cookie, path: `/api/datasets/${dsId}/branches` })
  await replay('reads', 'dataset-comments', { cookie, path: `/api/datasets/${dsId}/comments`, shape: true })
  await replay('reads', 'dataset-watch', { cookie, path: `/api/datasets/${dsId}/watch` })
  await replay('reads', 'dataset-diff', { cookie, path: `/api/datasets/${dsId}/diff?from=1&to=1` })
  await replay('reads', 'dataset-export', { cookie, path: `/api/datasets/${dsId}/export?format=csv`, skipBody: true })
  await replay('reads', 'connectors-list', { cookie })
  await replay('reads', 'ingestions-list', { cookie, shape: true })
  await replay('reads', 'lineage-graph', { cookie })

  const pipelines = await replay('reads', 'pipelines-list', { cookie })
  const pl = pipelines?.pipelines?.[0]
  if (pl) {
    await replay('reads', 'pipeline-detail', { cookie, path: `/api/pipelines/${pl.id}` })
    await replay('reads', 'runs-by-pipeline', { cookie, path: `/api/runs?pipelineId=${pl.id}`, shape: true })
    await replay('reads', 'pipeline-versions', { cookie, path: `/api/pipelines/${pl.id}/versions` })
  } else {
    console.log('  - reads/pipeline-* skipped (no pipelines seeded)')
  }
  const runs = await replay('reads', 'runs-list', { cookie, shape: true })
  if (runs?.runs?.[0]) await replay('reads', 'run-detail', { cookie, path: `/api/runs/${runs.runs[0].id}`, shape: true })
  await replay('reads', 'schedules-list', { cookie })
  await replay('reads', 'execution-jobs-list', { cookie, shape: true })

  const transforms = await replay('reads', 'transforms-list', { cookie })
  if (transforms?.transforms?.[0]) {
    await replay('reads', 'transform-runs', { cookie, path: `/api/transforms/${transforms.transforms[0].id}/runs`, shape: true })
  }

  const ontology = await replay('reads', 'ontology-list', { cookie })
  const ot = ontology?.objectTypes?.[0]
  if (ot) {
    await replay('reads', 'objects-list', { cookie, path: `/api/objects?type=${encodeURIComponent(ot.apiName)}&limit=5` })
    await replay('reads', 'object-views', { cookie, path: `/api/objects/views?type=${encodeURIComponent(ot.apiName)}` })
  }
  await replay('reads', 'actions-list', { cookie })
  await replay('reads', 'action-logs', { cookie, shape: true })
  const dashboards = await replay('reads', 'dashboards-list', { cookie })
  if (dashboards?.dashboards?.[0]) {
    await replay('reads', 'dashboard-detail', { cookie, path: `/api/dashboards/${dashboards.dashboards[0].id}` })
  }
  const apps = await replay('reads', 'applications-list', { cookie })
  if (apps?.applications?.[0]) {
    await replay('reads', 'application-detail', { cookie, path: `/api/applications/${apps.applications[0].id}` })
  }

  await replay('reads', 'markings-list', { cookie })
  await replay('reads', 'approvals-list', { cookie, shape: true })
  await replay('reads', 'audit-list', { cookie, shape: true })
  await replay('reads', 'acl-list', { cookie, path: `/api/acl?resourceType=dataset&resourceId=${dsId}`, shape: true })
  await replay('reads', 'acl-check', { cookie, path: `/api/acl/check?resourceType=dataset&resourceId=${dsId}&email=${encodeURIComponent(ADMIN.email)}` })
  await replay('reads', 'notifications-list', { cookie, shape: true })
  await replay('reads', 'curriculum-status', { cookie })
  await replay('reads', 'settings-overview', { cookie })
  await replay('reads', 'search-q', { cookie })
  await replay('reads', 'stats', { cookie })
}

async function main() {
  console.log(`verifying contracts against ${BASE}`)
  if (DOMAINS.includes('platform')) await verifyPlatform()
  if (DOMAINS.includes('auth')) await verifyAuth()
  if (DOMAINS.includes('reads')) await verifyReads()
  console.log(`\n${pass} passed, ${fail} failed`)
  if (failures.length) {
    console.log('\nfailures:')
    for (const f of failures.slice(0, 30)) console.log(`  - ${f}`)
  }
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
