// PATCH  /api/ontology/actions/[id] — update an action type (editor+). Fields:
//          displayName, description, operation, enabled, parameters (full
//          replacement) and writeback (R14.6 — null clears the write-back).
// DELETE /api/ontology/actions/[id] — remove the action type (204; its logs
//          cascade). `[id]` accepts the action id OR its apiName.

import { z } from 'zod'
import { db } from '@/lib/db'
import { badRequest, jsonOk, notFound, serverError, zodErrorMessage } from '@/lib/api-utils'
import { serializeActionFull } from '@/lib/ontology-service'
import { audit, requireRole } from '@/lib/governance'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

const ACTION_INCLUDE = {
  objectType: {
    select: {
      id: true,
      apiName: true,
      displayName: true,
      primaryKey: true,
      icon: true,
      color: true,
      sourceDatasetId: true,
    },
  },
} as const

const paramSchema = z.object({
  apiName: z
    .string()
    .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/, 'parameter apiName must match [a-zA-Z][a-zA-Z0-9_]*'),
  displayName: z.string().min(1).max(120).optional(),
  dataType: z.enum(['string', 'number', 'boolean']),
  required: z.boolean().optional(),
  mapsTo: z.string().min(1, 'mapsTo (dataset column) is required').max(120),
  isPk: z.boolean().optional(),
  defaultValue: z.unknown().optional(),
  oneOf: z.array(z.string()).max(50).optional(),
})

const writebackSchema = z.object({
  targetDatasetId: z.string().min(1),
  writeMode: z.enum(['append', 'upsert']),
  keyProperty: z.string().min(1).nullish(),
})

const patchSchema = z.object({
  displayName: z.string().min(1).max(120).optional(),
  description: z.string().max(500).nullish(),
  operation: z.enum(['create', 'update', 'delete']).optional(),
  enabled: z.boolean().optional(),
  parameters: z.array(paramSchema).max(20).optional(),
  // null clears the write-back (action reverts to a plain object action)
  writeback: writebackSchema.nullish(),
})

/** Shape of the write-back columns written on PATCH. */
interface WritebackPatch {
  targetDatasetId: string | null
  writeMode: string | null
  keyProperty: string | null
}

/**
 * Normalize parameter definitions before persisting: an EMPTY oneOf list is
 * dropped (undefined) so run dialogs never render a dropdown with zero
 * options, and blank entries are filtered out.
 */
function normalizeParameters<T extends { oneOf?: string[] }>(parameters: T[]): T[] {
  return parameters.map((p) => {
    const oneOf = (p.oneOf ?? []).map((o) => String(o)).filter((o) => o.trim() !== '')
    return oneOf.length > 0 ? { ...p, oneOf } : { ...p, oneOf: undefined }
  })
}

