// POST /api/session/role — switch the active governance role.
//
// Two modes:
//  1. ANONYMOUS (demo mode): sets the JS-readable `foundry-role` simulator
//     cookie only — the original behavior, preserved for teaching ABAC
//     without accounts and for machine-to-machine callers.
//  2. REAL SESSION: only admins (true role, even while impersonating) may
//     switch — the session token is RE-ISSUED with the effective role
//     (session-carried impersonation, see impersonationCookies), so getRole()
//     resolves the impersonated role on every route with no per-route changes.
//     Switching back to the real role drops the override. Non-admin sessions
//     get 403.

import { z } from 'zod'
import { NextResponse } from 'next/server'
import { badRequest, jsonError, serverError, zodErrorMessage } from '@/lib/api-utils'
import { audit } from '@/lib/governance'
import { getSession, impersonationCookies, LEGACY_ROLE_COOKIE } from '@/lib/auth-service'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

const roleSchema = z.object({
  role: z.enum(['viewer', 'editor', 'admin']),
})

const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60

export async function POST(req: NextRequest) {
  try {
    let body: unknown
    try {
      body = await req.json()
    } catch {
      return badRequest('Request body must be valid JSON')
    }
    const parsed = roleSchema.safeParse(body)
    if (!parsed.success) return badRequest(zodErrorMessage(parsed))
    const target = parsed.data.role

    const session = getSession(req)
    const res = NextResponse.json({ role: target })

    if (session) {
      // Real session: true admins only (an impersonating admin may restore).
      const realRole = session.realRole ?? session.role
      if (realRole !== 'admin') {
        return jsonError(403, 'only admin users can switch roles')
      }
      if (target !== session.role) {
        // Re-issue the session with the new effective role.
        for (const spec of impersonationCookies(session, target)) {
          res.cookies.set(spec.name, spec.value, spec.options)
        }
      }
      audit({
        req,
        actorRole: target,
        action: 'session.role_switch',
        resourceType: 'user',
        resourceId: session.uid,
        detail: `role=${target} impersonated=${target !== realRole ? 'yes' : 'no'}`,
      })
      return res
    }

    // Anonymous demo mode — simulator cookie only.
    res.cookies.set(LEGACY_ROLE_COOKIE, target, {
      httpOnly: false,
      sameSite: 'lax',
      path: '/',
      maxAge: SEVEN_DAYS_SECONDS,
    })

    audit({
      req,
      action: 'session.role_switch',
      resourceType: 'user',
      detail: `role=${target} simulator=yes`,
    })

    return res
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to set role')
  }
}
