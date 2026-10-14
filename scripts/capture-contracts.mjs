import { demoPassword } from './demo-credentials.mjs'
// MiniFoundry golden contract capture.
//
// Exercises the LEGACY Next.js API (default http://localhost:3000) and writes
// response fixtures into backend/contracts/<domain>/. The Rust services'
// verification harness replays calls against the current stack and checks
// structural equality with these fixtures (see backend/contracts/README.md).
//
// Usage: node scripts/capture-contracts.mjs [--domain auth] [--base http://localhost:3000]

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_ROOT = path.join(ROOT, 'backend', 'contracts')

const args = process.argv.slice(2)
const argVal = (name, dflt) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const BASE = argVal('base', process.env.LEGACY_BASE ?? 'http://localhost:3000')
const DOMAINS = args.includes('--domain')
  ? [argVal('domain', 'auth')]
  : ['auth', 'platform', 'reads']

const ADMIN = { email: 'demo-admin@example.invalid', password: demoPassword }
const VIEWER = { email: 'demo-viewer@example.invalid', password: demoPassword }

let failures = 0

// Keep live credentials available to the running journey, but never persist
// them in fixture responses or request metadata.
function redactCredentials(value) {
  if (Array.isArray(value)) return value.map(redactCredentials)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      /^(secret|password|currentPassword|newPassword|passwordHash|tokenHash|accessToken|refreshToken|invitationToken)$/i.test(key)
        ? '<redacted>'
        : redactCredentials(item),
    ]))
  }
  return typeof value === 'string'
    ? value.replace(/mf_live_[a-f0-9]{48}/g, '<redacted>')
    : value
}

/** One capture step: perform a request, save body + metadata as fixtures. */
async function capture(domain, name, spec) {
  const { method = 'GET', path: p, body, cookie, headers = {}, expectStatus } = spec
  const res = await fetch(`${BASE}${p}`, {
    method,
    redirect: 'manual',
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* non-JSON body kept as text */ }

  const setCookie = res.headers.getSetCookie?.() ?? []
  const meta = {
    method,
    path: p,
    status: res.status,
    requestBody: body ?? null,
    // Cookie NAMES only (values are volatile secrets).
    setCookieNames: setCookie.map((c) => c.split('=')[0]),
    capturedAt: new Date().toISOString(),
    source: BASE,
  }
  if (expectStatus !== undefined && res.status !== expectStatus) {
    console.error(`  !! ${domain}/${name}: expected status ${expectStatus}, got ${res.status}`)
    failures++
  }
  const dir = path.join(OUT_ROOT, domain)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, `${name}.json`), JSON.stringify(redactCredentials(json ?? text), null, 2))
  await writeFile(path.join(dir, `${name}.meta.json`), JSON.stringify(redactCredentials(meta), null, 2))
  console.log(`  ✓ ${domain}/${name} — ${method} ${p} → ${res.status}`)
  return { status: res.status, json, setCookie, text }
}

function cookieJar(setCookie, name) {
  const entry = setCookie.find((c) => c.startsWith(`${name}=`))
  return entry ? entry.split(';')[0] : null
}

async function waitForServer(timeoutMs = 120_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(5000) })
      if (res.ok) return
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error(`legacy server at ${BASE} did not become ready`)
}

// ─── auth domain ─────────────────────────────────────────────────────────

