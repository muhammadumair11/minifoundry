// POST /api/notifications/read-all — mark every visible notification as read
// (any role). Visible = broadcast (userEmail null) or addressed to the
// caller's email. Returns the number of rows stamped.

import type { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { jsonOk, serverError } from '@/lib/api-utils'
import { getActor } from '@/lib/governance'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const actor = getActor(req)
    const result = await db.notification.updateMany({
      where: {
        OR: [{ userEmail: null }, { userEmail: actor.email }],
        readAt: null,
      },
      data: { readAt: new Date() },
    })
    return jsonOk({ updated: result.count })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to mark all read')
  }
}
