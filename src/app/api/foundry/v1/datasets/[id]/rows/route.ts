// GET /api/foundry/v1/datasets/[id]/rows?version=&page=&pageSize= — paginated
// rows of a dataset version for the public API. Rows are masked for the
// VIEWER role (API tokens are viewers — column markings hold) BEFORE
// pagination, so governed values never cross the API boundary. pagination
// total = version.rowCount.

import { db } from '@/lib/db'
import { badRequest, jsonOk, notFound, parseJsonSafe, parseSchema, serverError } from '@/lib/api-utils'
import { getDatasetVersion, resolveConsumerVersion, type Row } from '@/lib/dataset-service'
import { applyMasking } from '@/lib/governance'
import { v1PageFrom, v1Pagination, withApiToken } from '@/lib/api-v1'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    return await withApiToken(req, async () => {
      const { id } = await params
      const dataset = await db.dataset.findUnique({ where: { id }, select: { id: true, name: true } })
      if (!dataset) return notFound(`Dataset '${id}' not found`)

      const url = new URL(req.url)
      let versionNumber: number | undefined
      const versionParam = url.searchParams.get('version')
      if (versionParam !== null && versionParam !== '') {
        const n = Number(versionParam)
        if (!Number.isInteger(n) || n < 1) {
          return badRequest(`Invalid 'version' parameter: '${versionParam}'`)
        }
        versionNumber = n
      }
      // P2: the public API is a consumer — gated datasets default to the last
      // published version (an explicit ?version= still wins).
      if (versionNumber === undefined) {
        const consumer = await resolveConsumerVersion(id)
        versionNumber = consumer?.versionNumber ?? undefined
      }
      const version = await getDatasetVersion(id, versionNumber)
      if (!version) {
        return notFound(
          versionNumber !== undefined
            ? `Version ${versionNumber} not found for dataset '${dataset.name}'`
            : `Dataset '${dataset.name}' has no versions`,
        )
      }

      const { page, pageSize } = v1PageFrom(url)

      // Mask FIRST (viewer role), then paginate — masking always precedes any
      // row-shaped access so no governed value can leak.
      const raw = parseJsonSafe<Row[]>(version.dataJson, [])
      const { rows, maskedColumns } = await applyMasking(id, raw, 'viewer')
      const start = (page - 1) * pageSize

      return jsonOk({
        data: rows.slice(start, start + pageSize),
        pagination: v1Pagination({ page, pageSize }, version.rowCount),
        version: { versionNumber: version.versionNumber, rowCount: version.rowCount },
        maskedColumns,
      })
    })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load dataset rows')
  }
}
