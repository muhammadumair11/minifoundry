// PATCH/DELETE /api/datasets/[id]/quality/[ruleId] — update (enabled,
// severity, name, config, column) or delete a quality rule. Editor+ required.

import { z } from 'zod'
import { db } from '@/lib/db'
import { badRequest, jsonError, jsonOk, serverError, zodErrorMessage } from '@/lib/api-utils'
import { audit, requireRole } from '@/lib/governance'
import { kindRequiresColumn } from '@/lib/quality'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  kind: z.enum(['not_null', 'unique', 'range', 'allowed_values', 'regex', 'freshness', 'row_count_min']).optional(),
  column: z.string().trim().min(1).nullish(),
  config: z.record(z.string(), z.unknown()).optional(),
  severity: z.enum(['warn', 'error']).optional(),
  enabled: z.boolean().optional(),
})

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; ruleId: string }> },
) {
  try {
    const denied = requireRole(req, 'editor')
    if (denied) return denied

    const { id, ruleId } = await params
    const rule = await db.qualityRule.findFirst({ where: { id: ruleId, datasetId: id } })
    if (!rule) return jsonError(404, 'Quality rule not found')

    let body: unknown
    try {
      body = await req.json()
    } catch {
      return badRequest('Request body must be valid JSON')
    }
    const parsed = patchSchema.safeParse(body)
    if (!parsed.success) return badRequest(zodErrorMessage(parsed))
    const data = parsed.data

    const kind = data.kind ?? rule.kind
    const column = data.column !== undefined ? data.column : rule.column
    if (kindRequiresColumn(kind) && !column) {
      return badRequest(`kind '${kind}' requires a column`)
    }

    const updated = await db.qualityRule.update({
      where: { id: rule.id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.kind !== undefined ? { kind: data.kind } : {}),
        ...(data.column !== undefined ? { column: data.column ?? null } : {}),
        ...(data.config !== undefined ? { configJson: JSON.stringify(data.config) } : {}),
        ...(data.severity !== undefined ? { severity: data.severity } : {}),
        ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
      },
    })

    audit({
      req,
      action: 'dataset.quality.rule_update',
      resourceType: 'dataset',
      resourceId: id,
      resourceName: rule.name,
      detail: `enabled=${updated.enabled} severity=${updated.severity}`,
    })

    return jsonOk({ ok: true, id: updated.id })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to update quality rule')
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; ruleId: string }> },
) {
  try {
    const denied = requireRole(req, 'editor')
    if (denied) return denied

    const { id, ruleId } = await params
    const rule = await db.qualityRule.findFirst({ where: { id: ruleId, datasetId: id } })
    if (!rule) return jsonError(404, 'Quality rule not found')

    await db.qualityRule.delete({ where: { id: rule.id } })

    audit({
      req,
      action: 'dataset.quality.rule_delete',
      resourceType: 'dataset',
      resourceId: id,
      resourceName: rule.name,
      detail: `kind=${rule.kind}`,
    })

    return jsonOk({ ok: true, deleted: rule.id, name: rule.name })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to delete quality rule')
  }
}
