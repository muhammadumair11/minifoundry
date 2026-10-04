// GET /api/session — current governance role + (M9) real session identity.
// Role precedence: valid `foundry-session` cookie -> session role (EFFECTIVE,
// which differs from the real role only during admin impersonation); else the
// `foundry-role` cookie; else 'admin' (no cookie = machine-to-machine caller).
// `session.role` is the user's TRUE role; `effectiveRole`/`impersonating`
// (additive) describe an active impersonation; null session = simulator mode.

import type { NextRequest } from 'next/server'
import { jsonOk, serverError } from '@/lib/api-utils'
import { getRole } from '@/lib/governance'
import { getSession } from '@/lib/auth-service'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
    const session = getSession(req)
    const realRole = session?.realRole ?? session?.role ?? null
    return jsonOk({
      role: getRole(req),
      session: session
        ? {
            email: session.email,
            name: session.name,
            role: realRole,
            effectiveRole: session.role,
            impersonating: Boolean(session.realRole && session.realRole !== session.role),
          }
        : null,
    })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to read session role')
  }
}
