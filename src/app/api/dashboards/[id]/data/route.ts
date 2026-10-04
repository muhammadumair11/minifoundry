// POST /api/dashboards/[id]/data — server-side widget aggregation (source of
// truth for dashboard charts). Phase 0: viewer+ role required AND column
// masking is applied BEFORE any aggregation, so a marked column neither leaks
// through `table` rows, through group labels, nor as an aggregate input
// (masked cells become MASK_LITERAL, which is non-numeric for aggs).
//
// Body: { widget: DashboardWidget }. Loads the dataset's LATEST version rows
// (dataJson), masks them per the caller's role, then applies:
//   bar/line/pie/area → groupBy (column) + agg over valueColumn
//     (count|sum|avg|min|max; count needs no valueColumn) → [{ name, value }]
//     sorted by value (desc default) limited to topN (default 10)
//   stat → single row { name: 'value', value } — agg over the whole dataset
//     ('count' = row count; numeric aggs need valueColumn)
//   table → first topN (default 10) raw rows
// Missing columns fail gracefully with 400 { error } messages.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { badRequest, notFound, parseJsonSafe, serverError, zodErrorMessage } from '@/lib/api-utils'
import { resolveConsumerVersion } from '@/lib/dataset-service'
import { applyMasking, getRole } from '@/lib/governance'
import type { DashboardWidget } from '@/lib/foundry-types'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

const widgetBodySchema = z.object({
  id: z.string().min(1),
  type: z.enum(['bar', 'line', 'pie', 'area', 'stat', 'table']),
  title: z.string().min(1).max(200),
  datasetId: z.string().min(1),
  datasetName: z.string().max(200).optional(),
  config: z
    .object({
      groupBy: z.string().max(200).optional(),
      valueColumn: z.string().max(200).optional(),
      agg: z.enum(['count', 'sum', 'avg', 'min', 'max']).optional(),
      topN: z.number().int().min(1).max(100).optional(),
      sortDir: z.enum(['asc', 'desc']).optional(),
    })
    .default({}),
  span: z.union([z.literal(1), z.literal(2)]).optional(),
})

const bodySchema = z.object({ widget: widgetBodySchema })

type Agg = 'count' | 'sum' | 'avg' | 'min' | 'max'

/** Extract a finite number from a cell; null when the cell is not numeric. */
function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** Stable display label for a group key — nulls/undefined collapse to '(empty)'. */
function groupLabel(v: unknown): string {
  if (v === null || v === undefined || v === '') return '(empty)'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return String(v)
}