async function captureAuth() {
  console.log('domain: auth')

  // 1. happy login (admin)
  const login = await capture('auth', 'login-ok', {
    method: 'POST', path: '/api/auth/login', body: ADMIN, expectStatus: 200,
  })
  const adminCookie = login.setCookie.map((c) => c.split(';')[0]).join('; ')
  const sessionCookie = cookieJar(login.setCookie, 'foundry-session')

  // 2. wrong password → 401 exact message
  await capture('auth', 'login-bad-password', {
    method: 'POST', path: '/api/auth/login',
    body: { email: ADMIN.email, password: 'wrong' }, expectStatus: 401,
  })

  // 3. unknown email → same 401 (no enumeration)
  await capture('auth', 'login-unknown-email', {
    method: 'POST', path: '/api/auth/login',
    body: { email: 'nobody@minifoundry.dev', password: 'x' }, expectStatus: 401,
  })

  // 4. invalid body → 400
  await capture('auth', 'login-invalid-body', {
    method: 'POST', path: '/api/auth/login', body: { email: '' }, expectStatus: 400,
  })

  // 5. me — authenticated
  await capture('auth', 'me-authenticated', {
    path: '/api/auth/me', cookie: adminCookie, expectStatus: 200,
  })

  // 6. me — anonymous (demo mode)
  await capture('auth', 'me-anonymous', { path: '/api/auth/me', expectStatus: 200 })

  // 7. session — anonymous demo (admin fallback, null session)
  await capture('auth', 'session-anonymous-demo', { path: '/api/session', expectStatus: 200 })

  // 8. session — real admin session
  await capture('auth', 'session-admin', {
    path: '/api/session', cookie: adminCookie, expectStatus: 200,
  })

  // 9. session/role — anonymous simulator switch
  await capture('auth', 'session-role-simulator', {
    method: 'POST', path: '/api/session/role', body: { role: 'viewer' }, expectStatus: 200,
  })

  // 10. session/role — invalid role
  await capture('auth', 'session-role-invalid', {
    method: 'POST', path: '/api/session/role', body: { role: 'root' }, expectStatus: 400,
  })

  // 11. session/role — admin impersonation (real session)
  const impersonate = await capture('auth', 'session-role-impersonate', {
    method: 'POST', path: '/api/session/role', body: { role: 'viewer' },
    cookie: adminCookie, expectStatus: 200,
  })
  const impersonatedCookie = impersonate.setCookie.length
    ? impersonate.setCookie.map((c) => c.split(';')[0]).join('; ')
    : adminCookie

  // 12. session as impersonated admin (effectiveRole viewer, real admin)
  await capture('auth', 'session-impersonated', {
    path: '/api/session', cookie: impersonatedCookie, expectStatus: 200,
  })

  // 13. viewer session cannot switch roles → 403
  const viewerLogin = await capture('auth', 'login-viewer', {
    method: 'POST', path: '/api/auth/login', body: VIEWER, expectStatus: 200,
  })
  const viewerCookie = viewerLogin.setCookie.map((c) => c.split(';')[0]).join('; ')
  await capture('auth', 'session-role-forbidden', {
    method: 'POST', path: '/api/session/role', body: { role: 'admin' },
    cookie: viewerCookie, expectStatus: 403,
  })

  // 14. users list (admin)
  const users = await capture('auth', 'users-list', {
    path: '/api/users', cookie: adminCookie, expectStatus: 200,
  })

  // 15. users list (viewer) → 403 exact guard message
  await capture('auth', 'users-list-forbidden', {
    path: '/api/users', cookie: viewerCookie, expectStatus: 403,
  })

  // 16. patch a user (admin changes viewer's isActive — then restores)
  const viewerId = users.json?.users?.find((u) => u.email === VIEWER.email)?.id
  if (viewerId) {
    await capture('auth', 'user-patch', {
      method: 'PATCH', path: `/api/users/${viewerId}`,
      body: { isActive: true }, cookie: adminCookie, expectStatus: 200,
    })
    // 17. unknown user → 404 exact message
    await capture('auth', 'user-patch-unknown', {
      method: 'PATCH', path: '/api/users/does-not-exist',
      body: { role: 'editor' }, cookie: adminCookie, expectStatus: 404,
    })
  }

  // 18. self-demotion guard: admin patches own role → 400
  const adminId = users.json?.users?.find((u) => u.email === ADMIN.email)?.id
  if (adminId) {
    await capture('auth', 'user-patch-self-guard', {
      method: 'PATCH', path: `/api/users/${adminId}`,
      body: { role: 'viewer' }, cookie: adminCookie, expectStatus: 400,
    })
  }

  // 19. tokens: create → list → revoke lifecycle
  const stamp = Date.now()
  const created = await capture('auth', 'token-create', {
    method: 'POST', path: '/api/tokens',
    body: { name: `contract-capture-${stamp}` }, cookie: adminCookie, expectStatus: 201,
  })
  await capture('auth', 'token-create-duplicate', {
    method: 'POST', path: '/api/tokens',
    body: { name: `contract-capture-${stamp}` }, cookie: adminCookie, expectStatus: 400,
  })
  await capture('auth', 'tokens-list', {
    path: '/api/tokens', cookie: adminCookie, expectStatus: 200,
  })
  const tokenId = created.json?.token?.id
  if (tokenId) {
    await capture('auth', 'token-revoke', {
      method: 'DELETE', path: `/api/tokens/${tokenId}`,
      cookie: adminCookie, expectStatus: 200,
    })
    await capture('auth', 'token-revoke-unknown', {
      method: 'DELETE', path: '/api/tokens/does-not-exist',
      cookie: adminCookie, expectStatus: 404,
    })
  }
  await capture('auth', 'tokens-list-forbidden', {
    path: '/api/tokens', cookie: viewerCookie, expectStatus: 403,
  })

  // 20. usage dashboard: (fresh ACTIVE token exists) clear → seed → seed
  //     again (valve) → aggregate. The v1 token is created FIRST because the
  //     seeder refuses without an active token.
  const v1Token = await capture('auth', 'v1-token-create', {
    method: 'POST', path: '/api/tokens',
    body: { name: `contract-v1-${Date.now()}` }, cookie: adminCookie, expectStatus: 201,
  })
  await capture('auth', 'usage-clear', {
    method: 'DELETE', path: '/api/tokens/usage', cookie: adminCookie, expectStatus: 200,
  })
  await capture('auth', 'usage-seed', {
    method: 'POST', path: '/api/tokens/usage/seed',
    body: { hours: 24 }, cookie: adminCookie, expectStatus: 201,
  })
  await capture('auth', 'usage-seed-again-refused', {
    method: 'POST', path: '/api/tokens/usage/seed',
    body: { hours: 24 }, cookie: adminCookie, expectStatus: 400,
  })
  await capture('auth', 'usage-dashboard', {
    path: '/api/tokens/usage', cookie: adminCookie, expectStatus: 200,
  })

  // 21. logout clears cookies
  await capture('auth', 'logout', {
    method: 'POST', path: '/api/auth/logout', cookie: adminCookie, expectStatus: 200,
  })

  // 22. public API (foundry/v1) guard behavior — token-auth surface.
  const secret = v1Token.json?.secret
  if (secret) {
    await capture('auth', 'v1-whoami-token', {
      path: '/api/foundry/v1/whoami',
      headers: { authorization: `Bearer ${secret}` },
      expectStatus: 200,
    })
  }
  await capture('auth', 'v1-whoami-revoked-or-invalid', {
    path: '/api/foundry/v1/whoami',
    headers: { authorization: 'Bearer mf_live_invalid' },
    expectStatus: 401,
  })
  await capture('auth', 'v1-whoami-missing', {
    path: '/api/foundry/v1/whoami', expectStatus: 401,
  })

  if (sessionCookie) {
    console.log(`  (session cookie captured for reuse; ${sessionCookie.length} chars)`)
  }
}

