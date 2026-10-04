// GET /api/datasets/[id]/export?version= — CSV export of a dataset version.
// Session-authed READ (viewer+ allowed — no requireRole, reads are open):
// rows are masked per the caller's role (column markings) BEFORE
// serialization, so governed values never leave the platform unmasked.
// Response: text/csv attachment `<slug>-v<versionNumber>.csv`, audited as
// dataset.export. The token-authed public variant lives at
// /api/foundry/v1/datasets/[id]/export (rate-limited, not audited).

import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { badRequest, notFound, parseJsonSafe, parseSchema, serverError } from '@/lib/api-utils'
import { getDatasetVersion, type Row } from '@/lib/dataset-service'
import { applyMasking, audit, getRole } from '@/lib/governance'
import { rowsToCsv, slugifyName } from '@/lib/csv'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
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
    const role = getRole(req)
    const { rows } = await applyMasking(id, raw, role)

    audit({
      req,
      action: 'dataset.export',
      resourceType: 'dataset',
      resourceId: dataset.id,
      resourceName: dataset.name,
      detail: `version=${version.versionNumber} rows=${rows.length} format=csv`,
    })

    const filename = `${slugifyName(dataset.name)}-v${version.versionNumber}.csv`
    return new NextResponse(rowsToCsv(schema, rows), {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to export dataset')
  }
}