/** Apply an aggregate over the numeric values of one group (count uses the row count). */
function aggregate(agg: Agg, count: number, values: number[]): number {
  switch (agg) {
    case 'count':
      return count
    case 'sum':
      return values.reduce((a, b) => a + b, 0)
    case 'avg':
      return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0
    case 'min':
      return values.length ? Math.min(...values) : 0
    case 'max':
      return values.length ? Math.max(...values) : 0
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    // Phase 0: dashboards are a consumption path — no anonymous reads in
    // shared mode (anonymous role level is below viewer, so this 403s).
    const role = getRole(req)

    const { id } = await params
    let body: unknown
    try {
      body = await req.json()
    } catch {
      return badRequest('Request body must be valid JSON')
    }
    const parsed = bodySchema.safeParse(body)
    if (!parsed.success) return badRequest(zodErrorMessage(parsed))
    const widget = parsed.data.widget as DashboardWidget

    const dashboard = await db.dashboard.findUnique({ where: { id }, select: { id: true } })
    if (!dashboard) return notFound(`Dashboard '${id}' not found`)

    // Dashboards are consumers — P2: gated datasets reflect the last
    // PUBLISHED version (drafts stay studio-only), ungated ones the head.
    const consumer = await resolveConsumerVersion(widget.datasetId)
    const version = consumer?.versionNumber
      ? await db.datasetVersion.findFirst({
          where: { datasetId: widget.datasetId, versionNumber: consumer.versionNumber },
          select: { dataJson: true, rowCount: true },
        })
      : null
    if (!version) return badRequest(`Dataset '${widget.datasetId}' has no versions`)

    const dataset = await db.dataset.findUnique({
      where: { id: widget.datasetId },
      select: { name: true },
    })
    if (!dataset) return notFound(`Dataset '${widget.datasetId}' not found`)

    // Phase 0: mask BEFORE aggregating — a marked column must not leak via
    // table rows, group labels, or as an aggregate value input. Masked cells
    // hold MASK_LITERAL ('------'), which toNumber() treats as non-numeric.
    const rawRows = parseJsonSafe<Record<string, unknown>[]>(version.dataJson, [])
    const { rows: allRows, maskedColumns } = await applyMasking(widget.datasetId, rawRows, role)
    const rowCount = version.rowCount ?? allRows.length
    const cfg = widget.config
    const topN = cfg.topN ?? 10
    const agg: Agg = cfg.agg ?? 'count'

    // ─── stat: one aggregate over the whole dataset ────────────────────
    if (widget.type === 'stat') {
      if (agg === 'count') {
        return NextResponse.json({ rows: [{ name: 'value', value: rowCount }], datasetName: dataset.name, rowCount, maskedColumns })
      }
      if (!cfg.valueColumn) {
        return badRequest(`stat widget with agg '${agg}' needs a valueColumn`)
      }
      const values = allRows
        .map((r) => toNumber(r[cfg.valueColumn as string]))
        .filter((n): n is number => n !== null)
      return NextResponse.json({
        rows: [{ name: 'value', value: aggregate(agg, allRows.length, values) }],
        datasetName: dataset.name,
        rowCount,
        maskedColumns,
      })
    }

    // ─── table: first topN raw rows ────────────────────────────────────
    if (widget.type === 'table') {
      return NextResponse.json({ rows: allRows.slice(0, topN), datasetName: dataset.name, rowCount, maskedColumns })
    }

    // ─── bar/line/pie/area: groupBy + agg → [{ name, value }] ─────────
    if (!cfg.groupBy) {
      return badRequest(`Widget needs a groupBy column (type '${widget.type}')`)
    }
    const groupBy = cfg.groupBy
    if (allRows.length > 0 && !(groupBy in allRows[0])) {
      return badRequest(`Column '${groupBy}' not found in dataset '${dataset.name}'`)
    }
    const needsValue = agg !== 'count'
    if (needsValue && !cfg.valueColumn) {
      return badRequest(`agg '${agg}' needs a valueColumn`)
    }
    const valueColumn = cfg.valueColumn
    if (needsValue && valueColumn && allRows.length > 0 && !(valueColumn in allRows[0])) {
      return badRequest(`Column '${valueColumn}' not found in dataset '${dataset.name}'`)
    }

    const groups = new Map<string, { count: number; values: number[] }>()
    for (const row of allRows) {
      const key = groupLabel(row[groupBy])
      let g = groups.get(key)
      if (!g) {
        g = { count: 0, values: [] }
        groups.set(key, g)
      }
      g.count += 1
      if (needsValue && valueColumn) {
        const n = toNumber(row[valueColumn])
        if (n !== null) g.values.push(n)
      }
    }

    let rows = [...groups.entries()].map(([name, g]) => ({
      name,
      value: aggregate(agg, g.count, g.values),
    }))
    // Value sort (desc default); ties fall back to name asc for stable output.
    const dir = cfg.sortDir === 'asc' ? 1 : -1
    rows.sort((a, b) => (a.value - b.value) * dir || a.name.localeCompare(b.name))
    rows = rows.slice(0, topN)

    return NextResponse.json({ rows, datasetName: dataset.name, rowCount, maskedColumns })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to compute widget data')
  }
}
