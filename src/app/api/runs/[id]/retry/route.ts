// POST /api/runs/[id]/retry — re-run the pipeline that produced this run.
// Returns 200 with the NEW run even when that run failed (consistent with
// POST /api/pipelines/[id]/run), so the UI can render the new run's logs.
// M3.1: the retried run pins the pipeline's latest version like any other run.
// Governance: editor+ role; audited as pipeline.run with a retry detail.

import { db } from '@/lib/db'
import { jsonOk, notFound, serializeRun, serverError } from '@/lib/api-utils'
import { runPipeline } from '@/lib/engine'
import { ensurePipelineVersion } from '@/lib/pipeline-version-service'
import { audit, requireRole } from '@/lib/governance'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const denied = requireRole(req, 'editor')
    if (denied) return denied

    const { id } = await params
    const run = await db.pipelineRun.findUnique({
      where: { id },
      select: { pipelineId: true, pipeline: { select: { id: true, name: true } } },
    })
    if (!run) return notFound(`Run '${id}' not found`)

    // Manual retry: no scheduleId, cascadeDepth 0. Downstream cascades still apply.
    // M3.1: pin the retried run to the pipeline's latest version.
    const version = await ensurePipelineVersion(run.pipelineId)
    const newRun = await runPipeline(run.pipelineId, {
      graphOverride: version.graphJson,
      versionNumber: version.versionNumber,
    })

    audit({
      req,
      action: 'pipeline.run',
      resourceType: 'pipeline',
      resourceId: run.pipeline.id,
      resourceName: run.pipeline.name,
      detail: `retry of run ${id}`,
    })

    return jsonOk({ run: serializeRun(newRun) })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to retry run')
  }
}
