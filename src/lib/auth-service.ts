// MiniFoundry — M9 real authentication service.
// Password hashing (scrypt) + HMAC-signed stateless session tokens carried in
// an HttpOnly `foundry-session` cookie. Sessions OVERRIDE the `foundry-role`
// simulator cookie (see getRole() in governance.ts); the simulator remains for
// anonymous demo use, and no-cookie machine callers (scheduler, curl) still
// resolve to trusted 'admin'.
//
// NO new dependencies — node:crypto only. Token format:
//   token = <payloadB64url>.<hmacSha256Hex>
// where payload = { uid, email, name, role, iat, exp } JSON (exp in epoch secs).

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type { NextRequest } from 'next/server'
import type { User } from '@prisma/client'

// ─── Constants ───────────────────────────────────────────────────────

/** HttpOnly session cookie (HMAC-signed token). */
export const SESSION_COOKIE = 'foundry-session'

/** Legacy JS-readable simulator cookie, kept in sync on login/logout so existing client code keeps working. */
export const LEGACY_ROLE_COOKIE = 'foundry-role'

/** 7 days, in seconds. */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60

const AUTH_SECRET = process.env.AUTH_SECRET ?? '<redacted>'

// Phase 0: the dev fallback is fine for the local sandbox, but it must be
// UNMISTAKABLE in a shared deployment — sessions there would be forgeable by
// anyone who read the source. Warn once at module load.
if (!process.env.AUTH_SECRET) {
  console.warn(
    '[minifoundry] AUTH_SECRET is not set — using the development fallback secret. ' +
      'Set MF_DEMO_MODE=false AND AUTH_SECRET (and MF_SERVICE_TOKEN for the scheduler) ' +
      'in any deployment shared with other people.',
  )
}

// ─── Types ───────────────────────────────────────────────────────────

export interface SessionPayload {
  uid: string
  email: string
  name: string
  /** EFFECTIVE role — equals realRole except during admin impersonation. */
  role: string
  /** Present only while an admin impersonates another role: their true role. */
  realRole?: string
  iat: number
  exp: number
}

/** Minimal user shape accepted by createSessionToken / buildSetCookies. */
export interface SessionUserInput {
  id: string
  email: string
  name: string
  role: string
}

/**
 * Cookie set-spec — apply with `res.cookies.set(spec.name, spec.value, spec.options)`
 * (the three-arg overload; the single-object overload would DROP the options).
 */
export interface SetCookieSpec {
  name: string
  value: string
  options: {
    httpOnly: boolean
    sameSite: 'lax'
    path: string
    maxAge: number
    secure: boolean
  }
}

// ─── Password hashing (scrypt) ───────────────────────────────────────

