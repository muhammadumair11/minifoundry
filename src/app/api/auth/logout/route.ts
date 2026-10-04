// POST /api/auth/logout — clear the session (M9).
// Expires BOTH the `foundry-session` and the legacy `foundry-role` cookie via
// buildSetCookies(null). Audits auth.logout when a valid session was present.

import { jsonOk, serverError } from '@/lib/api-utils'
import { audit } from '@/lib/governance'
import { buildSetCookies, getSession } from '@/lib/auth-service'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const session = getSession(req)
    if (session) {
      audit({
        req,
        action: 'auth.logout',
        resourceType: 'user',
        resourceId: session.uid,
        resourceName: session.email,
        detail: `email=${session.email} role=${session.role}`,
      })
    }

    const res = jsonOk({ ok: true })
    for (const c of buildSetCookies(null)) res.cookies.set(c.name, c.value, c.options)
    return res
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Logout failed')
  }
}
