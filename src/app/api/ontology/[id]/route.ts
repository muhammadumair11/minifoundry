// GET    /api/ontology/[id] — single object type (properties, links, actions).
// DELETE /api/ontology/[id] — remove an object type (204; cascades properties,
//                              links, actions and their logs).
// `[id]` accepts the object type id OR its apiName.

import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { jsonOk, notFound, serverError } from '@/lib/api-utils'
import { OBJECT_TYPE_INCLUDE, serializeObjectType } from '@/lib/ontology-service'
import { audit, requireRole } from '@/lib/governance'

export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const objectType =
      (await db.objectType.findUnique({ where: { id }, include: OBJECT_TYPE_INCLUDE })) ??
      (await db.objectType.findUnique({ where: { apiName: id }, include: OBJECT_TYPE_INCLUDE }))
    if (!objectType) return notFound(`Object type '${id}' not found`)
    return jsonOk({ objectType: serializeObjectType(objectType) })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load object type')
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const denied = requireRole(req, 'editor')
    if (denied) return denied

    const { id } = await params
    const existing =
      (await db.objectType.findUnique({ where: { id }, select: { id: true, apiName: true, displayName: true } })) ??
      (await db.objectType.findUnique({ where: { apiName: id }, select: { id: true, apiName: true, displayName: true } }))
    if (!existing) return notFound(`Object type '${id}' not found`)

    await db.objectType.delete({ where: { id: existing.id } })

    audit({
      req,
      action: 'ontology.delete',
      resourceType: 'ontology',
      resourceId: existing.id,
      resourceName: existing.displayName,
      detail: `apiName '${existing.apiName}'`,
    })

    return new NextResponse(null, { status: 204 })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to delete object type')
  }
}
