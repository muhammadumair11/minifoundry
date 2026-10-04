// GET /api/objects?type={id|apiName}&query=&page=&pageSize=
//               &filters=<JSON [{property,op,value}]>&sortBy=&sortDir=
// Object explorer listing over the backing dataset's latest version. Rows are
// mapped to { pk, values, _title, _masked }; query is a case-insensitive
// substring match across stringified row values. R14.8: `filters` are the
// structured saved-view filters (op: eq|neq|contains|gt|lt|gte|lte|in) and
// sortBy/sortDir order the list — all applied server-side BEFORE pagination
// and AFTER governance masking so filters can never leak governed values.
// Governance: values of marked columns whose minRole is above the caller's
// role are masked ("------") before filtering, and each row carries an
// additive "_masked" list with the masked column names.

import { db } from '@/lib/db'
import { badRequest, jsonOk, notFound, serverError } from '@/lib/api-utils'
import {
  findObjectType,
  getObjectRows,
  MAX_VIEW_FILTERS,
  VIEW_FILTER_OPS,
  type ObjectViewFilter,
} from '@/lib/ontology-service'
import { getRole, maskedColumnsFor } from '@/lib/governance'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

/** Parse + validate the ?filters= JSON payload (400 with a clear message). */
function parseFilters(raw: string | null): ObjectViewFilter[] | { error: string } {
  if (!raw || raw.trim() === '' || raw === '[]') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { error: "'filters' must be a JSON array of {property, op, value}" }
  }
  if (!Array.isArray(parsed)) return { error: "'filters' must be a JSON array of {property, op, value}" }
  if (parsed.length > MAX_VIEW_FILTERS) {
    return { error: `'filters' accepts at most ${MAX_VIEW_FILTERS} entries` }
  }
  const out: ObjectViewFilter[] = []
  for (const item of parsed) {
    const f = item as Partial<ObjectViewFilter>
    if (!f || typeof f.property !== 'string' || f.property.trim() === '') {
      return { error: "every filter needs a 'property' column name" }
    }
    if (!f.op || !(VIEW_FILTER_OPS as readonly string[]).includes(f.op)) {
      return { error: `filter op must be one of: ${VIEW_FILTER_OPS.join(', ')}` }
    }
    out.push({ property: f.property.trim(), op: f.op as ObjectViewFilter['op'], value: String(f.value ?? '') })
  }
  return out
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const typeParam = url.searchParams.get('type')?.trim()
    if (!typeParam) return badRequest("Missing required query parameter 'type'")

    const objectType = await findObjectType(typeParam)
    if (!objectType) return notFound(`Object type '${typeParam}' not found`)

    const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1)
    const pageSize = Math.min(200, Math.max(1, Number(url.searchParams.get('pageSize') ?? '50') || 50))
    const query = url.searchParams.get('query')

    const filters = parseFilters(url.searchParams.get('filters'))
    if ('error' in filters) return badRequest(filters.error)

    const sortBy = url.searchParams.get('sortBy')?.trim() || null
    const sortDirRaw = url.searchParams.get('sortDir')?.trim()
    const sortDir: 'asc' | 'desc' = sortDirRaw === 'desc' ? 'desc' : 'asc'

    const maskedColumns = objectType.sourceDatasetId
      ? await maskedColumnsFor(objectType.sourceDatasetId, getRole(req))
      : []
    const { rows, total, columns } = await getObjectRows(objectType, {
      query,
      page,
      pageSize,
      maskColumns: maskedColumns,
      filters: Array.isArray(filters) ? filters : [],
      sortBy,
      sortDir,
    })

    return jsonOk({
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
      rows: rows.map((row) => ({ ...row, _masked: maskedColumns })),
      total,
      page,
      pageSize,
    })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load objects')
  }
}
