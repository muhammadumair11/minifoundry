// POST /api/notifications/[id]/read — mark ONE notification as read (any
// role, but only when it is visible to the caller: broadcast or addressed to
// their email). Idempotent: readAt is only stamped once.

import type { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { jsonOk, notFound, serverError } from '@/lib/api-utils'
import { getActor } from '@/lib/governance'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = getActor(req)
    const { id } = await params

    const notification = await db.notification.findUnique({ where: { id } })
    if (
      !notification ||
      (notification.userEmail !== null && notification.userEmail !== actor.email)
    ) {
      return notFound(`Notification '${id}' not found`)
    }

    const updated = notification.readAt
      ? notification
      : await db.notification.update({
          where: { id },
          data: { readAt: new Date() },
        })

    return jsonOk({
      id: updated.id,
      readAt: updated.readAt ? updated.readAt.toISOString() : null,
    })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to mark notification read')
  }
}
