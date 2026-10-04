// GET/PUT/PATCH/DELETE /api/pipelines/[id] — pipeline detail (with latest 20 runs,
// logs parsed), update, delete. PUT and PATCH share the same update handler.
// M3.1: every graph save snapshots an immutable PipelineVersion; when the first
// save after the versioning upgrade changes the graph, the PRE-save graph is
// backfilled as v1 first so the new graph becomes v2 (correct history order).

import { z } from 'zod'
import { db } from '@/lib/db'
import {
  badRequest,
  jsonOk,
  notFound,
  parseJsonSafe,
  serializeRun,
  serverError,
  zodErrorMessage,
} from '@/lib/api-utils'
import type { PipelineGraph } from '@/lib/engine'
import { ensurePipelineVersion, latestVersionNumber, snapshotPipelineVersion } from '@/lib/pipeline-version-service'
import { audit, getActor, requireRole } from '@/lib/governance'
import type { PipelineVersion } from '@prisma/client'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

const graphSchema = z.object({
  nodes: z.array(z.record(z.string(), z.unknown())),
  edges: z.array(z.record(z.string(), z.unknown())),
})

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  graph: graphSchema.optional(),
  // M3.1: free-text label stored on the version snapshot created by this save.
  versionNote: z.string().nullish(),
  // R14: upstream-trigger automation (Automation card).
  triggerMode: z.enum(['manual', 'upstream']).optional(),
  upstreamDatasetIds: z.array(z.string()).max(50).optional(),
  maxRetries: z.number().int().min(0).max(5).optional(),
})

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const pipeline = await db.pipeline.findUnique({ where: { id } })
    if (!pipeline) return notFound(`Pipeline '${id}' not found`)

    const runs = await db.pipelineRun.findMany({
      where: { pipelineId: id },
      orderBy: { startedAt: 'desc' },
      take: 20,
    })

    // M3.1 (additive): latest version + count for the versioning UI.
    const [latestVersion, versionCount] = await Promise.all([
      latestVersionNumber(id),
      db.pipelineVersion.count({ where: { pipelineId: id } }),
    ])

    return jsonOk({
      pipeline: {
        id: pipeline.id,
        name: pipeline.name,
        description: pipeline.description,
        graph: parseJsonSafe<PipelineGraph | null>(pipeline.graphJson, null),
        createdAt: pipeline.createdAt,
        updatedAt: pipeline.updatedAt,
        latestVersionNumber: latestVersion,
        versionCount,
        // R14: trigger automation config.
        triggerMode: pipeline.triggerMode,
        upstreamDatasetIds: parseJsonSafe<string[]>(pipeline.upstreamDatasetIds, []),
        maxRetries: pipeline.maxRetries,
      },
      runs: runs.map(serializeRun),
    })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load pipeline')
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return updatePipeline(req, { params })
}

// PATCH is an alias of PUT so version-aware clients can use the RESTier verb.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return updatePipeline(req, { params })
}

async function updatePipeline(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const denied = requireRole(req, 'editor')
    if (denied) return denied

    const { id } = await params
    const existing = await db.pipeline.findUnique({ where: { id }, select: { id: true } })
    if (!existing) return notFound(`Pipeline '${id}' not found`)

    let body: unknown
    try {
      body = await req.json()
    } catch {
      return badRequest('Request body must be valid JSON')
    }
    const parsed = updateSchema.safeParse(body)
    if (!parsed.success) return badRequest(zodErrorMessage(parsed))

    const graphChanged = parsed.data.graph !== undefined

    // M3.1: when a graph save lands on a pipeline with zero versions, snapshot
    // the PRE-save graph as v1 first so the new graph becomes v2 (correct order).
    if (graphChanged) await ensurePipelineVersion(id)

    const pipeline = await db.pipeline.update({
      where: { id },
      data: {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
        ...(parsed.data.graph !== undefined ? { graphJson: JSON.stringify(parsed.data.graph) } : {}),
        // R14: trigger automation (no version snapshot — config only).
        ...(parsed.data.triggerMode !== undefined ? { triggerMode: parsed.data.triggerMode } : {}),
        ...(parsed.data.upstreamDatasetIds !== undefined
          ? { upstreamDatasetIds: JSON.stringify(parsed.data.upstreamDatasetIds) }
          : {}),
        ...(parsed.data.maxRetries !== undefined ? { maxRetries: parsed.data.maxRetries } : {}),
      },
    })

    // M3.1: snapshot the NEW graph on every graph-changing save.
    let version: PipelineVersion | null = null
    if (graphChanged) {
      const actor = getActor(req)
      version = await snapshotPipelineVersion(id, JSON.stringify(parsed.data.graph), {
        note: parsed.data.versionNote ?? null,
        createdBy: actor.email ?? actor.role,
      })
    }

    audit({
      req,
      action: 'pipeline.update',
      resourceType: 'pipeline',
      resourceId: pipeline.id,
      resourceName: pipeline.name,
      detail: `updated ${[
        parsed.data.name !== undefined ? 'name' : null,
        parsed.data.description !== undefined ? 'description' : null,
        graphChanged ? 'graph' : null,
        version ? `version=${version.versionNumber}` : null,
        parsed.data.triggerMode !== undefined ? 'triggerMode' : null,
        parsed.data.upstreamDatasetIds !== undefined ? 'upstreamDatasetIds' : null,
        parsed.data.maxRetries !== undefined ? 'maxRetries' : null,
      ].filter(Boolean).join(', ')}`,
    })

    return jsonOk({
      pipeline: {
        id: pipeline.id,
        name: pipeline.name,
        description: pipeline.description,
        graph: parseJsonSafe<PipelineGraph | null>(pipeline.graphJson, null),
        createdAt: pipeline.createdAt,
        updatedAt: pipeline.updatedAt,
      },
    })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to update pipeline')
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
    const existing = await db.pipeline.findUnique({ where: { id }, select: { id: true, name: true } })
    if (!existing) return notFound(`Pipeline '${id}' not found`)

    // PipelineRun rows cascade via schema; lineage edges and version snapshots
    // are not FK-linked and are removed explicitly.
    await db.lineageEdge.deleteMany({ where: { pipelineId: id } })
    await db.pipelineVersion.deleteMany({ where: { pipelineId: id } })
    await db.pipeline.delete({ where: { id } })

    audit({
      req,
      action: 'pipeline.delete',
      resourceType: 'pipeline',
      resourceId: existing.id,
      resourceName: existing.name,
    })

    return jsonOk({ ok: true, deleted: existing.id, name: existing.name })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to delete pipeline')
  }
}
