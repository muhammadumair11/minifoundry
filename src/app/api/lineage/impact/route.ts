// GET /api/lineage/impact?datasetId=X — P2 downstream impact view.
// Breadth-first walk over the dataset-level lineage graph starting at X:
// returns the transitive set of affected downstream datasets (with the depth
// and the pipeline that connects each one) for the impact side panel.

import type { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { badRequest, jsonOk, serverError } from '@/lib/api-utils'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
    const datasetId = new URL(req.url).searchParams.get('datasetId')
    if (!datasetId) return badRequest('datasetId query parameter is required')

    const root = await db.dataset.findUnique({
      where: { id: datasetId },
      select: { id: true, name: true },
    })
    if (!root) return badRequest(`Dataset '${datasetId}' not found`)

    const edges = await db.lineageEdge.findMany({
      select: { fromDatasetId: true, toDatasetId: true, pipelineId: true },
    })

    // BFS downstream from the root dataset (first/shortest hop wins).
    const downstream = new Map<string, { depth: number; viaPipelineId: string | null }>()
    let frontier: string[] = [datasetId]
    let depth = 0
    const MAX_DEPTH = 8
    while (frontier.length > 0 && depth < MAX_DEPTH) {
      depth += 1
      const next: string[] = []
      for (const edge of edges) {
        if (!frontier.includes(edge.fromDatasetId)) continue
        if (edge.toDatasetId === datasetId) continue // cycle guard
        if (downstream.has(edge.toDatasetId)) continue
        downstream.set(edge.toDatasetId, { depth, viaPipelineId: edge.pipelineId })
        next.push(edge.toDatasetId)
      }
      frontier = next
    }

    const affected = [...downstream.entries()]
    const datasetIds = [datasetId, ...affected.map(([id]) => id)]
    const [datasets, pipelines] = await Promise.all([
      db.dataset.findMany({
        where: { id: { in: datasetIds } },
        select: {
          id: true,
          name: true,
          qualityGate: true,
          versions: {
            orderBy: { versionNumber: 'desc' },
            take: 1,
            select: { versionNumber: true, rowCount: true },
          },
        },
      }),
      db.pipeline.findMany({ select: { id: true, name: true } }),
    ])

    const byId = new Map(datasets.map((d) => [d.id, d]))
    const pipelineNames = new Map(pipelines.map((p) => [p.id, p.name]))

    return jsonOk({
      root: {
        id: datasetId,
        name: root.name,
        headVersion: byId.get(datasetId)?.versions[0]?.versionNumber ?? 0,
      },
      affected: affected
        .map(([id, meta]) => ({
          id,
          name: byId.get(id)?.name ?? '(unknown)',
          depth: meta.depth,
          viaPipelineId: meta.viaPipelineId,
          viaPipelineName: meta.viaPipelineId ? (pipelineNames.get(meta.viaPipelineId) ?? null) : null,
          headVersion: byId.get(id)?.versions[0]?.versionNumber ?? 0,
          rowCount: byId.get(id)?.versions[0]?.rowCount ?? 0,
          gated: byId.get(id)?.qualityGate ?? false,
        }))
        .sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name)),
      total: affected.length,
      maxDepth: affected.reduce((m, [, meta]) => Math.max(m, meta.depth), 0),
    })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to compute impact')
  }
}
