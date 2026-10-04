// POST /api/approvals/[id]/decide — approve or reject a pending approval (admin).
// approve + publish_dataset additionally merges the "production" tag into the
// dataset's tags JSON (read-modify-write) and audits the tag change.

import { z } from 'zod'
import type { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { badRequest, jsonOk, notFound, parseJsonSafe, serverError, zodErrorMessage } from '@/lib/api-utils'
import { audit, getRole, requireRole } from '@/lib/governance'
import { createNotification } from '@/lib/notify' // R14: decision bell
import { PublicationError, latestDraftVersion, publishDatasetVersion } from '@/lib/publication' // P2

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
    if (approval.status !== 'pending') {
      return badRequest(`Approval request is already ${approval.status} (only pending requests can be decided)`)
    }

    let body: unknown
    try {
      body = await req.json()
    } catch {
      return badRequest('Request body must be valid JSON')
    }
    const parsed = decideSchema.safeParse(body)
    if (!parsed.success) return badRequest(zodErrorMessage(parsed))
    const { decision, note } = parsed.data

    const updated = await db.approvalRequest.update({
      where: { id },
      data: {
        status: decision,
        decidedBy: role,
        decidedAt: new Date(),
        decisionNote: note ?? null,
      },
    })

    // Approved dataset publication -> stamp the "production" tag AND (P2)
    // auto-publish the dataset's latest draft version when the gate allows it.
    if (decision === 'approved' && approval.kind === 'publish_dataset') {
      const dataset = await db.dataset.findUnique({
        where: { id: approval.targetId },
        select: { id: true, name: true, tags: true },
      })
      if (dataset) {
        const tags = parseJsonSafe<string[]>(dataset.tags, [])
        if (!tags.includes('production')) {
          tags.push('production')
          await db.dataset.update({ where: { id: dataset.id }, data: { tags: JSON.stringify(tags) } })
          audit({
            req,
            action: 'dataset.tag',
            resourceType: 'dataset',
            resourceId: dataset.id,
            resourceName: dataset.name,
            detail: `tag 'production' added via approval ${approval.id}`,
          })
        }
        // P2 trust workflow: approval of publish_dataset now completes the
        // preview → validate → approve → publish loop by publishing the
        // latest draft (when the quality gate permits).
        const draftVersion = await latestDraftVersion(dataset.id)
        if (draftVersion != null) {
          try {
            const outcome = await publishDatasetVersion(dataset.id, draftVersion)
            audit({
              req,
              action: 'dataset.publish',
              resourceType: 'dataset',
              resourceId: dataset.id,
              resourceName: dataset.name,
              detail: `v${outcome.versionNumber} published via approval ${approval.id} (quality state: ${outcome.qualityState})`,
            })
            await createNotification({
              type: 'system',
              title: `Published: ${dataset.name} v${outcome.versionNumber}`,
              body: `Publication approved — quality state '${outcome.qualityState}'. Consumers now read v${outcome.publishedVersion}.`,
              resourceType: 'dataset',
              resourceId: dataset.id,
              href: `/datasets/${dataset.id}`,
            })
          } catch (err) {
            // Gate blocked the publication (quality failed) — record why, the
            // approval itself stays approved (the ceremony succeeded).
            const reasons =
              err instanceof PublicationError
                ? err.reasons.join(' · ') || err.message
                : err instanceof Error
                  ? err.message
                  : 'unknown error'
            await db.approvalRequest.update({
              where: { id: approval.id },
              data: {
                decisionNote: [approval.decisionNote, `Publication NOT executed: ${reasons}`]
                  .filter(Boolean)
                  .join(' — '),
              },
            })
            await createNotification({
              type: 'quality_failed',
              title: `Publication blocked: ${dataset.name}`,
              body: `Approval ${approval.id} was approved but v${draftVersion} could not be published: ${reasons}`,
              resourceType: 'dataset',
              resourceId: dataset.id,
              href: `/datasets/${dataset.id}`,
            })
          }
        }
      }
    }

    audit({
      req,
      action: 'approval.decide',
      resourceType: 'approval',
      resourceId: approval.id,
      resourceName: `${approval.kind}: ${approval.targetName}`,
      detail: `${decision} by ${role}${note ? ` — ${note}` : ''}`,
    })

    // R14: bell notification for the decision (broadcast).
    await createNotification({
      type: 'system',
      title: decision === 'approved' ? `Approved: ${approval.targetName}` : `Rejected: ${approval.targetName}`,
      body: `${approval.kind}${note ? ` — ${note}` : ''}`,
      resourceType: 'approval',
      resourceId: approval.id,
      href: '/governance',
    })

    return jsonOk({ approval: updated })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to decide approval')
  }
}
