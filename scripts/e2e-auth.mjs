// MiniFoundry — auth flows E2E: signup + password change + session lifecycle.
// Runs against the gateway (default http://localhost:8080).
//
// Usage: node scripts/e2e-auth.mjs [--base http://localhost:8080]

const args = process.argv.slice(2)
const argVal = (name, dflt) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const BASE = argVal('base', process.env.MF_E2E_BASE ?? 'http://localhost:8080')

let passed = 0
let failed = 0

async function req(method, path, { body, cookie } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
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

function mergeJar(base, overlay) {
  const map = new Map()
  for (const part of `${base}; ${overlay}`.split(';').map((s) => s.trim()).filter(Boolean)) {
    const idx = part.indexOf('=')
    if (idx > 0) map.set(part.slice(0, idx), part)
  }
  return [...map.values()].join('; ')
}

function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const stamp = Date.now()
const NEW_EMAIL = `signup-${stamp}@minifoundry.test`
const NEW_PASSWORD = 'correct-horse-battery'
const CHANGED_PASSWORD = 'staple-staple-staple-9'

async function main() {
  console.log(`E2E auth flows against ${BASE}\n`)

  // ── signup validation ──
  const empty = await req('POST', '/api/auth/signup', { body: {} })
  check('signup empty body → 400 all-issues message',
    empty.status === 400 &&
    empty.json?.error ===
      'name: Invalid input: expected string, received undefined; ' +
      'email: Invalid input: expected string, received undefined; ' +
      'password: Invalid input: expected string, received undefined',
    JSON.stringify(empty.json))

  const badFields = await req('POST', '/api/auth/signup', {
    body: { name: '', email: 'not-an-email', password: 'short' },
  })
  check('signup invalid fields → exact zod-style message',
    badFields.status === 400 &&
    badFields.json?.error ===
      'name: Too small: expected string to have >=1 characters; ' +
      'email: Invalid email address; ' +
      'password: Too small: expected string to have >=8 characters',
    JSON.stringify(badFields.json))

  // ── signup success (workspace has seeded users → viewer role) ──
  const created = await req('POST', '/api/auth/signup', {
    body: { name: '  Sam Signup  ', email: `  ${NEW_EMAIL.toUpperCase()} `, password: NEW_PASSWORD },
  })
  const newUserJar = jar(created.setCookie)
  check('signup → 201 { user } normalized+trimmed',
    created.status === 201 &&
    created.json?.user?.email === NEW_EMAIL &&
    created.json?.user?.name === 'Sam Signup' &&
    created.json?.user?.role === 'viewer' &&
    'id' in (created.json?.user ?? {}) &&
    'lastLoginAt' in (created.json?.user ?? {}),
    `status=${created.status} ${JSON.stringify(created.json)}`)
  check('signup auto-logs-in (session + refresh + role cookies)',
    created.setCookie.some((c) => c.startsWith('foundry-session=')) &&
    created.setCookie.some((c) => c.startsWith('foundry-refresh=')) &&
    created.setCookie.some((c) => c.startsWith('foundry-role=viewer')),
    JSON.stringify(created.setCookie.map((c) => c.split('=')[0])))

  // ── duplicate email → 409 (case-insensitive: stored normalized) ──
  const dup = await req('POST', '/api/auth/signup', {
    body: { name: 'Impostor', email: NEW_EMAIL.toUpperCase(), password: NEW_PASSWORD },
  })
  check('duplicate signup → 409 exact message',
    dup.status === 409 && dup.json?.error === 'an account with this email already exists',
    JSON.stringify(dup.json))

  // ── session works with the new account ──
  const me = await req('GET', '/api/auth/me', { cookie: newUserJar })
  check('me after signup → authenticated viewer',
    me.status === 200 && me.json?.authenticated === true && me.json?.user?.role === 'viewer',
    JSON.stringify(me.json))

  // viewer role guard still applies (admin-only route)
  const users = await req('GET', '/api/users', { cookie: newUserJar })
  check('new viewer cannot list users → 403 exact',
    users.status === 403 && users.json?.error === 'requires admin role (current: viewer)',
    JSON.stringify(users.json))

  // ── password change ──
  const noSession = await req('POST', '/api/auth/password', {
    body: { currentPassword: 'x', newPassword: CHANGED_PASSWORD },
  })
  check('password change without session → 401',
    noSession.status === 401 && noSession.json?.error === 'authentication required',
    JSON.stringify(noSession.json))

  const badChange = await req('POST', '/api/auth/password', {
    cookie: newUserJar,
    body: { currentPassword: 'wrong-password', newPassword: CHANGED_PASSWORD },
  })
  check('wrong current password → 400 exact',
    badChange.status === 400 && badChange.json?.error === 'current password is incorrect',
    JSON.stringify(badChange.json))

  const shortNew = await req('POST', '/api/auth/password', {
    cookie: newUserJar,
    body: { currentPassword: NEW_PASSWORD, newPassword: 'short' },
  })
  check('short new password → 400 validation',
    shortNew.status === 400 &&
    shortNew.json?.error === 'newPassword: Too small: expected string to have >=8 characters',
    JSON.stringify(shortNew.json))

  const changed = await req('POST', '/api/auth/password', {
    cookie: newUserJar,
    body: { currentPassword: NEW_PASSWORD, newPassword: CHANGED_PASSWORD },
  })
  check('password change → ok', changed.status === 200 && changed.json?.ok === true, JSON.stringify(changed.json))

  // old password now rejected, new password works
  const oldLogin = await req('POST', '/api/auth/login', { body: { email: NEW_EMAIL, password: NEW_PASSWORD } })
  check('login with OLD password → 401',
    oldLogin.status === 401 && oldLogin.json?.error === 'invalid email or password',
    JSON.stringify(oldLogin.json))

  const newLogin = await req('POST', '/api/auth/login', { body: { email: NEW_EMAIL, password: CHANGED_PASSWORD } })
  check('login with NEW password → 200',
    newLogin.status === 200 && newLogin.json?.user?.email === NEW_EMAIL,
    `status=${newLogin.status}`)

  // the original (password-change) session cookie still works (refresh kept)
  const meAfter = await req('GET', '/api/auth/me', { cookie: newUserJar })
  check('existing session survives password change',
    meAfter.status === 200 && meAfter.json?.authenticated === true,
    JSON.stringify(meAfter.json))

  // ── admin can see + promote the new user (authorization lifecycle) ──
  const adminLogin = await req('POST', '/api/auth/login', {
    body: { email: 'demo-admin@example.invalid', password: '<redacted>' },
  })
  const adminJar = jar(adminLogin.setCookie)
  const list = await req('GET', '/api/users', { cookie: adminJar })
  const newUser = (list.json?.users ?? []).find((u) => u.email === NEW_EMAIL)
  check('admin sees the new user in /api/users', Boolean(newUser), `status=${list.status}`)
  if (newUser) {
    const promote = await req('PATCH', `/api/users/${newUser.id}`, {
      cookie: adminJar,
      body: { role: 'editor' },
    })
    check('admin promotes new user → editor',
      promote.status === 200 && promote.json?.user?.role === 'editor',
      JSON.stringify(promote.json))
    // promotee's NEXT session reflects the new role (JWT re-issue on login)
    const relogin = await req('POST', '/api/auth/login', { body: { email: NEW_EMAIL, password: CHANGED_PASSWORD } })
    check('re-login after promotion → editor role',
      relogin.status === 200 && relogin.json?.user?.role === 'editor',
      JSON.stringify(relogin.json?.user))
    const canList = await req('GET', '/api/datasets', { cookie: jar(relogin.setCookie) })
    check('promoted editor passes editor-gated surface (datasets read)', canList.status === 200, `status=${canList.status}`)
  }

  // ── audit trail ──
  // Auth publishes audit events through NATS, so persistence by governance is
  // deliberately asynchronous. Poll for this run's exact events instead of
  // falsely requiring a synchronous cross-service write.
  let audit = null
  let audited = false
  for (let attempt = 0; attempt < 30 && !audited; attempt++) {
    // Request a wide page: the normal audit UI defaults to a small latest
    // page, while the login/promotion events that follow these two events
    // could otherwise push them out before this assertion runs.
    audit = await req('GET', '/api/audit?limit=200', { cookie: adminJar })
    const entries = audit.json?.entries ?? []
    const signupAudited = entries.some(
      (entry) => entry.action === 'auth.signup' && entry.actorEmail === NEW_EMAIL,
    )
    const passwordAudited = entries.some(
      (entry) => entry.action === 'auth.password_change' && entry.actorEmail === NEW_EMAIL,
    )
    audited = signupAudited && passwordAudited
    if (!audited) await new Promise((resolve) => setTimeout(resolve, 100))
  }
  check('signup + password_change audited', audited, `status=${audit?.status}`)

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
