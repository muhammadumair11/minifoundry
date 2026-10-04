// GET  /api/objects/views?type={objectTypeId|apiName} — saved object views for
//       a type (any role can READ views; viewers can APPLY them).
// POST /api/objects/views — save a view (editor+). Body:
//       { type, name, filters: [{property, op, value}], sortBy?, sortDir? }.
//       409 when a view with the same name exists for the type (unique per
//       type). Static segment NEXT TO [type] on /api/objects — App Router
//       resolves static routes first.

import { z } from 'zod'
import { db } from '@/lib/db'
import { badRequest, jsonError, jsonOk, notFound, serverError, zodErrorMessage } from '@/lib/api-utils'
import {
  findObjectType,
  MAX_VIEW_FILTERS,
  VIEW_FILTER_OPS,
} from '@/lib/ontology-service'
import { audit, getActor, requireRole } from '@/lib/governance'
import type { ObjectViewInfo } from '@/lib/foundry-types'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

/** Prisma ObjectView -> contract ObjectViewInfo. */
function serializeView(v: {
  id: string
  objectTypeId: string
  name: string
  filtersJson: string
  sortBy: string | null
  sortDir: string
  createdBy: string | null
  createdAt: Date
}): ObjectViewInfo {
  return {
    id: v.id,
    objectTypeId: v.objectTypeId,
    name: v.name,
    filters: JSON.parse(v.filtersJson) as ObjectViewInfo['filters'],
    sortBy: v.sortBy,
    sortDir: v.sortDir === 'desc' ? 'desc' : 'asc',
    createdBy: v.createdBy,
    createdAt: v.createdAt.toISOString(),
  }
}

// GET — list saved views for one object type (newest last, creation order).
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const typeParam = url.searchParams.get('type')?.trim()
    if (!typeParam) return badRequest("Missing required query parameter 'type'")

    const objectType = await findObjectType(typeParam)
    if (!objectType) return notFound(`Object type '${typeParam}' not found`)

    const views = await db.objectView.findMany({
      where: { objectTypeId: objectType.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })

    return jsonOk({ views: views.map(serializeView) })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load object views')
  }
}

// ─── POST — save a view (editor+) ────────────────────────────────────

const filterSchema = z.object({
  property: z.string().min(1).max(120),
  op: z.enum(VIEW_FILTER_OPS),
  value: z.string().max(500),
})

const createSchema = z.object({
  type: z.string().min(1, 'type (object type id or apiName) is required'),
  name: z.string().trim().min(1, 'name is required').max(80),
  filters: z.array(filterSchema).max(MAX_VIEW_FILTERS).default([]),
  sortBy: z.string().max(120).nullish(),
  sortDir: z.enum(['asc', 'desc']).optional(),
})

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

    const objectType = await findObjectType(input.type)
    if (!objectType) return notFound(`Object type '${input.type}' not found`)

    const dup = await db.objectView.findUnique({
      where: { objectTypeId_name: { objectTypeId: objectType.id, name: input.name } },
      select: { id: true },
    })
    if (dup) {
      return jsonError(
        409,
        `A view named '${input.name}' already exists for ${objectType.displayName}`,
      )
    }

    const actor = getActor(req)
    const view = await db.objectView.create({
      data: {
        objectTypeId: objectType.id,
        name: input.name,
        filtersJson: JSON.stringify(input.filters),
        sortBy: input.sortBy?.trim() || null,
        sortDir: input.sortDir === 'desc' ? 'desc' : 'asc',
        createdBy: actor.email ?? 'simulator',
      },
    })

    audit({
      req,
      action: 'ontology.view_save',
      resourceType: 'ontology',
      resourceId: view.id,
      resourceName: view.name,
      detail: `saved view '${view.name}' on ${objectType.apiName} (${input.filters.length} filter${input.filters.length === 1 ? '' : 's'}${view.sortBy ? `, sort ${view.sortBy} ${view.sortDir}` : ''})`,
    })

    return jsonOk({ view: serializeView(view) }, 201)
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to save object view')
  }
}
