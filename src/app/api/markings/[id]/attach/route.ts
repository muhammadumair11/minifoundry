// POST /api/markings/[id]/attach — attach a marking to dataset columns (admin).
// Upserts one ColumnMarking per (datasetId, columnName); a column carries at
// most one marking (re-attaching re-points it to this marking).

import { z } from 'zod'
import type { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { badRequest, jsonOk, notFound, serverError, zodErrorMessage } from '@/lib/api-utils'
import { audit, requireRole } from '@/lib/governance'

export const dynamic = 'force-dynamic'

const attachSchema = z.object({
  datasetId: z.string().min(1, 'datasetId is required'),
  columns: z.array(z.string().trim().min(1, 'column names must be non-empty')).min(1, 'columns must not be empty'),
})

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const denied = requireRole(req, 'admin')
    if (denied) return denied

    const { id } = await params
    const marking = await db.marking.findUnique({ where: { id }, select: { id: true, name: true } })
    if (!marking) return notFound(`Marking '${id}' not found`)

    let body: unknown
    try {
      body = await req.json()
    } catch {
      return badRequest('Request body must be valid JSON')
    }
    const parsed = attachSchema.safeParse(body)
    if (!parsed.success) return badRequest(zodErrorMessage(parsed))

    const dataset = await db.dataset.findUnique({
      where: { id: parsed.data.datasetId },
      select: { id: true, name: true },
    })
    if (!dataset) return notFound(`Dataset '${parsed.data.datasetId}' not found`)

    // Dedupe while preserving order.
    const columns = [...new Set(parsed.data.columns)]

    let marked = 0
    for (const columnName of columns) {
      const existing = await db.columnMarking.findUnique({
        where: { datasetId_columnName: { datasetId: dataset.id, columnName } },
        select: { id: true, markingId: true },
      })
      if (existing?.markingId === marking.id) continue // already attached here
      await db.columnMarking.upsert({
        where: { datasetId_columnName: { datasetId: dataset.id, columnName } },
        create: { datasetId: dataset.id, columnName, markingId: marking.id },
        update: { markingId: marking.id },
      })
      marked++
    }

    audit({
      req,
      action: 'marking.attach',
      resourceType: 'marking',
      resourceId: marking.id,
      resourceName: marking.name,
      detail: `dataset '${dataset.name}': columns ${columns.join(', ')} (${marked} newly marked)`,
    })

    return jsonOk({ marked })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to attach marking')
  }
}
