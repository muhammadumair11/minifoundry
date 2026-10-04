// POST /api/runs/[id]/replay — enqueue a durable replay of a past run.
// The job pins the original graph version and input versions from the manifest,
// so replays are reproducible even if newer versions exist. Returns the queued
// job; the worker executes asynchronously.

import { db } from '@/lib/db'
import { badRequest, jsonOk, notFound, parseJsonSafe, serverError } from '@/lib/api-utils'
import type { RunManifest } from '@/lib/engine'
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
      select: {
        id: true, pipelineId: true, versionNumber: true, manifestJson: true,
        pipeline: { select: { id: true, name: true } },
      },
    })
    if (!run) return notFound(`Run '${id}' not found`)
    if (!run.manifestJson) {
      return badRequest('This run has no recorded build manifest — it cannot be replayed from recorded inputs.')
    }
    const manifest = parseJsonSafe<RunManifest | null>(run.manifestJson, null)
    if (!manifest) return badRequest('Run manifest is unreadable — cannot replay')

    const graphVersion = await db.pipelineVersion.findUnique({
      where: { pipelineId_versionNumber: { pipelineId: run.pipelineId, versionNumber: run.versionNumber ?? 1 } },
      select: { versionNumber: true },
    })
    if (!graphVersion) {
      return badRequest(`Pinned pipeline version v${run.versionNumber ?? '?'} no longer exists — cannot replay faithfully`)
    }

    const inputOverrides: Record<string, number> = {}
    for (const input of manifest.inputs) {
      if (input.versionNumber != null) inputOverrides[input.datasetId] = input.versionNumber
    }

    const eventKey = `replay:${run.id}:${Date.now()}`
    const job = await enqueuePipelineJob(run.pipelineId, {
      trigger: 'replay',
      eventKey,
      graphVersionNumber: graphVersion.versionNumber,
      payload: { inputOverrides, replayOfRunId: run.id },
    })

    audit({
      req, action: 'pipeline.run', resourceType: 'pipeline', resourceId: run.pipeline.id,
      resourceName: run.pipeline.name,
      detail: `queued replay of run ${id} (job ${job.id})`,
    })

    return jsonOk({ job: { id: job.id, status: job.status, eventKey: job.eventKey } })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to queue replay')
  }
}