/** Resolve the target dataset + validate write-back config (null = clear). */
async function resolveWriteback(
  writeback: z.infer<typeof writebackSchema> | null,
): Promise<WritebackPatch | { error: string }> {
  if (writeback === null) return { targetDatasetId: null, writeMode: null, keyProperty: null }

  const dataset = await db.dataset.findUnique({
    where: { id: writeback.targetDatasetId },
    include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1, select: { schemaJson: true } } },
  })
  if (!dataset) return { error: `Target dataset '${writeback.targetDatasetId}' not found` }
  if (dataset.versions.length === 0) return { error: `Target dataset '${dataset.name}' has no versions yet` }

  const schema = JSON.parse(dataset.versions[0].schemaJson) as Array<{ name: string }>
  const columns = new Set(schema.map((c) => c.name))

  const writeMode = writeback.writeMode
  let keyProperty: string | null = null
  if (writeMode === 'upsert') {
    keyProperty = writeback.keyProperty?.trim() || null
    if (!keyProperty) return { error: 'upsert write-back needs a keyProperty (column of the target dataset)' }
    if (!columns.has(keyProperty)) {
      return {
        error: `keyProperty '${keyProperty}' is not a column of '${dataset.name}' (columns: ${[...columns].join(', ') || 'none'})`,
      }
    }
  }
  return { targetDatasetId: dataset.id, writeMode, keyProperty }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const denied = requireRole(req, 'editor')
    if (denied) return denied

    const { id } = await params
    const existing =
      (await db.actionType.findUnique({ where: { id }, include: ACTION_INCLUDE })) ??
      (await db.actionType.findUnique({ where: { apiName: id }, include: ACTION_INCLUDE }))
    if (!existing) return notFound(`Action '${id}' not found`)

    let body: unknown
    try {
      body = await req.json()
    } catch {
      return badRequest('Request body must be valid JSON')
    }
    const parsed = patchSchema.safeParse(body)
    if (!parsed.success) return badRequest(zodErrorMessage(parsed))
    const input = parsed.data

    // ── write-back resolution (also validates parameters against columns) ──
    let wb: WritebackPatch | null = null
    if (input.writeback !== undefined) {
      const resolved = await resolveWriteback(input.writeback ?? null)
      if ('error' in resolved) return badRequest(resolved.error)
      wb = resolved
    }

    const operation = input.operation ?? existing.operation
    const parameters = input.parameters ?? (JSON.parse(existing.parametersJson) as z.infer<typeof paramSchema>[])
    const pks = parameters.filter((p) => p.isPk)
    if (pks.length > 1) return badRequest('At most one parameter can be marked isPk')
    const hasWriteback = wb ? !!wb.targetDatasetId : !!existing.targetDatasetId
    if (!hasWriteback && (operation === 'update' || operation === 'delete') && pks.length === 0) {
      return badRequest(`${operation} actions need one parameter marked isPk (maps to the object key column)`)
    }
    // When the parameters themselves changed, every mapsTo must be a column of
    // the write-back target (if configured).
    if (input.parameters && hasWriteback) {
      const targetId = (wb ? wb.targetDatasetId : existing.targetDatasetId) as string | null
      if (targetId) {
        const dataset = await db.dataset.findUnique({
          where: { id: targetId },
          include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1, select: { schemaJson: true } } },
        })
        if (dataset) {
          const schema = JSON.parse(dataset.versions[0]?.schemaJson ?? '[]') as Array<{ name: string }>
          const columns = new Set(schema.map((c) => c.name))
          for (const p of input.parameters) {
            if (!columns.has(p.mapsTo)) {
              return badRequest(
                `parameter '${p.apiName}' maps to column '${p.mapsTo}' which is not in dataset '${dataset.name}' (columns: ${[...columns].join(', ') || 'none'})`,
              )
            }
          }
        }
      }
    }

    const action = await db.actionType.update({
      where: { id: existing.id },
      data: {
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.operation !== undefined ? { operation: input.operation } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.parameters !== undefined
          ? { parametersJson: JSON.stringify(normalizeParameters(input.parameters)) }
          : {}),
        ...(wb
          ? {
              targetDatasetId: wb.targetDatasetId,
              writeMode: wb.writeMode,
              keyProperty: wb.keyProperty,
            }
          : {}),
      },
      include: ACTION_INCLUDE,
    })

    let targetName: string | null = null
    if (action.targetDatasetId) {
      const ds = await db.dataset.findUnique({
        where: { id: action.targetDatasetId },
        select: { name: true },
      })
      targetName = ds?.name ?? null
    }

    audit({
      req,
      action: 'ontology.action_update',
      resourceType: 'ontology',
      resourceId: action.id,
      resourceName: action.displayName,
      detail: `${action.apiName} updated (operation ${action.operation}${action.targetDatasetId ? `, write-back ${action.writeMode}` : ', no write-back'})`,
    })

    return jsonOk({ action: serializeActionFull(action, targetName) })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to update action')
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const denied = requireRole(req, 'editor')
    if (denied) return denied

    const { id } = await params
    const existing =
      (await db.actionType.findUnique({ where: { id }, select: { id: true, apiName: true, displayName: true } })) ??
      (await db.actionType.findUnique({ where: { apiName: id }, select: { id: true, apiName: true, displayName: true } }))
    if (!existing) return notFound(`Action '${id}' not found`)

    await db.actionType.delete({ where: { id: existing.id } })

    audit({
      req,
      action: 'ontology.action_delete',
      resourceType: 'ontology',
      resourceId: existing.id,
      resourceName: existing.displayName,
      detail: `apiName '${existing.apiName}' (its action logs cascaded)`,
    })

    return new Response(null, { status: 204 })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to delete action')
  }
}
