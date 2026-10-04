// GET /api/lineage — lineage graph nodes (datasets) + edges (LineageEdge table).

import { db } from '@/lib/db'
import { jsonOk, serverError } from '@/lib/api-utils'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const [datasets, edges] = await Promise.all([
      db.dataset.findMany({
        orderBy: { createdAt: 'asc' },
        include: {
          versions: {
            orderBy: { versionNumber: 'desc' },
            take: 1,
            select: { rowCount: true },
          },
        },
      }),
      db.lineageEdge.findMany({ orderBy: { createdAt: 'asc' } }),
    ])

    const derivedIds = new Set(edges.map((e) => e.toDatasetId))

    return jsonOk({
      nodes: datasets.map((d) => ({
        id: d.id,
        name: d.name,
        kind: derivedIds.has(d.id) ? ('derived' as const) : ('source' as const),
        rowCount: d.versions[0]?.rowCount ?? 0,
        updatedAt: d.updatedAt,
      })),
      edges: edges.map((e) => ({
        id: e.id,
        from: e.fromDatasetId,
        to: e.toDatasetId,
        pipelineId: e.pipelineId,
      })),
    })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load lineage')
  }
}
