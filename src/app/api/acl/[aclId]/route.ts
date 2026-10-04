// DELETE /api/acl/[aclId] — revoke one per-resource grant (ADMIN only).

import type { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { jsonOk, notFound, serverError } from '@/lib/api-utils'
import { audit, requireRole } from '@/lib/governance'

export const dynamic = 'force-dynamic'

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ aclId: string }> }) {
  try {
    const denied = requireRole(req, 'admin')
    if (denied) return denied

    const { aclId } = await params
    const acl = await db.resourceAcl.findUnique({ where: { id: aclId } })
    if (!acl) return notFound(`ACL grant '${aclId}' not found`)

    await db.resourceAcl.delete({ where: { id: aclId } })

    audit({
      req,
      action: 'acl.revoke',
      resourceType: acl.resourceType,
      resourceId: acl.resourceId,
      resourceName: acl.userEmail,
      detail: `removed level=${acl.level}`,
    })

    return jsonOk({ ok: true, id: aclId })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to revoke ACL grant')
  }
}
