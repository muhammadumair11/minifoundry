// POST /api/pipelines/[id]/run — enqueue a pinned pipeline version.
// Optional JSON body { scheduleId?, cascadeDepth? } (body may be empty = manual run).
// When scheduleId is set, the route reserves that schedule's window on enqueue.
// M3.1: every run pins the pipeline version it executed — ensurePipelineVersion
// backfills v1 lazily (pre-versioning pipelines) and the engine executes that
// snapshot's graph instead of pipeline.graphJson.
// Governance (Phase 0): editor+ role for manual runs; the scheduler
// mini-service is the trusted machine caller when it presents a matching
// `x-service-token` (or, in demo mode with no token configured, via the
// historical no-cookie fallback). Schedule-originated runs audit as actorRole
// 'system' with detail "schedule <name|id>".

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { db } from '@/lib/db'
import {
  badRequest,
  jsonOk,
  notFound,
  serverError,
  zodErrorMessage,
} from '@/lib/api-utils'
import { enqueuePipelineJob } from '@/lib/execution-jobs'
import { audit, requireRole } from '@/lib/governance'
import { isDemoMode, isServiceAuthorized } from '@/lib/runtime-mode'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

const runOptionsSchema = z.object({
  scheduleId: z.string().min(1).nullish(),
  cascadeDepth: z.number().int().min(0).max(10).optional(),
})

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // Trusted machine callers (service token) bypass the editor guard — the
    // scheduler has no user session. Demo's no-cookie admin fallback goes
    // through the normal role guard when no service token is configured.
    if (!isServiceAuthorized(req)) {
      const denied = requireRole(req, 'editor')
      if (denied) return denied
    }

    const { id } = await params
    const pipeline = await db.pipeline.findUnique({ where: { id }, select: { id: true, name: true } })
    if (!pipeline) return notFound(`Pipeline '${id}' not found`)

    // Body is optional for backward compatibility (manual runs POST with no body).
    let body: unknown = {}
    try {
      const text = await req.text()
      if (text.trim() !== '') body = JSON.parse(text)
    } catch {
      return badRequest('Request body must be valid JSON')
    }
    const parsed = runOptionsSchema.safeParse(body)
    if (!parsed.success) return badRequest(zodErrorMessage(parsed))
    if ((parsed.data.cascadeDepth ?? 0) !== 0) return badRequest('cascadeDepth is not supported for queued runs')

    const scheduleId = parsed.data.scheduleId ?? null
    if (scheduleId) {
      if (!isDemoMode() && !isServiceAuthorized(req)) return badRequest('A service token is required for scheduled runs')
      const schedule = await db.schedule.findUnique({ where: { id: scheduleId } })
      if (!schedule || schedule.pipelineId !== id || !schedule.enabled || !schedule.nextRunAt || schedule.nextRunAt > new Date()) {
        return badRequest('Schedule is not due for this pipeline')
      }
      const dueAt = schedule.nextRunAt
      const job = await enqueuePipelineJob(id, {
        trigger: 'schedule', scheduleId,
        eventKey: `schedule:${scheduleId}:${dueAt.toISOString()}`,
        maxAttempts: 1,
      })
      // Reserve this window after the job is safely stored. A repeated POST
      // for the same window returns the same job via its unique event key.
      await db.schedule.updateMany({
        where: { id: scheduleId, nextRunAt: dueAt },
        data: {
          lastRunAt: new Date(),
          nextRunAt: new Date(Date.now() + schedule.intervalMinutes * 60_000),
        },
      })
      audit({ req, actorRole: 'system', action: 'pipeline.run', resourceType: 'pipeline',
        resourceId: id, resourceName: pipeline.name, detail: `schedule ${schedule.name} job=${job.id}` })
      return jsonOk({ job: { id: job.id, status: job.status, eventKey: job.eventKey } }, 202)
    }
    const requestKey = req.headers.get('idempotency-key')?.trim()
    if (requestKey && requestKey.length > 128) return badRequest('Idempotency-Key must be at most 128 characters')
    const job = await enqueuePipelineJob(id, {
      trigger: 'manual',
      eventKey: `manual:${id}:${requestKey || randomUUID()}`,
      maxAttempts: 1,
    })

    // Manual runs use the caller's role in the audit log.
    audit({
        req,
        action: 'pipeline.run',
        resourceType: 'pipeline',
        resourceId: pipeline.id,
        resourceName: pipeline.name,
        detail: `job=${job.id}`,
      })
    return jsonOk({ job: { id: job.id, status: job.status, eventKey: job.eventKey } }, 202)
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to run pipeline')
  }
}
