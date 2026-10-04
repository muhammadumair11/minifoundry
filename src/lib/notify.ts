// MiniFoundry — R14 notification helper.
//
// createNotification NEVER throws: notifications are a side channel and must
// not break the main flow of pipeline runs, quality evaluations, approvals…
// Callers own the type vocabulary (see Notification.type in schema.prisma):
//   run_failed | quality_failed | approval_requested | pipeline_triggered | system
// userEmail null = broadcast to every user (visible regardless of who logs in).

import { db } from '@/lib/db'

export interface NotificationInput {
  userEmail?: string | null
  type: string
  title: string
  body?: string
  resourceType?: string
  resourceId?: string
  /** in-app deep link, e.g. "/pipelines/cmw..." — the bell opens this */
  href?: string
}

export async function createNotification(input: NotificationInput): Promise<void> {
  try {
    await db.notification.create({
      data: {
        userEmail: input.userEmail ?? null,
        type: input.type,
        title: input.title,
        body: input.body ?? null,
        resourceType: input.resourceType ?? null,
        resourceId: input.resourceId ?? null,
        href: input.href ?? null,
      },
    })
  } catch (error) {
    console.error('[notify] failed to create notification:', error)
  }
}
