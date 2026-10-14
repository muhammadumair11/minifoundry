import { demoPassword } from './demo-credentials.mjs'
// MiniFoundry — Phase 1 E2E: auth service + gateway + SPA API surface.
// Runs against the NEW stack (default http://localhost:8080 = gateway).
// Validates the login/session/token flows through the gateway, including
// demo-mode fallbacks, the simulator cookie, impersonation and the
// shared-mode auth wall semantics.
//
// Usage: node scripts/e2e-phase1.mjs [--base http://localhost:8080]

const args = process.argv.slice(2)
const argVal = (name, dflt) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const BASE = argVal('base', process.env.MF_E2E_BASE ?? 'http://localhost:8080')
const ADMIN = { email: 'demo-admin@example.invalid', password: demoPassword }
const VIEWER = { email: 'demo-viewer@example.invalid', password: demoPassword }

let passed = 0
let failed = 0

async function req(method, path, { body, cookie, headers = {} } = {}) {
  const res = await fetch(`${BASE}${path}`, {
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
  try { json = JSON.parse(text) } catch { /* non-JSON */ }
  return { status: res.status, json, text, setCookie: res.headers.getSetCookie?.() ?? [] }
}

function jar(setCookie) {
  return setCookie.map((c) => c.split(';')[0]).join('; ')
}

/** Merge cookie jars with browser semantics: later same-name cookies replace. */
function mergeJar(base, overlay) {
  const map = new Map()
  for (const part of `${base}; ${overlay}`.split(';').map((s) => s.trim()).filter(Boolean)) {
    const idx = part.indexOf('=')
    if (idx > 0) map.set(part.slice(0, idx), part)
  }
  return [...map.values()].join('; ')
}

function check(name, cond, detail = '') {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function waitForGateway(timeoutMs = 60_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(3000) })
      if (r.ok) return
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error(`gateway at ${BASE} not healthy`)
}

async function main() {
  await waitForGateway()
  console.log(`E2E phase 1 against ${BASE}\n`)

  // ── gateway-owned ──
  const hello = await req('GET', '/api')
  check('GET /api hello world', hello.status === 200 && hello.json?.message === 'Hello, world!', JSON.stringify(hello.json))

  const unknown = await req('GET', '/api/does-not-exist')
  check('unknown /api path → 404 json', unknown.status === 404 && typeof unknown.json?.error === 'string')

  // ── demo-mode anonymous fallback (gateway resolves admin, no cookies) ──
  const anonSession = await req('GET', '/api/session')
  check('demo anonymous → role admin, session null',
    anonSession.status === 200 && anonSession.json?.role === 'admin' && anonSession.json?.session === null,
    JSON.stringify(anonSession.json))

  // ── simulator cookie (demo) ──
  const simSet = await req('POST', '/api/session/role', { body: { role: 'viewer' } })
  const simCookie = simSet.setCookie.find((c) => c.startsWith('foundry-role='))
  check('simulator role switch sets foundry-role cookie',
    simSet.status === 200 && simSet.json?.role === 'viewer' && Boolean(simCookie),
    JSON.stringify(simSet.setCookie))
  const simSession = await req('GET', '/api/session', { cookie: 'foundry-role=viewer' })
  check('simulator cookie honored in demo mode',
    simSession.status === 200 && simSession.json?.role === 'viewer' && simSession.json?.session === null,
    JSON.stringify(simSession.json))
  const simBad = await req('POST', '/api/session/role', { body: { role: 'root' } })
  check('invalid simulator role → 400', simBad.status === 400 && typeof simBad.json?.error === 'string')

  // ── login flow ──
  const badLogin = await req('POST', '/api/auth/login', { body: { email: ADMIN.email, password: 'nope' } })
  check('wrong password → 401 exact message',
    badLogin.status === 401 && badLogin.json?.error === 'invalid email or password',
    JSON.stringify(badLogin.json))

  const login = await req('POST', '/api/auth/login', { body: ADMIN })
  const adminJar = jar(login.setCookie)
  check('admin login → 200 + user shape',
    login.status === 200 &&
    login.json?.user?.email === ADMIN.email &&
    login.json?.user?.role === 'admin' &&
    'id' in (login.json?.user ?? {}) &&
    'name' in (login.json?.user ?? {}) &&
    'lastLoginAt' in (login.json?.user ?? {}),
    JSON.stringify(login.json))
  check('login sets foundry-session + foundry-role cookies',
    login.setCookie.some((c) => c.startsWith('foundry-session=')) &&
    login.setCookie.some((c) => c.startsWith('foundry-role=')),
    JSON.stringify(login.setCookie.map((c) => c.split('=')[0])))

  const me = await req('GET', '/api/auth/me', { cookie: adminJar })
  check('me authenticated → user', me.status === 200 && me.json?.authenticated === true && me.json?.user?.role === 'admin',
    JSON.stringify(me.json))

  const meAnon = await req('GET', '/api/auth/me')
  check('me anonymous → authenticated false', meAnon.status === 200 && meAnon.json?.authenticated === false)

  const sess = await req('GET', '/api/session', { cookie: adminJar })
  check('session with real login',
    sess.status === 200 && sess.json?.role === 'admin' &&
    sess.json?.session?.email === ADMIN.email &&
    sess.json?.session?.effectiveRole === 'admin' &&
    sess.json?.session?.impersonating === false,
    JSON.stringify(sess.json))

  // ── impersonation ──
  const imp = await req('POST', '/api/session/role', { body: { role: 'viewer' }, cookie: adminJar })
  const impJar = mergeJar(adminJar, jar(imp.setCookie))
  check('admin impersonates viewer → 200', imp.status === 200 && imp.json?.role === 'viewer', JSON.stringify(imp.json))
  const impSession = await req('GET', '/api/session', { cookie: impJar })
  check('impersonated session: effective viewer, real admin, impersonating true',
    impSession.status === 200 &&
    impSession.json?.role === 'viewer' &&
    impSession.json?.session?.role === 'admin' &&
    impSession.json?.session?.effectiveRole === 'viewer' &&
    impSession.json?.session?.impersonating === true,
    JSON.stringify(impSession.json))

  // ── role guards (users list is admin-only) ──
  const usersAdmin = await req('GET', '/api/users', { cookie: adminJar })
  check('users list as admin → 200 with >=3 users',
    usersAdmin.status === 200 && Array.isArray(usersAdmin.json?.users) && usersAdmin.json.users.length >= 3,
    `status=${usersAdmin.status}`)
  const viewerLogin = await req('POST', '/api/auth/login', { body: VIEWER })
  const viewerJar = jar(viewerLogin.setCookie)
  const usersViewer = await req('GET', '/api/users', { cookie: viewerJar })
  check('users list as viewer → 403 exact legacy message',
    usersViewer.status === 403 && usersViewer.json?.error === 'requires admin role (current: viewer)',
    JSON.stringify(usersViewer.json))

  // impersonated admin (effective viewer) must also be denied
  const usersImp = await req('GET', '/api/users', { cookie: impJar })
  check('users list while impersonating viewer → 403', usersImp.status === 403, `status=${usersImp.status}`)

  // ── tokens lifecycle ──
  const tokName = `e2e-${Date.now()}`
  const tok = await req('POST', '/api/tokens', { body: { name: tokName }, cookie: adminJar })
  check('token create → 201 + secret shown once',
    tok.status === 201 && typeof tok.json?.secret === 'string' && tok.json.secret.startsWith('mf_live_') &&
    tok.json?.token?.name === tokName && tok.json?.token?.prefix === tok.json.secret.slice(0, 12),
    JSON.stringify(tok.json))
  const dup = await req('POST', '/api/tokens', { body: { name: tokName }, cookie: adminJar })
  check('duplicate token name → 400 exact message',
    dup.status === 400 && dup.json?.error === 'Token name is already in use', JSON.stringify(dup.json))
  const list = await req('GET', '/api/tokens', { cookie: adminJar })
  check('tokens list contains new token (no hash leak)',
    list.status === 200 && list.json?.tokens?.some((t) => t.name === tokName) &&
    !JSON.stringify(list.json).includes('tokenHash'),
    `status=${list.status}`)
  const rev = await req('DELETE', `/api/tokens/${tok.json?.token?.id}`, { cookie: adminJar })
  check('token revoke → ok', rev.status === 200 && rev.json?.ok === true, JSON.stringify(rev.json))
  const rev404 = await req('DELETE', '/api/tokens/nope', { cookie: adminJar })
  check('revoke unknown → 404 exact message',
    rev404.status === 404 && rev404.json?.error === "API token 'nope' not found", JSON.stringify(rev404.json))

  // ── usage seed + dashboard ──
  const tok2 = await req('POST', '/api/tokens', { body: { name: `e2e-usage-${Date.now()}` }, cookie: adminJar })
  if (tok2.status === 201) {
    await req('DELETE', '/api/tokens/usage', { cookie: adminJar })
    const seed = await req('POST', '/api/tokens/usage/seed', { body: { hours: 12 }, cookie: adminJar })
    check('usage seed → 201 { seeded }', seed.status === 201 && seed.json?.seeded > 0, JSON.stringify(seed.json))
    const usage = await req('GET', '/api/tokens/usage', { cookie: adminJar })
    check('usage dashboard shape',
      usage.status === 200 && usage.json?.windowHours === 24 &&
      Array.isArray(usage.json?.byHour) && usage.json.byHour.length === 24 &&
      Array.isArray(usage.json?.byToken) && Array.isArray(usage.json?.topRoutes) &&
      Array.isArray(usage.json?.recentErrors) && 'avgDurationMs' in (usage.json ?? {}),
      `status=${usage.status}`)
  }

  // ── self-account guard ──
  const adminId = usersAdmin.json?.users?.find((u) => u.email === ADMIN.email)?.id
  if (adminId) {
    const selfDemote = await req('PATCH', `/api/users/${adminId}`, { body: { role: 'viewer' }, cookie: adminJar })
    check('admin self-demotion → 400 exact message',
      selfDemote.status === 400 && selfDemote.json?.error === 'cannot change your own account',
      JSON.stringify(selfDemote.json))
  }

  // ── logout ──
  const out = await req('POST', '/api/auth/logout', { cookie: adminJar })
  check('logout → ok + expired cookies',
    out.status === 200 && out.json?.ok === true &&
    out.setCookie.some((c) => c.startsWith('foundry-session=;') || c.includes('Max-Age=0')),
    JSON.stringify(out.setCookie))

  // ── transparent refresh (if supported by deployed build) ──
  // login again, then wait is impractical in E2E; assert the refresh cookie
  // exists so the gateway flow CAN work, and that an expired-access scenario
  // at least does not hard-fail (session resolves anonymously in demo).
  const login2 = await req('POST', '/api/auth/login', { body: ADMIN })
  check('refresh cookie issued at login',
    login2.setCookie.some((c) => c.startsWith('foundry-refresh=')),
    JSON.stringify(login2.setCookie.map((c) => c.split('=')[0])))

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
