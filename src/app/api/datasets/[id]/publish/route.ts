// Publication is committed only by the approval decision route. Keep this
// endpoint so older clients receive an explicit migration error.
import type { NextRequest } from 'next/server'
import { jsonError } from '@/lib/api-utils'
import { requireRole } from '@/lib/governance'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const denied = requireRole(req, 'editor')
  if (denied) return denied
  return jsonError(409, 'Request publication through /api/approvals; an admin must approve the exact draft version')
}
