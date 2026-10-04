// POST /api/settings/reset — wipe ALL workspace data back to the default empty
// state (admin ONLY). Users are kept so login keeps working; a single
// 'workspace.reset' AuditEntry (written inside the same transaction) documents
// the wipe with per-model counts. See src/lib/settings-service.ts.

import { jsonOk, serverError } from '@/lib/api-utils'
import { getActor, requireRole } from '@/lib/governance'
import { resetWorkspace } from '@/lib/settings-service'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const denied = requireRole(req, 'admin')
    if (denied) return denied

    // Actor derived exactly like the other routes' audit(): a valid session
    // cookie wins (including admin impersonation — the token is re-issued on
    // switch, so session.role IS the effective role), else the `foundry-role`
    // simulator cookie, else admin with no email (machine caller).
    const actor = getActor(req)
    const result = await resetWorkspace({ role: actor.role, email: actor.email })
    return jsonOk(result)
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to reset workspace')
  }
}
