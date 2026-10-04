// POST /api/governance/seed-demo — idempotent M9 demo governance data:
//  - marking "PII" (minRole editor, rose) attached to Suppliers.name
//  - marking "Confidential" (minRole admin, amber) attached to Inventory.unitCost
//  - one pending ApprovalRequest publish_dataset targeting Shipments
//    ("Ready for production review") — skipped when one already exists.
// Admin-gated: it creates admin-only resources (markings + column markings).
// Returns { seeded, markings: [names], approvals: [ids] }.

import type { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { badRequest, jsonOk, serverError } from '@/lib/api-utils'
import { audit, requireRole } from '@/lib/governance'

export const dynamic = 'force-dynamic'

interface DemoMarkingSpec {
  name: string
  description: string
  color: 'rose' | 'amber' | 'teal' | 'zinc'
  minRole: 'viewer' | 'editor' | 'admin'
  datasetName: string
  columns: string[]
}

const DEMO_MARKINGS: DemoMarkingSpec[] = [
  {
    name: 'PII',
    description: 'Personally identifiable information — visible to editors and above.',
    color: 'rose',
    minRole: 'editor',
    datasetName: 'Suppliers',
    columns: ['name'],
  },
  {
    name: 'Confidential',
    description: 'Confidential commercial data — visible to admins only.',
    color: 'amber',
    minRole: 'admin',
    datasetName: 'Inventory',
    columns: ['unitCost'],
  },
]

export async function POST(req: NextRequest) {
  try {
    const denied = requireRole(req, 'admin')
    if (denied) return denied

    let seeded = false
    const markingNames: string[] = []
    const approvalIds: string[] = []

    // ── markings + column attachments ───────────────────────────────
    for (const spec of DEMO_MARKINGS) {
      let marking = await db.marking.findUnique({ where: { name: spec.name } })
      if (!marking) {
        marking = await db.marking.create({
          data: {
            name: spec.name,
            description: spec.description,
            color: spec.color,
            minRole: spec.minRole,
          },
        })
        seeded = true
        audit({
          req,
          action: 'marking.create',
          resourceType: 'marking',
          resourceId: marking.id,
          resourceName: marking.name,
          detail: `minRole ${marking.minRole}, color ${marking.color} (demo seed)`,
        })
      }
      markingNames.push(marking.name)

      // Backing dataset must exist for the attachment.
      const dataset = await db.dataset.findFirst({
        where: { name: spec.datasetName },
        select: { id: true, name: true },
      })
      if (!dataset) {
        return badRequest(
          `Dataset '${spec.datasetName}' not found — seed demo data first (POST /api/seed)`,
        )
      }

      for (const columnName of spec.columns) {
        const existing = await db.columnMarking.findUnique({
          where: { datasetId_columnName: { datasetId: dataset.id, columnName } },
          select: { id: true, markingId: true },
        })
        if (existing?.markingId === marking.id) continue
        await db.columnMarking.upsert({
          where: { datasetId_columnName: { datasetId: dataset.id, columnName } },
          create: { datasetId: dataset.id, columnName, markingId: marking.id },
          update: { markingId: marking.id },
        })
        seeded = true
        audit({
          req,
          action: 'marking.attach',
          resourceType: 'marking',
          resourceId: marking.id,
          resourceName: marking.name,
          detail: `dataset '${dataset.name}': column ${columnName} (demo seed)`,
        })
      }
    }

    // ── pending publish_dataset approval for Shipments ──────────────
    const shipments = await db.dataset.findFirst({
      where: { name: 'Shipments' },
      select: { id: true, name: true },
    })
    if (!shipments) {
      return badRequest(`Dataset 'Shipments' not found — seed demo data first (POST /api/seed)`)
    }

    const existingPending = await db.approvalRequest.findFirst({
      where: { kind: 'publish_dataset', targetId: shipments.id, status: 'pending' },
      select: { id: true },
    })
    if (existingPending) {
      approvalIds.push(existingPending.id)
    } else {
      const approval = await db.approvalRequest.create({
        data: {
          kind: 'publish_dataset',
          targetId: shipments.id,
          targetName: shipments.name,
          requestedBy: 'editor',
          note: 'Ready for production review',
        },
      })
      seeded = true
      approvalIds.push(approval.id)
      audit({
        req,
        action: 'approval.request',
        resourceType: 'approval',
        resourceId: approval.id,
        resourceName: `${approval.kind}: ${approval.targetName}`,
        detail: approval.note,
      })
    }

    return jsonOk({ seeded, markings: markingNames, approvals: approvalIds })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to seed governance demo data')
  }
}
