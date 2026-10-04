// POST /api/datasets/[id]/branches/[branchId]/merge — R14 branch → main merge.
// Copies the branch head's data as a NEW main version (next global number).
// 409 when already merged without new commits; editor+ required.

import { db } from '@/lib/db'
import { jsonError, jsonOk, serverError } from '@/lib/api-utils'
import { audit, requireRole } from '@/lib/governance'
import { BranchError, mergeBranch } from '@/lib/branching'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

export async function POST(
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
      const result = await mergeBranch(id, branchId)
      audit({
        req,
        action: 'dataset.branch.merge',
        resourceType: 'dataset',
        resourceId: id,
        resourceName: dataset.name,
        detail: `branch='${result.branchName}' → v${result.mergedVersion} (${result.rowsMerged} rows)`,
      })
      return jsonOk(result)
    } catch (err) {
      if (err instanceof BranchError) return jsonError(err.status, err.message)
      throw err
    }
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to merge branch')
  }
}
