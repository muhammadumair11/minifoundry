// GET /api/auth/me — who am I? (M9)
// Valid session cookie (and the user still exists + is active) ->
// { authenticated: true, user }; otherwise { authenticated: false }.

import { db } from '@/lib/db'
import { jsonOk, serverError } from '@/lib/api-utils'
import { getSession, serializeAuthUser } from '@/lib/auth-service'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
    const session = getSession(req)
    if (!session) return jsonOk({ authenticated: false })

    const user = await db.user.findUnique({ where: { id: session.uid } })
    if (!user || !user.isActive) return jsonOk({ authenticated: false })

    return jsonOk({ authenticated: true, user: serializeAuthUser(user) })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to read session')
  }
}
