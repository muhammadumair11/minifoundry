// POST /api/pipelines/[id]/run — synchronous pipeline execution.
// Optional JSON body { scheduleId?, cascadeDepth? } (body may be empty = manual run).
// When scheduleId is set, the engine advances that schedule's window after the run.
// M3.1: every run pins the pipeline version it executed — ensurePipelineVersion
// backfills v1 lazily (pre-versioning pipelines) and the engine executes that
// snapshot's graph instead of pipeline.graphJson.
// Governance (Phase 0): editor+ role for manual runs; the scheduler
// mini-service is the trusted machine caller when it presents a matching
// `x-service-token` (or, in demo mode with no token configured, via the
// historical no-cookie fallback). Schedule-originated runs audit as actorRole
// 'system' with detail "schedule <name|id>".

import { z } from 'zod'
import { db } from '@/lib/db'
import {
  badRequest,
  jsonOk,
  notFound,
  serializeRun,
  serverError,
  zodErrorMessage,
} from '@/lib/api-utils'
import { runPipelineVersion } from '@/lib/engine'
import { audit, requireRole } from '@/lib/governance'
import { isServiceAuthorized } from '@/lib/runtime-mode'
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
    // scheduler has no user session. In demo mode with no MF_SERVICE_TOKEN
    // configured this is always true (historical no-cookie behavior).
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

    const scheduleId = parsed.data.scheduleId ?? null
    // R14: shared entry point — pins the latest PipelineVersion (lazily
    // backfills v1), records trigger "schedule" for scheduler-originated
    // calls (they send { scheduleId }) and "manual" otherwise. Behavior and
    // response shape are unchanged from the pre-R14 route.
    const run = await runPipelineVersion(id, {
      trigger: scheduleId ? 'schedule' : 'manual',
      attempt: 1,
      scheduleId,
      cascadeDepth: parsed.data.cascadeDepth ?? 0,
    })

    // Scheduled runs (scheduler mini-service sends { scheduleId }, no cookie)
    // audit as actorRole 'system'; manual runs use the caller's role.
    if (scheduleId) {
      const schedule = await db.schedule.findUnique({ where: { id: scheduleId }, select: { name: true } })
      audit({
        req,
        actorRole: 'system',
        action: 'pipeline.run',
        resourceType: 'pipeline',
        resourceId: pipeline.id,
        resourceName: pipeline.name,
        detail: `schedule ${schedule?.name ?? scheduleId}`,
      })
    } else {
      audit({
        req,
        action: 'pipeline.run',
        resourceType: 'pipeline',
        resourceId: pipeline.id,
        resourceName: pipeline.name,
      })
    }

    // A graph/validation failure is recorded on the run (status 'failed' + logs)
    // and returned as a normal 200 so the UI can display the run's log stream.
    return jsonOk({ run: serializeRun(run) })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to run pipeline')
  }
}