/** scrypt with a random 16-byte salt → "scrypt:<saltHex>:<hashHex>". */
export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 64)
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`
}

/** Constant-time scrypt verify against a stored "scrypt:<saltHex>:<hashHex>" string. */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(':')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  try {
    const salt = Buffer.from(parts[1], 'hex')
    const expected = Buffer.from(parts[2], 'hex')
    if (salt.length === 0 || expected.length === 0) return false
    const actual = scryptSync(password, salt, expected.length)
    return timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

// ─── Session tokens ──────────────────────────────────────────────────

function signPayload(payloadB64: string): string {
  return createHmac('sha256', AUTH_SECRET).update(payloadB64).digest('hex')
}

/**
 * Build a signed session token for `user` (7-day expiry).
 * `opts.roleOverride` implements ADMIN IMPERSONATION: when set (and different
 * from the user's real role) the payload carries the effective role in `role`
 * and the true one in `realRole`, so getRole() resolves the impersonated role
 * while the user keeps their admin identity (and can restore it).
 */
export function createSessionToken(user: SessionUserInput, opts?: { roleOverride?: string }): string {
  const now = Math.floor(Date.now() / 1000)
  const override = opts?.roleOverride && opts.roleOverride !== user.role ? opts.roleOverride : null
  const payload: SessionPayload = {
    uid: user.id,
    email: user.email,
    name: user.name,
    role: override ?? user.role,
    ...(override ? { realRole: user.role } : {}),
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
  }
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `${payloadB64}.${signPayload(payloadB64)}`
}

/**
 * Sync HMAC verify + expiry check (no DB access). Returns the payload when the
 * token is well-formed, correctly signed and unexpired; null otherwise.
 */
export function verifySessionToken(token: string | undefined | null): SessionPayload | null {
  if (!token) return null
  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return null
  const payloadB64 = token.slice(0, dot)
  const sig = Buffer.from(token.slice(dot + 1), 'hex')
  const expected = Buffer.from(signPayload(payloadB64), 'hex')
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as SessionPayload
    if (!payload || typeof payload.uid !== 'string' || typeof payload.exp !== 'number') return null
    if (payload.exp <= Math.floor(Date.now() / 1000)) return null
    return payload
  } catch {
    return null
  }
}

/** Read + verify the session cookie from a request. Sync; null when absent/invalid/expired. */
export function getSession(req: NextRequest): SessionPayload | null {
  return verifySessionToken(req.cookies.get(SESSION_COOKIE)?.value)
}

// ─── Cookies ─────────────────────────────────────────────────────────

export function sessionCookieOptions(): SetCookieSpec['options'] {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
    // Secure in production only — the dev sandbox serves plain HTTP.
    secure: process.env.NODE_ENV === 'production',
  }
}

/**
 * Cookie set-specs for login (user) / logout (null): BOTH the HttpOnly
 * `foundry-session` cookie AND the legacy JS-readable `foundry-role` cookie
 * (= user.role on login, cleared on logout) so the simulator-era client code
 * keeps working. On logout maxAge=0 expires both cookies immediately.
 */
export function buildSetCookies(user: SessionUserInput | null): SetCookieSpec[] {
  const sessionOptions = sessionCookieOptions()
  const roleOptions: SetCookieSpec['options'] = {
    httpOnly: false,
    sameSite: 'lax',
    path: '/',
    maxAge: user ? SESSION_TTL_SECONDS : 0,
    secure: sessionOptions.secure,
  }
  return [
    {
      name: SESSION_COOKIE,
      value: user ? createSessionToken(user) : '',
      options: user ? sessionOptions : { ...sessionOptions, maxAge: 0 },
    },
    { name: LEGACY_ROLE_COOKIE, value: user ? user.role : '', options: roleOptions },
  ]
}

/**
 * Cookie set-specs for an ADMIN IMPERSONATION switch from an existing verified
 * session: re-issues the session token with the effective role = `targetRole`
 * (or restores the real role when `targetRole` equals it) and keeps the legacy
 * `foundry-role` cookie in sync. Requires only the verified payload — no DB.
 */
export function impersonationCookies(session: SessionPayload, targetRole: string): SetCookieSpec[] {
  const realRole = session.realRole ?? session.role
  const specs = buildSetCookies({
    id: session.uid,
    email: session.email,
    name: session.name,
    role: realRole,
  })
  if (targetRole !== realRole) {
    specs[0] = {
      name: SESSION_COOKIE,
      value: createSessionToken(
        { id: session.uid, email: session.email, name: session.name, role: realRole },
        { roleOverride: targetRole },
      ),
      options: sessionCookieOptions(),
    }
  }
  // Legacy cookie follows the EFFECTIVE role so JS-readable client state agrees.
  specs[1] = { name: LEGACY_ROLE_COOKIE, value: targetRole, options: { ...specs[1].options, maxAge: SESSION_TTL_SECONDS } }
  return specs
}

// ─── Serializers (NEVER include passwordHash) ────────────────────────

/** Login/me shape: { id, email, name, role, lastLoginAt }. */
export function serializeAuthUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    lastLoginAt: user.lastLoginAt,
  }
}

/** Admin users-list shape: adds isActive + createdAt. NEVER passwordHash. */
export function serializeAdminUser(user: User) {
  return {
    ...serializeAuthUser(user),
    isActive: user.isActive,
    createdAt: user.createdAt,
  }
}