// ─── platform domain (gateway-owned + cross-service basics) ─────────────

async function capturePlatform() {
  console.log('domain: platform')
  await capture('platform', 'api-hello', { path: '/api', expectStatus: 200 })
  await capture('platform', 'health', { path: '/api/health', expectStatus: 200 })
}

// ─── reads domain: GET shapes of every list/detail endpoint ─────────────
// Read-only — safe against any workspace state. Ids are picked dynamically
// from the list responses; endpoints whose entity is missing are skipped.

async function captureReads() {
  console.log('domain: reads')
  const adminLogin = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ADMIN),
  })
  const setCookie = adminLogin.headers.getSetCookie?.() ?? []
  const cookie = setCookie.map((c) => c.split(';')[0]).join('; ')

  const get = async (name, path, expectStatus = 200) =>
    capture('reads', name, { path, cookie, expectStatus })

  // ── catalog ──
  await get('projects-list', '/api/projects')
  const datasets = await get('datasets-list', '/api/datasets')
  const ds = datasets.json?.datasets?.[0]
  if (ds) {
    await get('dataset-detail', `/api/datasets/${ds.id}`)
    await get('dataset-rows', `/api/datasets/${ds.id}/rows?limit=5`)
    await get('dataset-quality', `/api/datasets/${ds.id}/quality`)
    await get('dataset-branches', `/api/datasets/${ds.id}/branches`)
    await get('dataset-comments', `/api/datasets/${ds.id}/comments`)
    await get('dataset-watch', `/api/datasets/${ds.id}/watch`)
    await get('dataset-diff', `/api/datasets/${ds.id}/diff?from=1&to=1`, 200)
    await get('dataset-export', `/api/datasets/${ds.id}/export?format=csv`)
    const versions = datasets.json?.datasets?.[0]?.versionsCount ?? 1
    if (versions >= 2) {
      await get('dataset-diff-2v', `/api/datasets/${ds.id}/diff?from=1&to=2`)
    }
  }
  await get('connectors-list', '/api/connectors')
  await get('ingestions-list', '/api/ingestions')
  await get('lineage-graph', '/api/lineage')

  // ── orchestration ──
  const pipelines = await get('pipelines-list', '/api/pipelines')
  const pl = pipelines.json?.pipelines?.[0]
  if (pl) {
    await get('pipeline-detail', `/api/pipelines/${pl.id}`)
    // NOTE: /api/pipelines/{id}/runs does NOT exist — run history is
    // /api/runs?pipelineId= (verified against the legacy route tree).
    await get('runs-by-pipeline', `/api/runs?pipelineId=${pl.id}`)
    await get('pipeline-versions', `/api/pipelines/${pl.id}/versions`)
  }
  const runs = await get('runs-list', '/api/runs')
  const run = runs.json?.runs?.[0]
  if (run) await get('run-detail', `/api/runs/${run.id}`)
  await get('schedules-list', '/api/schedules')
  await get('execution-jobs-list', '/api/execution-jobs')

  // ── compute ──
  const transforms = await get('transforms-list', '/api/transforms')
  const tr = transforms.json?.transforms?.[0]
  if (tr) await get('transform-runs', `/api/transforms/${tr.id}/runs`)

  // ── ontology ──
  const ontology = await get('ontology-list', '/api/ontology')
  const ot = ontology.json?.objectTypes?.[0]
  if (ot) {
    // NOTE: object lists go through /api/objects?type=<apiName> — there is
    // no /api/objects/{type} collection route in the legacy tree.
    await get('objects-list', `/api/objects?type=${encodeURIComponent(ot.apiName)}&limit=5`)
    await get('object-views', `/api/objects/views?type=${encodeURIComponent(ot.apiName)}`)
  }
  await get('actions-list', '/api/actions')
  await get('action-logs', '/api/actions/logs')
  const dashboards = await get('dashboards-list', '/api/dashboards')
  const db1 = dashboards.json?.dashboards?.[0]
  if (db1) await get('dashboard-detail', `/api/dashboards/${db1.id}`)
  const apps = await get('applications-list', '/api/applications')
  const app = apps.json?.applications?.[0]
  if (app) await get('application-detail', `/api/applications/${app.id}`)

  // ── governance ──
  await get('markings-list', '/api/markings')
  await get('approvals-list', '/api/approvals')
  await get('audit-list', '/api/audit')
  if (ds) {
    await get('acl-list', `/api/acl?resourceType=dataset&resourceId=${ds.id}`)
    await get('acl-check', `/api/acl/check?resourceType=dataset&resourceId=${ds.id}&email=${encodeURIComponent(ADMIN.email)}`)
  }
  await get('notifications-list', '/api/notifications')
  await get('curriculum-status', '/api/curriculum')
  await get('settings-overview', '/api/settings/overview')
  await get('search-q', '/api/search?q=ship')
  await get('stats', '/api/stats')

  // ── public v1 (token authed) ──
  const tok = await capture('reads', 'v1-token-setup', {
    method: 'POST', path: '/api/tokens',
    body: { name: `contract-reads-${Date.now()}` }, cookie, expectStatus: 201,
  })
  const v1secret = tok.json?.secret
  if (v1secret) {
    const v1 = (name, path) =>
      capture('reads', name, { path, headers: { authorization: `Bearer ${v1secret}` }, expectStatus: 200 })
    await v1('v1-whoami', '/api/foundry/v1/whoami')
    await v1('v1-datasets', '/api/foundry/v1/datasets')
    if (ds) {
      await v1('v1-dataset-detail', `/api/foundry/v1/datasets/${ds.id}`)
      await v1('v1-dataset-rows', `/api/foundry/v1/datasets/${ds.id}/rows?limit=3`)
      await v1('v1-dataset-export', `/api/foundry/v1/datasets/${ds.id}/export?format=csv`)
    }
    await v1('v1-ontology', '/api/foundry/v1/ontology')
    if (ot) await v1('v1-objects', `/api/foundry/v1/objects/${ot.apiName}?limit=3`)
    await v1('v1-pipelines', '/api/foundry/v1/pipelines')
    if (pl) await v1('v1-pipeline-detail', `/api/foundry/v1/pipelines/${pl.id}`)
  }
}

async function main() {
  await waitForServer()
  if (DOMAINS.includes('auth')) await captureAuth()
  if (DOMAINS.includes('platform')) await capturePlatform()
  if (DOMAINS.includes('reads')) await captureReads()
  console.log(failures === 0 ? '\nAll captures matched expected statuses.' : `\n${failures} capture(s) had unexpected statuses.`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
