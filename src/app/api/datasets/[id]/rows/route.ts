// GET /api/datasets/[id]/rows — paginated rows of a dataset version with
// substring search (?query=), optional sort (?orderBy=<col>&dir=asc|desc).
// Governance: rows are MASKED per the caller's role BEFORE search/sort/
// pagination, so neither cell values nor the search filter can leak values
// the role may not see. Column schemas carry additive "markedWith" and the
// response carries additive "maskedColumns" (masked column names).

import { db } from '@/lib/db'
import { badRequest, jsonError, jsonOk, notFound, parseJsonSafe, parseSchema, serverError } from '@/lib/api-utils'
import { compareValues, getDatasetVersion, readVersionRowsPaged, resolveConsumerVersion, type Row } from '@/lib/dataset-service'
import { applyMasking, getRole, maskSchema } from '@/lib/governance'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

/** R14: when no explicit version is requested, ?branch=<name> resolves to that branch's head. */
async function branchHeadFallback(datasetId: string, branchName: string | null): Promise<number | undefined> {
  if (!branchName || branchName === 'main') return undefined
  const branch = await db.datasetBranch.findUnique({
    where: { datasetId_name: { datasetId, name: branchName } },
    select: { headVersion: true },
  })
  return branch?.headVersion
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const dataset = await db.dataset.findUnique({ where: { id }, select: { id: true, name: true } })
    if (!dataset) return notFound(`Dataset '${id}' not found`)

    const url = new URL(req.url)

    // version (optional — defaults to latest)
    let versionNumber: number | undefined
    const versionParam = url.searchParams.get('version')
    if (versionParam !== null && versionParam !== '') {
      const n = Number(versionParam)
      if (!Number.isInteger(n) || n < 1) {
        return badRequest(`Invalid 'version' parameter: '${versionParam}'`)
      }
      versionNumber = n
    }
    const branchVersion = await branchHeadFallback(id, url.searchParams.get('branch'))
    const role = getRole(req)
    const consumer = role === 'viewer' && versionNumber == null && branchVersion == null
      ? await resolveConsumerVersion(id) : null
    const selectedVersion = versionNumber ?? branchVersion ?? consumer?.versionNumber
    const version = selectedVersion == null && role === 'viewer'
      ? null : await getDatasetVersion(id, selectedVersion ?? undefined)
    if (!version) {
      return notFound(
        versionNumber !== undefined
          ? `Version ${versionNumber} not found for dataset '${dataset.name}'`
          : `Dataset '${dataset.name}' has no versions`,
      )
    }
    if (role === 'viewer' && version.lifecycle !== 'published') {
      return jsonError(403, 'Draft and branch versions require editor role')
    }

    const columns = parseSchema(version)

    // pagination params (pageSize capped at 200)
    const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1)
    const pageSize = Math.min(200, Math.max(1, Number(url.searchParams.get('pageSize') ?? '50') || 50))
    const query = url.searchParams.get('query')
    const orderBy = url.searchParams.get('orderBy')

    // When no search/sort is needed, use paged reads from indexed storage
    if (!query && !orderBy) {
      const paged = await readVersionRowsPaged(id, version.versionNumber, page, pageSize)
      const { rows: maskedRows, maskedColumns } = await applyMasking(id, paged.rows, role)
      return jsonOk({
        rows: maskedRows,
        total: paged.total,
        page,
        pageSize,
        columns: await maskSchema(columns, id),
        maskedColumns,
      })
    }

    // For search/sort, load all rows (masked first for security)
    const raw = parseJsonSafe<Row[]>(version.dataJson, [])
    const { rows: maskedRows, maskedColumns } = await applyMasking(id, raw, role)
    let rows = maskedRows

    if (query) {
      const q = query.toLowerCase()
      rows = rows.filter((row) =>
        JSON.stringify(Object.values(row)).toLowerCase().includes(q),
      )
    }

    if (orderBy) {
      const dir = url.searchParams.get('dir') === 'desc' ? 'desc' : 'asc'
      rows = [...rows].sort((a, b) => {
        const cmp = compareValues(a[orderBy], b[orderBy])
        return dir === 'desc' ? -cmp : cmp
      })
    }

    const total = rows.length
    const start = (page - 1) * pageSize

    return jsonOk({
      rows: rows.slice(start, start + pageSize),
      total,
      page,
      pageSize,
      columns: await maskSchema(columns, id),
      maskedColumns,
    })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load dataset rows')
  }
}
