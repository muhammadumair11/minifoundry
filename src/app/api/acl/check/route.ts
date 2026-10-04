// GET /api/acl/check?resourceType=&resourceId= — the caller's EFFECTIVE
// per-resource level (global role baseline elevated by a ResourceAcl row,
// admin bypasses to owner). Any role.

import type { NextRequest } from 'next/server'
import { jsonOk, serverError } from '@/lib/api-utils'
import { effectiveResourceLevel } from '@/lib/acl'
import { getActor } from '@/lib/governance'
import type { AclCheckResponse } from '@/lib/foundry-types'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
    const actor = getActor(req)
    const url = new URL(req.url)
    const resourceType = url.searchParams.get('resourceType') ?? ''
    const resourceId = url.searchParams.get('resourceId') ?? ''
    if (!resourceType || !resourceId) {
      // No resource context -> the bare global baseline is the honest answer.
      const level = actor.role === 'admin' ? 'owner' : actor.role === 'editor' ? 'editor' : 'viewer'
      return jsonOk<AclCheckResponse>({ level })
    }
    const level = await effectiveResourceLevel(actor.role, actor.email, resourceType as 'dataset' | 'pipeline' | 'dashboard', resourceId)
    return jsonOk<AclCheckResponse>({ level })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to check ACL level')
  }
}
