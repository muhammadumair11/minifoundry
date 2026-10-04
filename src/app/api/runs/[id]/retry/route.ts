// POST /api/runs/[id]/retry — enqueue a durable retry of the pipeline that
// produced this run. Pins the latest pipeline version at enqueue time.

import { db } from '@/lib/db'
import { jsonOk, notFound, serverError } from '@/lib/api-utils'
import { ensurePipelineVersion } from '@/lib/pipeline-version-service'
import { enqueuePipelineJob } from '@/lib/execution-jobs'
import { audit, requireRole } from '@/lib/governance'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const denied = requireRole(req, 'editor')
    if (denied) return denied

    const { id } = await params
    const run = await db.pipelineRun.findUnique({
      where: { id },
      select: { id: true, pipelineId: true, pipeline: { select: { id: true, name: true } } },
    })
    if (!run) return notFound(`Run '${id}' not found`)

    const version = await ensurePipelineVersion(run.pipelineId)
    const eventKey = `retry:${run.id}:${Date.now()}`
    const job = await enqueuePipelineJob(run.pipelineId, {
      trigger: 'retry',
      eventKey,
      graphVersionNumber: version.versionNumber,
      payload: { parentRunId: run.id },
      maxAttempts: 1,
    })

    audit({
      req, action: 'pipeline.run', resourceType: 'pipeline', resourceId: run.pipeline.id,
      resourceName: run.pipeline.name, detail: `queued retry of run ${id} (job ${job.id})`,
    })

    return jsonOk({ job: { id: job.id, status: job.status, eventKey: job.eventKey } })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to queue retry')
  }
}
