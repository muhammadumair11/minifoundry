// GET  /api/approvals?status= — approval requests, latest 100 first (read: any role).
// POST /api/approvals — request an approval (editor+): publish_dataset |
// publish_pipeline targeting an existing dataset/pipeline. Rejects a duplicate
// PENDING request for the same kind+targetId.

import { z } from 'zod'
import type { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { badRequest, jsonOk, notFound, serverError, zodErrorMessage } from '@/lib/api-utils'
import { audit, getRole, requireRole } from '@/lib/governance'
import { createNotification } from '@/lib/notify' // R14: approval_requested bell
import { failingErrorRules, latestDraftVersion } from '@/lib/publication' // P2 carryover: gate preview
import type { PublishGatePreview } from '@/lib/foundry-types'

export const dynamic = 'force-dynamic'

/**
 * P2 carryover: live publication-gate read-out for a pending publish_dataset
 * request. Answers "if I approve this RIGHT NOW, will the publish succeed?"
 * — blocked (with the failing rule names), ready, no draft, or ungated.
 * Never throws (preview errors degrade to null).
 */
async function gatePreview(targetId: string, versionNumber: number | null): Promise<PublishGatePreview | null> {
  try {
    const dataset = await db.dataset.findUnique({
      where: { id: targetId },
      select: { qualityGate: true },
    })
    if (!dataset) return null
    if (!dataset.qualityGate) {
      return { status: 'ungated', gateOn: false, draftVersion: null, qualityState: null, failing: [] }
    }
    const draft = versionNumber
    if (draft == null) {
      return { status: 'no_draft', gateOn: true, draftVersion: null, qualityState: null, failing: [] }
    }
    const version = await db.datasetVersion.findUnique({
      where: { datasetId_versionNumber: { datasetId: targetId, versionNumber: draft } },
      select: { qualityState: true },
    })
    const failing = await failingErrorRules(targetId, draft)
    return {
      status: version?.qualityState === 'passed' || version?.qualityState === 'warned' ? 'ready' : 'blocked',
      gateOn: true,
      draftVersion: draft,
      qualityState: version?.qualityState ?? 'not_evaluated',
      failing,
    }
  } catch {
    return null
  }
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const status = url.searchParams.get('status')
    const approvals = await db.approvalRequest.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
      take: 100,
    })

    // Enrich PENDING publish_dataset requests with the live gate preview
    // (additive; decided requests and publish_pipeline keep the shape).
    const pendingDatasets = new Map(
      approvals
        .filter((a) => a.status === 'pending' && a.kind === 'publish_dataset')
        .map((a) => [a.targetId, a.versionNumber] as const),
    )
    const previews = new Map<string, PublishGatePreview | null>()
    await Promise.all(
      [...pendingDatasets].map(async ([id, versionNumber]) => {
        previews.set(id, await gatePreview(id, versionNumber))
      }),
    )

    return jsonOk({
      approvals: approvals.map((a) =>
        a.status === 'pending' && a.kind === 'publish_dataset'
          ? { ...a, publishPreview: previews.get(a.targetId) ?? null }
          : a,
      ),
    })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load approvals')
  }
}

const createSchema = z.object({
  kind: z.enum(['publish_dataset', 'publish_pipeline']),
  targetId: z.string().min(1, 'targetId is required'),
  note: z.string().optional(),
})

export async function POST(req: NextRequest) {
  try {
    const denied = requireRole(req, 'editor')
    if (denied) return denied
    const role = getRole(req)

    let body: unknown
    try {
      body = await req.json()
    } catch {
      return badRequest('Request body must be valid JSON')
    }
    const parsed = createSchema.safeParse(body)
    if (!parsed.success) return badRequest(zodErrorMessage(parsed))
    const { kind, targetId, note } = parsed.data

    // Resolve the target's display name (dataset or pipeline).
    let targetName: string | null = null
    if (kind === 'publish_dataset') {
      const dataset = await db.dataset.findUnique({ where: { id: targetId }, select: { name: true } })
      targetName = dataset?.name ?? null
    } else {
      const pipeline = await db.pipeline.findUnique({ where: { id: targetId }, select: { name: true } })
      targetName = pipeline?.name ?? null
    }
    if (!targetName) return notFound(`Target '${targetId}' not found for kind '${kind}'`)

    const versionNumber = kind === 'publish_dataset' ? await latestDraftVersion(targetId) : null
    if (kind === 'publish_dataset' && versionNumber == null) {
      return badRequest('No draft version exists to request publication')
    }

    const duplicate = await db.approvalRequest.findFirst({
      where: { kind, targetId, status: 'pending' },
      select: { id: true },
    })
    if (duplicate) {
      return badRequest(`A pending ${kind} request for '${targetName}' already exists`)
    }

    const approval = await db.approvalRequest.create({
      data: {
        kind,
        targetId,
        versionNumber,
        targetName,
        requestedBy: role,
        note: note ?? null,
      },
    })

    audit({
      req,
      action: 'approval.request',
      resourceType: 'approval',
      resourceId: approval.id,
      resourceName: `${kind}: ${targetName}`,
      detail: note ?? null,
    })

    // R14: bell notification for the request (broadcast — admins decide it).
    await createNotification({
      type: 'approval_requested',
      title: `Approval requested: ${targetName}`,
      body: `${kind} by ${role}`,
      resourceType: 'approval',
      resourceId: approval.id,
      href: '/governance',
    })

    return jsonOk({ approval }, 201)
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to create approval request')
  }
}
