// DELETE /api/markings/[id] — remove a marking (admin); ColumnMarking rows
// cascade via the schema.

import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { notFound, serverError } from '@/lib/api-utils'
import { audit, requireRole } from '@/lib/governance'

export const dynamic = 'force-dynamic'

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const denied = requireRole(req, 'admin')
    if (denied) return denied

    const { id } = await params
    const existing = await db.marking.findUnique({ where: { id }, select: { id: true, name: true } })
    if (!existing) return notFound(`Marking '${id}' not found`)

    await db.marking.delete({ where: { id } })

    audit({
      req,
      action: 'marking.delete',
      resourceType: 'marking',
      resourceId: existing.id,
      resourceName: existing.name,
    })

    return new NextResponse(null, { status: 204 })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to delete marking')
  }
}
