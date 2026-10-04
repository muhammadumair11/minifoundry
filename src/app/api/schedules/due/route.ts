// GET /api/schedules/due — enabled schedules whose nextRunAt has passed.
// Consumed by the scheduler mini-service every 30s. NOTE: this is a STATIC
// segment next to [id]; App Router resolves static routes first, so
// /api/schedules/due is matched here, not as schedule id "due".
//
// Auth (Phase 0): viewer+ role from session, OR the service token (the
// scheduler mini-service). In demo mode an unauthenticated caller still passes
// (historical behavior); in shared mode anonymous callers are rejected.

import { db } from '@/lib/db'
import { jsonOk, serializeSchedule, serverError } from '@/lib/api-utils'
import { requireRole } from '@/lib/governance'
import { isServiceAuthorized } from '@/lib/runtime-mode'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
    if (!isServiceAuthorized(req)) {
      const denied = requireRole(req, 'viewer')
      if (denied) return denied
    }
    const schedules = await db.schedule.findMany({
      where: {
        enabled: true,
        nextRunAt: { not: null, lte: new Date() },
      },
      orderBy: { nextRunAt: 'asc' },
      include: { pipeline: { select: { name: true } } },
    })
    return jsonOk({ schedules: schedules.map(serializeSchedule) })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load due schedules')
  }
}
