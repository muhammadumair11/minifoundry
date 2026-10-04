// GET /api/foundry/v1/pipelines/[id] — pipeline detail over the public API.
// Returns the stored graph (both as a flat `nodes` array and the full
// `graph` object with edges) plus the 5 latest run summaries (no logs).

import { db } from '@/lib/db'
import { jsonOk, notFound, parseJsonSafe, serverError } from '@/lib/api-utils'
import type { PipelineGraph } from '@/lib/engine'
import { withApiToken } from '@/lib/api-v1'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    return await withApiToken(req, async () => {
      const { id } = await params
      const pipeline = await db.pipeline.findUnique({ where: { id } })
      if (!pipeline) return notFound(`Pipeline '${id}' not found`)

      const graph = parseJsonSafe<PipelineGraph | null>(pipeline.graphJson, null)
      const lastRuns = await db.pipelineRun.findMany({
        where: { pipelineId: id },
        orderBy: { startedAt: 'desc' },
        take: 5,
        select: { id: true, status: true, startedAt: true, finishedAt: true },
      })

      return jsonOk({
        pipeline: {
          id: pipeline.id,
          name: pipeline.name,
          description: pipeline.description,
          nodes: graph?.nodes ?? [],
          graph: graph ?? { nodes: [], edges: [] },
          lastRuns,
        },
      })
    })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load pipeline')
  }
}
