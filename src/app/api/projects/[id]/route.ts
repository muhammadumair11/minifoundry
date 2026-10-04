// PATCH/DELETE /api/projects/[id] — finish M0 project management.
// PATCH (editor+) updates name/description; DELETE (editor+) detaches the
// project's datasets and pipelines (projectId -> null) and deletes the
// project. Both audited with resourceType "project".

import { z } from 'zod'
import { db } from '@/lib/db'
import { badRequest, jsonOk, notFound, serverError, zodErrorMessage } from '@/lib/api-utils'
import { audit, requireRole } from '@/lib/governance'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

const patchSchema = z.object({
  name: z.string().min(1, 'name is required').optional(),
  description: z.string().nullish(),
})

async function serializeProject(id: string) {
  const project = await db.project.findUnique({
    where: { id },
    include: { _count: { select: { datasets: true, pipelines: true } } },
  })
  if (!project) return null
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    datasetsCount: project._count.datasets,
    pipelinesCount: project._count.pipelines,
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

    const existing = await db.project.findUnique({ where: { id }, select: { id: true, name: true } })
    if (!existing) return notFound(`Project '${id}' not found`)

    await db.project.update({
      where: { id },
      data: {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.description !== undefined
          ? { description: parsed.data.description ?? null }
          : {}),
      },
    })

    audit({
      req,
      action: 'project.update',
      resourceType: 'project',
      resourceId: existing.id,
      resourceName: parsed.data.name ?? existing.name,
    })

    const project = await serializeProject(id)
    return jsonOk({ project })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to update project')
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
    const existing = await db.project.findUnique({ where: { id }, select: { id: true, name: true } })
    if (!existing) return notFound(`Project '${id}' not found`)

    // Detach first (datasets/pipelines keep existing, projectId -> null),
    // then delete the project itself.
    await db.dataset.updateMany({ where: { projectId: id }, data: { projectId: null } })
    await db.pipeline.updateMany({ where: { projectId: id }, data: { projectId: null } })
    await db.project.delete({ where: { id } })

    audit({
      req,
      action: 'project.delete',
      resourceType: 'project',
      resourceId: existing.id,
      resourceName: existing.name,
    })

    return jsonOk({ ok: true })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to delete project')
  }
}
