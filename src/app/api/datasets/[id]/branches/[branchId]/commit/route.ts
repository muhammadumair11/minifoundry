// Append an isolated dataset version to a branch. Nothing reaches main until merge.
import { z } from 'zod'
import type { NextRequest } from 'next/server'
import { badRequest, jsonError, jsonOk, serverError, zodErrorMessage } from '@/lib/api-utils'
import { audit, getActor, requireRole } from '@/lib/governance'
import { BranchError, commitBranchVersion } from '@/lib/branching'

export const dynamic = 'force-dynamic'

const schema = z.object({
  expectedHeadVersion: z.number().int().positive(),
  rows: z.array(z.record(z.string(), z.unknown())),
})

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; branchId: string }> },
) {
  try {
    const denied = requireRole(req, 'editor')
    if (denied) return denied
    const { id, branchId } = await params
    const parsed = schema.safeParse(await req.json().catch(() => null))
    if (!parsed.success) return badRequest(zodErrorMessage(parsed))
    const actor = getActor(req)
    try {
      const result = await commitBranchVersion(
        id, branchId, parsed.data.rows, parsed.data.expectedHeadVersion,
        actor.email ?? actor.role,
      )
      audit({
        req, action: 'dataset.branch.commit', resourceType: 'dataset', resourceId: id,
        detail: `branch='${result.branchName}' v${result.versionNumber} (${result.rowCount} rows)`,
      })
      return jsonOk(result, 201)
    } catch (err) {
      if (err instanceof BranchError) return jsonError(err.status, err.message)
      throw err
    }
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to commit branch')
  }
}
