// POST /api/pipelines/[id]/restore — restore a pipeline to a previous version.
// Body { versionNumber }. M3.1: sets pipeline.graphJson to the snapshot's graph
// (persisted) and THEN snapshots it as the NEXT version with note
// "restored from v<N>", so the history records the restore as an append-only
// event. Governance: editor+ role; audited as pipeline.restore.

import { z } from 'zod'
import { db } from '@/lib/db'
import {
  badRequest,
  jsonOk,
  notFound,
  parseJsonSafe,
  serverError,
  zodErrorMessage,
} from '@/lib/api-utils'
import type { PipelineGraph } from '@/lib/engine'
import { getPipelineVersion, snapshotPipelineVersion } from '@/lib/pipeline-version-service'
import { audit, getActor, requireRole } from '@/lib/governance'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

const restoreSchema = z.object({
  versionNumber: z.number().int().min(1),
})

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const denied = requireRole(req, 'editor')
    if (denied) return denied

    const { id } = await params
    const pipeline = await db.pipeline.findUnique({
      where: { id },
      select: { id: true, name: true },
    })
    if (!pipeline) return notFound(`Pipeline '${id}' not found`)

    let body: unknown
    try {
      body = await req.json()
    } catch {
      return badRequest('Request body must be valid JSON')
    }
    const parsed = restoreSchema.safeParse(body)
    if (!parsed.success) return badRequest(zodErrorMessage(parsed))

    const snapshot = await getPipelineVersion(id, parsed.data.versionNumber)
    if (!snapshot) {
      return notFound(`Version '${parsed.data.versionNumber}' not found for pipeline '${id}'`)
    }

    // Restore = set the pipeline's graph to the snapshot, then append the restore
    // as a new version (history stays append-only; the source snapshot is kept).
    const updated = await db.pipeline.update({
      where: { id },
      data: { graphJson: snapshot.graphJson },
    })
    const actor = getActor(req)
    const version = await snapshotPipelineVersion(id, snapshot.graphJson, {
      note: `restored from v${snapshot.versionNumber}`,
      createdBy: actor.email ?? actor.role,
    })

    audit({
      req,
      action: 'pipeline.restore',
      resourceType: 'pipeline',
      resourceId: pipeline.id,
      resourceName: pipeline.name,
      detail: `from=${snapshot.versionNumber} to=${version.versionNumber}`,
    })

    return jsonOk({
      pipeline: {
        id: updated.id,
        name: updated.name,
        description: updated.description,
        graph: parseJsonSafe<PipelineGraph | null>(updated.graphJson, null),
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
      },
      version: {
        versionNumber: version.versionNumber,
        nodeCount: version.nodeCount,
        note: version.note,
        createdBy: version.createdBy,
        createdAt: version.createdAt,
      },
    })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to restore pipeline version')
  }
}
