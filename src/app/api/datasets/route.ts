// GET /api/datasets — catalog listing (no dataJson payloads).
//
// P5 scale track: the listing is BOUNDED and reads aggregates instead of
// materializing every version row:
//   ?limit=  1..200 (default 100)   ?offset= 0..10_000
// Version stats come from one groupBy (count + max versionNumber per dataset)
// and the head version's schema is fetched with a single targeted OR query —
// the catalog never loads N-versions × schemaJson for every dataset.

import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { badRequest, jsonOk, serverError, zodErrorMessage } from '@/lib/api-utils'
import { serializeDatasetSummary } from '@/lib/api-utils'
import type { Dataset } from '@prisma/client'

export const dynamic = 'force-dynamic'

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
})

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const parsed = querySchema.safeParse({
      limit: url.searchParams.get('limit') ?? undefined,
      offset: url.searchParams.get('offset') ?? undefined,
    })
    if (!parsed.success) return badRequest(zodErrorMessage(parsed))
    const { limit, offset } = parsed.data

    const [datasets, total, versionStats] = await Promise.all([
      db.dataset.findMany({
        orderBy: { updatedAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      db.dataset.count(),
      // per-dataset version count + head version number (one groupBy)
      db.datasetVersion.groupBy({
        by: ['datasetId'],
        _count: { versionNumber: true },
        _max: { versionNumber: true },
      }),
    ])

    // head versions (for columnCount) — one targeted query, at most one row
    // per dataset in the current page
    const headByVersionId = new Map(versionStats.map((s) => [s.datasetId, s._max.versionNumber ?? 0]))
    const headRows =
      datasets.length > 0
        ? await db.datasetVersion.findMany({
            where: {
              OR: datasets.map((d) => ({
                datasetId: d.id,
                versionNumber: headByVersionId.get(d.id) ?? 0,
              })),
            },
            select: { datasetId: true, versionNumber: true, rowCount: true, schemaJson: true },
          })
        : []
    const headByDatasetId = new Map(headRows.map((v) => [v.datasetId, v]))

    const statById = new Map(
      versionStats.map((s) => [s.datasetId, { count: s._count.versionNumber, head: s._max.versionNumber ?? 0 }]),
    )

    type HeadRow = { datasetId: string; versionNumber: number; rowCount: number; schemaJson: string }
    function summarize(dataset: Dataset, head: HeadRow | undefined) {
      return {
        ...serializeDatasetSummary(dataset, head ? [head] : []),
        versionsCount: statById.get(dataset.id)?.count ?? 0,
      }
    }

    return jsonOk({
      datasets: datasets.map((d) => summarize(d, headByDatasetId.get(d.id))),
      meta: { total, limit, offset },
    })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load datasets')
  }
}
