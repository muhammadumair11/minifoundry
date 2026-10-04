// GET /api/foundry/v1/datasets/[id]/export?version= — CSV export over the
// public API. Token-authed (viewer-role masking applies), rate-limited, NOT
// audited (public reads are not audited). Same CSV body as the session
// /api/datasets/[id]/export route (shared rowsToCsv helper).

import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { badRequest, notFound, parseJsonSafe, parseSchema, serverError } from '@/lib/api-utils'
import { getDatasetVersion, resolveConsumerVersion, type Row } from '@/lib/dataset-service'
import { applyMasking } from '@/lib/governance'
import { rowsToCsv, slugifyName } from '@/lib/csv'
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

      const schema = parseSchema(version)
      const raw = parseJsonSafe<Row[]>(version.dataJson, [])
      const { rows } = await applyMasking(id, raw, 'viewer')

      const filename = `${slugifyName(dataset.name)}-v${version.versionNumber}.csv`
      return new NextResponse(rowsToCsv(schema, rows), {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
      })
    })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to export dataset')
  }
}
