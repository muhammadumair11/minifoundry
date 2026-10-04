// DELETE /api/objects/views/[viewId] — remove a saved object view (editor+).

import { db } from '@/lib/db'
import { notFound, serverError } from '@/lib/api-utils'
import { audit, requireRole } from '@/lib/governance'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ viewId: string }> }) {
  try {
    const denied = requireRole(req, 'editor')
    if (denied) return denied

    const { viewId } = await params
    const existing = await db.objectView.findUnique({
      where: { id: viewId },
      select: { id: true, name: true, objectType: { select: { apiName: true, displayName: true } } },
    })
    if (!existing) return notFound(`Object view '${viewId}' not found`)

    await db.objectView.delete({ where: { id: existing.id } })

    audit({
      req,
      action: 'ontology.view_delete',
      resourceType: 'ontology',
      resourceId: existing.id,
      resourceName: existing.name,
      detail: `deleted view '${existing.name}' on ${existing.objectType.apiName}`,
    })

    return new Response(null, { status: 204 })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to delete object view')
  }
}
