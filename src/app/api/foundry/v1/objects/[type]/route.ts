// GET /api/foundry/v1/objects/[type]?page=&pageSize=&q= — object listing over
// the public API. Reuses findObjectType + getObjectRows (same masking-before-
// search/pagination behavior and the same pk/_title fields as the session
// /api/objects endpoint); `q` is a case-insensitive substring match across
// stringified row values. Rows carry additive _masked (masked column names).

import { jsonOk, notFound, serverError } from '@/lib/api-utils'
import { findObjectType, getObjectRows } from '@/lib/ontology-service'
import { maskedColumnsFor } from '@/lib/governance'
import { v1PageFrom, v1Pagination, withApiToken } from '@/lib/api-v1'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ type: string }> },
) {
  try {
    return await withApiToken(req, async () => {
      const { type } = await params
      const objectType = await findObjectType(type)
      if (!objectType) return notFound(`Object type '${type}' not found`)

      const url = new URL(req.url)
      const { page, pageSize } = v1PageFrom(url)
      const q = url.searchParams.get('q')

      const maskedColumns = objectType.sourceDatasetId
        ? await maskedColumnsFor(objectType.sourceDatasetId, 'viewer')
        : []
      const { rows, total, columns } = await getObjectRows(objectType, {
        query: q,
        page,
        pageSize,
        maskColumns: maskedColumns,
      })

      return jsonOk({
        data: rows.map((row) => ({ ...row, _masked: maskedColumns })),
        pagination: v1Pagination({ page, pageSize }, total),
        objectType: {
          id: objectType.id,
          apiName: objectType.apiName,
          displayName: objectType.displayName,
          primaryKey: objectType.primaryKey,
          icon: objectType.icon,
          color: objectType.color,
          titleProperty:
            objectType.properties.find((p) => p.isTitle)?.apiName ?? objectType.primaryKey ?? null,
        },
        columns,
      })
    })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load objects')
  }
}
