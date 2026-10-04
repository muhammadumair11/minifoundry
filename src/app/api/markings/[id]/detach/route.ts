// POST /api/markings/[id]/detach — remove a marking from dataset columns (admin).

import { z } from 'zod'
import type { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { badRequest, jsonOk, notFound, serverError, zodErrorMessage } from '@/lib/api-utils'
import { audit, requireRole } from '@/lib/governance'

export const dynamic = 'force-dynamic'

const detachSchema = z.object({
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
    const parsed = detachSchema.safeParse(body)
    if (!parsed.success) return badRequest(zodErrorMessage(parsed))

    const dataset = await db.dataset.findUnique({
      where: { id: parsed.data.datasetId },
      select: { id: true, name: true },
    })
    if (!dataset) return notFound(`Dataset '${parsed.data.datasetId}' not found`)

    const columns = [...new Set(parsed.data.columns)]

    const removed = await db.columnMarking.deleteMany({
      where: { datasetId: dataset.id, markingId: marking.id, columnName: { in: columns } },
    })

    audit({
      req,
      action: 'marking.detach',
      resourceType: 'marking',
      resourceId: marking.id,
      resourceName: marking.name,
      detail: `dataset '${dataset.name}': columns ${columns.join(', ')} (${removed.count} removed)`,
    })

    return jsonOk({ unmarked: removed.count })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to detach marking')
  }
}
