// PATCH /api/users/[id] — update a user's role / isActive (M9, ADMIN ONLY).
// 404 unknown id; 400 when a session-admin tries to change their OWN account
// (self-demotion / self-deactivation); simulator-admin (no session, demo mode)
// may change anyone. Audits user.update with the session actorEmail.

import { z } from 'zod'
import { db } from '@/lib/db'
import { badRequest, jsonOk, notFound, serverError, zodErrorMessage } from '@/lib/api-utils'
import { audit, requireRole } from '@/lib/governance'
import { getSession, serializeAdminUser } from '@/lib/auth-service'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

const patchSchema = z.object({
  role: z.enum(['viewer', 'editor', 'admin']).optional(),
  isActive: z.boolean().optional(),
})

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const denied = requireRole(req, 'admin')
    if (denied) return denied

    const { id } = await params
    const user = await db.user.findUnique({ where: { id } })
    if (!user) return notFound(`User '${id}' not found`)

    let body: unknown
    try {
      body = await req.json()
    } catch {
      return badRequest('Request body must be valid JSON')
    }
    const parsed = patchSchema.safeParse(body)
    if (!parsed.success) return badRequest(zodErrorMessage(parsed))

    const { role, isActive } = parsed.data

    // Guard: a logged-in admin cannot demote/deactivate their own account
    // (which would lock them out). Simulator admin (no session) is allowed.
    const session = getSession(req)
    if (session && session.uid === id) {
      const roleChange = role !== undefined && role !== user.role
      const selfDeactivate = isActive === false
      if (roleChange || selfDeactivate) {
        return badRequest('cannot change your own account')
      }
    }

    const updated = await db.user.update({
      where: { id },
      data: {
        ...(role !== undefined ? { role } : {}),
        ...(isActive !== undefined ? { isActive } : {}),
      },
    })

    audit({
      req,
      action: 'user.update',
      resourceType: 'user',
      resourceId: updated.id,
      resourceName: updated.email,
      detail: `role=${updated.role} isActive=${updated.isActive}`,
    })

    return jsonOk({ user: serializeAdminUser(updated) })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to update user')
  }
}
