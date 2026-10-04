// GET/POST /api/schedules — M5 orchestration schedules.
// A schedule triggers its pipeline via the scheduler mini-service when due.

import { z } from 'zod'
import { db } from '@/lib/db'
import {
  badRequest,
  jsonOk,
  serializeSchedule,
  serverError,
  zodErrorMessage,
} from '@/lib/api-utils'
import { audit, requireRole } from '@/lib/governance'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

const createSchema = z.object({
  pipelineId: z.string().min(1, 'pipelineId is required'),
  name: z.string().min(1).optional(),
  intervalMinutes: z
    .number()
    .int('intervalMinutes must be an integer')
    .min(5, 'intervalMinutes must be at least 5')
    .max(10080, 'intervalMinutes must be at most 10080 (7 days)')
    .optional()
    .default(60),
  enabled: z.boolean().optional().default(true),
})

export async function GET() {
  try {
    const schedules = await db.schedule.findMany({
      orderBy: { createdAt: 'asc' },
      include: { pipeline: { select: { name: true } } },
    })
    return jsonOk({ schedules: schedules.map(serializeSchedule) })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load schedules')
  }
}

export async function POST(req: NextRequest) {
  try {
    const denied = requireRole(req, 'editor')
    if (denied) return denied

    let body: unknown
    try {
      body = await req.json()
    } catch {
      return badRequest('Request body must be valid JSON')
    }
    const parsed = createSchema.safeParse(body)
    if (!parsed.success) return badRequest(zodErrorMessage(parsed))

    const pipeline = await db.pipeline.findUnique({
      where: { id: parsed.data.pipelineId },
      select: { id: true, name: true },
    })
    if (!pipeline) return badRequest(`Pipeline '${parsed.data.pipelineId}' not found`)

    const now = new Date()
    const schedule = await db.schedule.create({
      data: {
        pipelineId: pipeline.id,
        name: parsed.data.name ?? `${pipeline.name} schedule`,
        enabled: parsed.data.enabled,
        intervalMinutes: parsed.data.intervalMinutes,
        // First scheduled run fires one interval from now (disabled schedules stay null until re-enabled).
        nextRunAt: parsed.data.enabled
          ? new Date(now.getTime() + parsed.data.intervalMinutes * 60_000)
          : null,
      },
      include: { pipeline: { select: { name: true } } },
    })

    audit({
      req,
      action: 'schedule.create',
      resourceType: 'schedule',
      resourceId: schedule.id,
      resourceName: schedule.name,
      detail: `pipeline '${pipeline.name}', every ${schedule.intervalMinutes} min`,
    })

    return jsonOk({ schedule: serializeSchedule(schedule) }, 201)
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to create schedule')
  }
}
