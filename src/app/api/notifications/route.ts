// GET /api/notifications?unread=1|all — notification center feed (any role).
//
// Returns the latest 50 notifications visible to the caller, newest first,
// plus the unread count. Visibility: broadcast rows (userEmail null) are
// visible to EVERYONE; addressed rows only to their userEmail. The unread
// count honors the same visibility filter.

import type { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { jsonOk, serverError } from '@/lib/api-utils'
import { getActor } from '@/lib/governance'
import type { NotificationInfo, NotificationListResponse } from '@/lib/foundry-types'

export const dynamic = 'force-dynamic'

/** WHERE fragment: rows visible to this actor (broadcasts + addressed). */
function visibleTo(email: string | null) {
  return { OR: [{ userEmail: null }, { userEmail: email }] }
}

export async function GET(req: NextRequest) {
  try {
    const actor = getActor(req)
    const unreadOnly = new URL(req.url).searchParams.get('unread') === '1'

    const notifications = await db.notification.findMany({
      where: unreadOnly
        ? { AND: [visibleTo(actor.email), { readAt: null }] }
        : visibleTo(actor.email),
      orderBy: { createdAt: 'desc' },
      take: 50,
    })

    const unreadCount = await db.notification.count({
      where: { AND: [visibleTo(actor.email), { readAt: null }] },
    })

    return jsonOk<NotificationListResponse>({
      notifications: notifications.map<NotificationInfo>((n) => ({
        id: n.id,
        userEmail: n.userEmail,
        type: n.type,
        title: n.title,
        body: n.body,
        resourceType: n.resourceType,
        resourceId: n.resourceId,
        href: n.href,
        readAt: n.readAt ? n.readAt.toISOString() : null,
        createdAt: n.createdAt.toISOString(),
      })),
      unreadCount,
    })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load notifications')
  }
}
