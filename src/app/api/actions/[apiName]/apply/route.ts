// POST /api/actions/[apiName]/apply — validate { params } against the action's
// parameter definitions and write back onto the backing dataset's latest
// version rows as a NEW DatasetVersion. 200 { ok:true, versionNumber, rowCount,
// objectPk } on success; 400 { error } on validation/write failure (a failed
// ActionLog row is written by the service before throwing).

import { z } from 'zod'
import { db } from '@/lib/db'
import { badRequest, jsonOk, notFound, serverError, zodErrorMessage } from '@/lib/api-utils'
import { applyAction } from '@/lib/ontology-service'
import { audit, requireRole } from '@/lib/governance'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

const applySchema = z.object({
  params: z.record(z.string(), z.unknown()).optional(),
})

export async function POST(req: NextRequest, { params }: { params: Promise<{ apiName: string }> }) {
  try {
    const denied = requireRole(req, 'editor')
    if (denied) return denied

    const { apiName } = await params
    const include = { objectType: { include: { sourceDataset: true } } }
    const action =
      (await db.actionType.findUnique({ where: { apiName }, include })) ??
      (await db.actionType.findUnique({ where: { id: apiName }, include }))
    if (!action) return notFound(`Action '${apiName}' not found`)

    let body: unknown
    try {
      body = await req.json()
    } catch {
      return badRequest('Request body must be valid JSON')
    }
    const parsed = applySchema.safeParse(body)
    if (!parsed.success) return badRequest(zodErrorMessage(parsed))

    try {
      const result = await applyAction(action, parsed.data.params ?? {})
      audit({
        req,
        action: 'action.apply',
        resourceType: 'ontology',
        resourceId: action.id,
        resourceName: action.displayName,
        detail: `${action.apiName} on ${action.objectType.displayName}${result.objectPk ? ` '${result.objectPk}'` : ''} -> v${result.versionNumber} (${result.rowCount} rows)`,
      })
      return jsonOk({ ok: true, ...result })
    } catch (err) {
      // applyAction already logged the failure (result: 'failed')
      const msg = err instanceof Error ? err.message : 'Failed to apply action'
      audit({
        req,
        action: 'action.apply',
        resourceType: 'ontology',
        resourceId: action.id,
        resourceName: action.displayName,
        detail: `FAILED ${action.apiName}: ${msg}`,
      })
      return badRequest(msg)
    }
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to apply action')
  }
}
