// GET/PATCH/DELETE /api/datasets/[id] — dataset detail with versions, update,
// or cascade delete.
// GET is governance-aware: current.schema columns carry an additive
// "markedWith" field (marking name | null). R14: accepts ?branch=<name>
// (default main) — `current` then resolves to that branch's HEAD version and
// the payload gains an additive `branch` field (dataset row + per-version).
// PATCH (editor+) updates name, description and the keepLastN retention
// window (M2). DELETE requires editor+ role.

import { z } from 'zod'
import { db } from '@/lib/db'
import {
  badRequest,
  jsonOk,
  notFound,
  parseJsonSafe,
  parseSchema,
  serverError,
  zodErrorMessage,
} from '@/lib/api-utils'
import { audit, maskSchema, requireRole } from '@/lib/governance'
import { setQualityGate } from '@/lib/publication'
import { resolveProvenanceMany } from '@/lib/provenance'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

const patchSchema = z.object({
  name: z.string().min(1, 'name is required').optional(),
  description: z.string().nullish(),
  // 0 = unlimited retention
  keepLastN: z.number().int().min(0).max(1000).optional(),
  // null = unassign from any project (M0)
  projectId: z.string().nullish(),
  // P2 trust workflow: toggle the publication gate (enable = new versions
  // land as drafts; disable = drafts publish immediately).
  qualityGate: z.boolean().optional(),
})

/** Shared detail payload for GET + PATCH (same shape, governance-aware). */
async function loadDetail(id: string, branchParam?: string | null) {
  const dataset = await db.dataset.findUnique({
    where: { id },
    include: {
      versions: {
        orderBy: { versionNumber: 'desc' },
        select: {
          id: true,
          versionNumber: true,
          rowCount: true,
          createdBy: true,
          createdAt: true,
          schemaJson: true,
          branch: true,
          lifecycle: true,
          qualityState: true,
        },
      },
    },
  })
  if (!dataset) return null

  // Resolve per-version provenance (unique createdBy values once each).
  const provenanceList = await resolveProvenanceMany(dataset.versions.map((v) => v.createdBy))

  // R14: resolve the head version for the requested branch. No/unknown param
  // keeps the legacy behavior (latest version overall = main head normally).
  let headVersion: (typeof dataset.versions)[number] | null = dataset.versions[0] ?? null
  let resolvedBranch: string | null = null
  if (branchParam && branchParam !== 'main') {
    const branch = await db.datasetBranch.findUnique({
      where: { datasetId_name: { datasetId: id, name: branchParam } },
      select: { name: true, headVersion: true },
    })
    if (!branch) return { unknownBranch: branchParam as string }
    resolvedBranch = branch.name
    headVersion = dataset.versions.find((v) => v.versionNumber === branch.headVersion) ?? null
  }

  return {
    dataset: {
      id: dataset.id,
      name: dataset.name,
      description: dataset.description,
      projectId: dataset.projectId,
      sourceConnectorId: dataset.sourceConnectorId,
      tags: parseJsonSafe<string[]>(dataset.tags, []),
      createdAt: dataset.createdAt,
      updatedAt: dataset.updatedAt,
      versionsCount: dataset.versions.length,
      keepLastN: dataset.keepLastN,
      // P2 trust workflow: gate state + consumer pointer.
      qualityGate: dataset.qualityGate,
      publishedVersion: dataset.publishedVersion,
      // R14 additive: resolved branch when ?branch= was requested.
      ...(resolvedBranch ? { branch: resolvedBranch } : {}),
    },
    versions: dataset.versions.map((v, idx) => ({
      id: v.id,
      versionNumber: v.versionNumber,
      rowCount: v.rowCount,
      createdBy: v.createdBy,
      createdAt: v.createdAt,
      // R14 additive: which branch the version was committed on.
      branch: v.branch,
      // P2 additive: publication lifecycle + quality state.
      lifecycle: v.lifecycle,
      qualityState: v.qualityState,
      // Additive: human-readable writer ("Pipeline — Shipment Overview").
      provenance: provenanceList[idx],
    })),
    current: headVersion
      ? {
          id: headVersion.id,
          versionNumber: headVersion.versionNumber,
          schema: await maskSchema(parseSchema(headVersion), id),
          rowCount: headVersion.rowCount,
        }
      : null,
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const branchParam = new URL(req.url).searchParams.get('branch')
    const detail = await loadDetail(id, branchParam)
    if (!detail) return notFound(`Dataset '${id}' not found`)
    if ('unknownBranch' in detail) {
      return badRequest(`Unknown branch '${detail.unknownBranch}' on dataset '${id}'`)
    }
    return jsonOk(detail)
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load dataset')
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const denied = requireRole(req, 'editor')
    if (denied) return denied

    const { id } = await params
    let body: unknown
    try {
      body = await req.json()
    } catch {
      return badRequest('Request body must be valid JSON')
    }
    const parsed = patchSchema.safeParse(body)
    if (!parsed.success) return badRequest(zodErrorMessage(parsed))
    const data = parsed.data

    const existing = await db.dataset.findUnique({ where: { id }, select: { id: true, name: true } })
    if (!existing) return notFound(`Dataset '${id}' not found`)

    // Validate the target project exists when assigning (null = unassign).
    if (data.projectId) {
      const project = await db.project.findUnique({
        where: { id: data.projectId },
        select: { id: true },
      })
      if (!project) return badRequest(`Project '${data.projectId}' not found`)
    }

    await db.dataset.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.description !== undefined ? { description: data.description ?? null } : {}),
        ...(data.keepLastN !== undefined ? { keepLastN: data.keepLastN } : {}),
        ...(data.projectId !== undefined ? { projectId: data.projectId ?? null } : {}),
      },
    })

    // P2: gate toggle is a separate write (it also publishes drafts / backfills
    // the consumer pointer), so it runs after the plain field update.
    if (data.qualityGate !== undefined) {
      await setQualityGate(id, data.qualityGate)
    }

    audit({
      req,
      action: 'dataset.update',
      resourceType: 'dataset',
      resourceId: existing.id,
      resourceName: data.name ?? existing.name,
      detail:
        data.qualityGate !== undefined
          ? `qualityGate=${data.qualityGate}`
          : data.projectId !== undefined
            ? `projectId=${data.projectId ?? 'null'}`
            : data.keepLastN !== undefined
              ? `keepLastN=${data.keepLastN}`
              : null,
    })

    const detail = await loadDetail(id)
    return jsonOk(detail)
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to update dataset')
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const denied = requireRole(req, 'editor')
    if (denied) return denied

    const { id } = await params
    const dataset = await db.dataset.findUnique({ where: { id }, select: { id: true, name: true } })
    if (!dataset) return notFound(`Dataset '${id}' not found`)

    // Lineage edges are not FK-linked, clean them up manually.
    await db.lineageEdge.deleteMany({
      where: { OR: [{ fromDatasetId: id }, { toDatasetId: id }] },
    })
    // DatasetVersion rows cascade via the schema's onDelete: Cascade.
    await db.dataset.delete({ where: { id } })

    audit({
      req,
      action: 'dataset.delete',
      resourceType: 'dataset',
      resourceId: dataset.id,
      resourceName: dataset.name,
    })

    return jsonOk({ ok: true, deleted: dataset.id, name: dataset.name })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to delete dataset')
  }
}
