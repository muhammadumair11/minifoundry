// PATCH/DELETE /api/schedules/[id] — update / delete a schedule.
// PATCH recompute rule: when intervalMinutes or enabled is sent,
// nextRunAt = enabled ? now + intervalMinutes : null (disabling clears it).

import { z } from 'zod'
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  badRequest,
  jsonOk,
  notFound,
  serializeSchedule,
  serverError,
  zodErrorMessage,
} from '@/lib/api-utils'
import { audit, requireRole } from '@/lib/governance'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

const patchSchema = z.object({
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  intervalMinutes: z
    .number()
    .int('intervalMinutes must be an integer')
    .min(5, 'intervalMinutes must be at least 5')
    .max(10080, 'intervalMinutes must be at most 10080 (7 days)')
    .optional(),
})

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const denied = requireRole(req, 'editor')
    if (denied) return denied

    const { id } = await params
    const existing = await db.schedule.findUnique({ where: { id } })
    if (!existing) return notFound(`Schedule '${id}' not found`)

    let body: unknown
    try {
      body = await req.json()
    } catch {
      return badRequest('Request body must be valid JSON')
    }
    const parsed = patchSchema.safeParse(body)
    if (!parsed.success) return badRequest(zodErrorMessage(parsed))
    if (parsed.data.name === undefined && parsed.data.enabled === undefined && parsed.data.intervalMinutes === undefined) {
      return badRequest('Nothing to update: provide name, enabled and/or intervalMinutes')
    }

    // Effective values after the patch (used to recompute the window).
    const enabled = parsed.data.enabled ?? existing.enabled
    const intervalMinutes = parsed.data.intervalMinutes ?? existing.intervalMinutes
    const recomputeWindow =
      parsed.data.enabled !== undefined || parsed.data.intervalMinutes !== undefined

    const schedule = await db.schedule.update({
      where: { id },
      data: {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
        ...(parsed.data.intervalMinutes !== undefined
          ? { intervalMinutes: parsed.data.intervalMinutes }
          : {}),
        ...(recomputeWindow
          ? { nextRunAt: enabled ? new Date(Date.now() + intervalMinutes * 60_000) : null }
          : {}),
      },
      include: { pipeline: { select: { name: true } } },
    })

    audit({
      req,
      action: 'schedule.update',
      resourceType: 'schedule',
      resourceId: schedule.id,
      resourceName: schedule.name,
      detail: `updated ${[
        parsed.data.name !== undefined ? 'name' : null,
        parsed.data.enabled !== undefined ? 'enabled' : null,
        parsed.data.intervalMinutes !== undefined ? 'intervalMinutes' : null,
      ].filter(Boolean).join(', ')}`,
    })

    return jsonOk({ schedule: serializeSchedule(schedule) })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to update schedule')
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const denied = requireRole(req, 'editor')
    if (denied) return denied

    const { id } = await params
    const existing = await db.schedule.findUnique({ where: { id }, select: { id: true, name: true } })
    if (!existing) return notFound(`Schedule '${id}' not found`)

    await db.schedule.delete({ where: { id } })

    audit({
      req,
      action: 'schedule.delete',
      resourceType: 'schedule',
      resourceId: existing.id,
      resourceName: existing.name,
    })

    return new NextResponse(null, { status: 204 })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to delete schedule')
  }
}
