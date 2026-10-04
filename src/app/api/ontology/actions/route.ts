// GET  /api/ontology/actions — all action types with parsed parameters, write-
//                              back config (R14.6) and object type meta.
// POST /api/ontology/actions — create an action type (editor+). Accepts an
//                              optional write-back config { targetDatasetId,
//                              writeMode: append|upsert, keyProperty }.
// Static segment NEXT TO [id] on /api/ontology — App Router resolves static
// routes first (same pattern as schedules/due).

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

/** Target dataset names for the serializers (one small query when needed). */
async function targetDatasetNames(ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const unique = [...new Set(ids.filter(Boolean))]
  if (unique.length === 0) return map
  const datasets = await db.dataset.findMany({
    where: { id: { in: unique } },
    select: { id: true, name: true },
  })
  for (const d of datasets) map.set(d.id, d.name)
  return map
}

// GET — list all action types (full config).
export async function GET() {
  try {
    const actions = await db.actionType.findMany({
      orderBy: [{ createdAt: 'asc' }, { apiName: 'asc' }],
      include: ACTION_INCLUDE,
    })
    const names = await targetDatasetNames(actions.map((a) => a.targetDatasetId).filter((v): v is string => !!v))
    return jsonOk({
      actions: actions.map((a) =>
        serializeActionFull(a, a.targetDatasetId ? names.get(a.targetDatasetId) ?? null : null),
      ),
    })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load actions')
  }
}

// ─── POST — create ───────────────────────────────────────────────────

const SLUG_RE = /^[a-z][a-z0-9_-]{1,63}$/

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

const createSchema = z.object({
  displayName: z.string().min(1).max(120),
  apiName: z
    .string()
    .regex(SLUG_RE, 'apiName must be a lowercase slug (letters, numbers, "-" or "_"), starting with a letter')
    .optional(),
  description: z.string().max(500).nullish(),
  objectTypeId: z.string().min(1),
  operation: z.enum(['create', 'update', 'delete']),
  enabled: z.boolean().optional(),
  parameters: z.array(paramSchema).max(20).default([]),
  // null = plain object action; object = write-back action (R14.6)
  writeback: writebackSchema.nullish(),
})

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

export async function POST(req: NextRequest) {
  try {
    const denied = requireRole(req, 'editor')
    if (denied) return denied

    let body: unknown
    try {
      body = await req.json()
    } catch {
      return badRequest('Request body must be valid JSON')
    }
    const parsed = createSchema.safeParse(body)
    if (!parsed.success) return badRequest(zodErrorMessage(parsed))
    const input = parsed.data

    const apiName = input.apiName ?? slugify(input.displayName)
    if (!SLUG_RE.test(apiName)) {
      return badRequest(
        `Could not derive a valid apiName from displayName '${input.displayName}' — provide apiName explicitly`,
      )
    }
    const taken = await db.actionType.findUnique({ where: { apiName }, select: { id: true } })
    if (taken) return badRequest(`apiName '${apiName}' is already in use`)

    const objectType = await db.objectType.findUnique({
      where: { id: input.objectTypeId },
      select: { id: true, apiName: true, displayName: true },
    })
    if (!objectType) return notFound(`Object type '${input.objectTypeId}' not found`)

    const pks = input.parameters.filter((p) => p.isPk)
    if (pks.length > 1) return badRequest('At most one parameter can be marked isPk')
    if (!input.writeback && (input.operation === 'update' || input.operation === 'delete') && pks.length === 0) {
      return badRequest(
        `${input.operation} actions need one parameter marked isPk (maps to the object key column)`,
      )
    }

    // Write-back validation: target must exist and (for upsert) the key column
    // must exist in the target's current schema; every mapsTo must be a column.
    let targetDatasetId: string | null = null
    let writeMode: string | null = null
    let keyProperty: string | null = null
    if (input.writeback) {
      const dataset = await db.dataset.findUnique({
        where: { id: input.writeback.targetDatasetId },
        include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1, select: { schemaJson: true } } },
      })
      if (!dataset) return notFound(`Target dataset '${input.writeback.targetDatasetId}' not found`)
      if (dataset.versions.length === 0) {
        return badRequest(`Target dataset '${dataset.name}' has no versions yet`)
      }
      const schema = JSON.parse(dataset.versions[0].schemaJson) as Array<{ name: string }>
      const columns = new Set(schema.map((c) => c.name))
      writeMode = input.writeback.writeMode
      targetDatasetId = dataset.id
      if (writeMode === 'upsert') {
        keyProperty = input.writeback.keyProperty?.trim() || null
        if (!keyProperty) return badRequest('upsert write-back needs a keyProperty (column of the target dataset)')
        if (!columns.has(keyProperty)) {
          return badRequest(
            `keyProperty '${keyProperty}' is not a column of '${dataset.name}' (columns: ${[...columns].join(', ') || 'none'})`,
          )
        }
      }
      for (const p of input.parameters) {
        if (!columns.has(p.mapsTo)) {
          return badRequest(
            `parameter '${p.apiName}' maps to column '${p.mapsTo}' which is not in dataset '${dataset.name}' (columns: ${[...columns].join(', ') || 'none'})`,
          )
        }
      }
    }

    const action = await db.actionType.create({
      data: {
        apiName,
        displayName: input.displayName,
        description: input.description ?? null,
        objectTypeId: objectType.id,
        operation: input.operation,
        enabled: input.enabled ?? true,
        parametersJson: JSON.stringify(input.parameters),
        targetDatasetId,
        writeMode,
        keyProperty,
      },
      include: ACTION_INCLUDE,
    })

    audit({
      req,
      action: 'ontology.action_create',
      resourceType: 'ontology',
      resourceId: action.id,
      resourceName: action.displayName,
      detail: targetDatasetId
        ? `${action.apiName} (${input.operation}) with write-back to a target dataset (${writeMode}${keyProperty ? `, key ${keyProperty}` : ''})`
        : `${action.apiName} (${input.operation}) on ${objectType.displayName}`,
    })

    const names = await targetDatasetNames(targetDatasetId ? [targetDatasetId] : [])
    return jsonOk(
      { action: serializeActionFull(action, targetDatasetId ? names.get(targetDatasetId) ?? null : null) },
      201,
    )
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to create action')
  }
}
