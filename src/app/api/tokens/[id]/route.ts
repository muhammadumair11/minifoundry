// DELETE /api/tokens/[id] — soft-revoke an API token (ADMIN ONLY).
// Sets revokedAt (idempotent when already revoked); revoked tokens fail
// authentication with 401 immediately. The rate-limit window is dropped too.

import { db } from '@/lib/db'
import { jsonOk, notFound, serverError } from '@/lib/api-utils'
import { audit, requireRole } from '@/lib/governance'
import { forgetTokenRateLimit } from '@/lib/api-v1'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const denied = requireRole(req, 'admin')
    if (denied) return denied

    const { id } = await params
    const token = await db.apiToken.findUnique({ where: { id } })
    if (!token) return notFound(`API token '${id}' not found`)

    if (!token.revokedAt) {
      await db.apiToken.update({ where: { id }, data: { revokedAt: new Date() } })
      forgetTokenRateLimit(id)
      audit({
        req,
        action: 'apiToken.revoke',
        resourceType: 'apiToken',
        resourceId: token.id,
        resourceName: token.name,
        detail: `name=${token.name} prefix=${token.prefix}`,
      })
    }

    return jsonOk({ ok: true })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to revoke API token')
  }
}
