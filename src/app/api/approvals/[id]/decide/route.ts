// POST /api/approvals/[id]/decide — decide a pending approval (admin only).
// Dataset publication is pinned to the draft captured when approval was requested.
import { z } from 'zod'
import type { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { badRequest, jsonError, jsonOk, notFound, serverError, zodErrorMessage } from '@/lib/api-utils'
import { audit, getRole, requireRole } from '@/lib/governance'
import { createNotification } from '@/lib/notify'
import { PublicationError, publishDatasetVersion } from '@/lib/publication'
import { evaluateRules } from '@/lib/quality'

export const dynamic = 'force-dynamic'

const decideSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  note: z.string().optional(),
})

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const denied = requireRole(req, 'admin')
    if (denied) return denied
    const role = getRole(req)
    const { id } = await params
    const approval = await db.approvalRequest.findUnique({ where: { id } })
    if (!approval) return notFound(`Approval request '${id}' not found`)
    if (approval.status !== 'pending') return badRequest(`Approval request is already ${approval.status}`)

    const parsed = decideSchema.safeParse(await req.json().catch(() => null))
    if (!parsed.success) return badRequest(zodErrorMessage(parsed))
    const { decision, note } = parsed.data

    let updated
    if (decision === 'approved' && approval.kind === 'publish_dataset') {
      if (approval.versionNumber == null) {
        return badRequest('This legacy request has no pinned draft; create a new publication request')
      }
      try {
        // Recheck the exact draft against the current rules immediately before
        // publication. Failed evaluation leaves the approval pending.
        await evaluateRules(approval.targetId, approval.versionNumber, 'manual')
        const outcome = await publishDatasetVersion(
          approval.targetId, approval.versionNumber, approval.id, role, note,
        )
        audit({
          req, action: 'dataset.publish', resourceType: 'dataset',
          resourceId: outcome.datasetId, resourceName: outcome.datasetName,
          detail: `v${outcome.versionNumber} published via approval ${approval.id}`,
        })
        await createNotification({
          type: 'system', title: `Published: ${outcome.datasetName} v${outcome.versionNumber}`,
          body: `Quality state: ${outcome.qualityState}. Consumers now read v${outcome.publishedVersion}.`,
          resourceType: 'dataset', resourceId: outcome.datasetId,
          href: `/datasets/${outcome.datasetId}`,
        })
      } catch (err) {
        if (err instanceof PublicationError) return jsonError(err.status, err.message, { reasons: err.reasons })
        throw err
      }
      updated = await db.approvalRequest.findUniqueOrThrow({ where: { id } })
    } else {
      updated = await db.approvalRequest.update({
        where: { id },
        data: { status: decision, decidedBy: role, decidedAt: new Date(), decisionNote: note ?? null },
      })
    }

    audit({
      req, action: 'approval.decide', resourceType: 'approval', resourceId: id,
      resourceName: `${approval.kind}: ${approval.targetName}`,
      detail: `${decision} by ${role}${note ? ` — ${note}` : ''}`,
    })
    await createNotification({
      type: 'system',
      title: decision === 'approved' ? `Approved: ${approval.targetName}` : `Rejected: ${approval.targetName}`,
      body: `${approval.kind}${note ? ` — ${note}` : ''}`,
      resourceType: 'approval', resourceId: id, href: '/governance',
    })
    return jsonOk({ approval: updated })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to decide approval')
  }
}
