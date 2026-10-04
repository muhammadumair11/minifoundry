// DELETE /api/datasets/[id]/branches/[branchId] — delete an UNMERGED branch
// pointer (editor+). Version rows stay — they are dataset history.

import { db } from '@/lib/db'
import { jsonError, jsonOk, serverError } from '@/lib/api-utils'
import { audit, requireRole } from '@/lib/governance'
import { BranchError, deleteBranch } from '@/lib/branching'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; branchId: string }> },
) {
  try {
    const denied = requireRole(req, 'editor')
    if (denied) return denied

    const { id, branchId } = await params
    const dataset = await db.dataset.findUnique({ where: { id }, select: { id: true, name: true } })
    if (!dataset) return jsonError(404, `Dataset '${id}' not found`)

    try {
      const branch = await deleteBranch(id, branchId)
      audit({
        req,
        action: 'dataset.branch.delete',
        resourceType: 'dataset',
        resourceId: id,
        resourceName: dataset.name,
        detail: `branch='${branch.name}' (head was v${branch.headVersion})`,
      })
      return jsonOk({ ok: true, deleted: branch.id, name: branch.name })
    } catch (err) {
      if (err instanceof BranchError) return jsonError(err.status, err.message)
      throw err
    }
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to delete branch')
  }
}
