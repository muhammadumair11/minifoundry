// GET /api/pipelines/[id]/versions — version history for a pipeline.
// M3.1: lazily backfills v1 from the pipeline's current graph when it has zero
// versions (pre-versioning pipelines), then lists versions desc by versionNumber
// with the number of runs pinned to each (one groupBy query). Read endpoint —
// same guard posture as GET /api/pipelines/[id] (no role gate).

import { db } from '@/lib/db'
import { jsonOk, notFound, serverError } from '@/lib/api-utils'
import { ensurePipelineVersion } from '@/lib/pipeline-version-service'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const pipeline = await db.pipeline.findUnique({ where: { id }, select: { id: true } })
    if (!pipeline) return notFound(`Pipeline '${id}' not found`)

    // Lazily backfills v1 (no-op once the pipeline has versions).
    await ensurePipelineVersion(id)

    const [versions, runGroups] = await Promise.all([
      db.pipelineVersion.findMany({
        where: { pipelineId: id },
        orderBy: { versionNumber: 'desc' },
      }),
      db.pipelineRun.groupBy({
        by: ['versionNumber'],
        where: { pipelineId: id },
        _count: { _all: true },
      }),
    ])
    const runCountByVersion = new Map(
      runGroups.map((g) => [g.versionNumber, g._count._all]),
    )

    return jsonOk({
      versions: versions.map((v) => ({
        versionNumber: v.versionNumber,
        nodeCount: v.nodeCount,
        note: v.note,
        createdBy: v.createdBy,
        createdAt: v.createdAt,
        runCount: runCountByVersion.get(v.versionNumber) ?? 0,
      })),
    })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load pipeline versions')
  }
}
