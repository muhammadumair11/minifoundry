// GET /api/users — list platform users (M9, ADMIN ONLY).
// Ordered createdAt asc. The passwordHash is NEVER returned.

import { db } from '@/lib/db'
import { jsonOk, serverError } from '@/lib/api-utils'
import { requireRole } from '@/lib/governance'
import { serializeAdminUser } from '@/lib/auth-service'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
    const denied = requireRole(req, 'admin')
    if (denied) return denied

    const users = await db.user.findMany({ orderBy: { createdAt: 'asc' } })
    return jsonOk({ users: users.map(serializeAdminUser) })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load users')
  }
}
