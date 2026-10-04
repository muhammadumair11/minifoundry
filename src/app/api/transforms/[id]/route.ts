// GET/PATCH/DELETE /api/transforms/[id] — transform detail, update, delete.
// Detail = list shape + the last 10 runs (latest first). Mutations require
// editor+ role and are audited.

import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { badRequest, jsonOk, notFound, serverError, zodErrorMessage } from '@/lib/api-utils'
import { audit, requireRole } from '@/lib/governance'
import {
  resolveInputNames,
  serializeTransform,
  serializeTransformRun,
} from '@/lib/transform-engine'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

const patchSchema = z.object({
  name: z.string().min(1, 'name is required').optional(),
  description: z.string().nullish(),
  language: z.enum(['sql', 'javascript', 'python']).optional(),
  sourceCode: z.string().min(1, 'sourceCode is required').optional(),
  inputs: z.array(z.string().min(1)).optional(),
  outputDatasetName: z.string().min(1, 'outputDatasetName is required').optional(),
})

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const transform = await db.transform.findUnique({
      where: { id },
      include: {
        runs: { orderBy: { startedAt: 'desc' }, take: 10 },
        _count: { select: { runs: true } },
      },
    })
    if (!transform) return notFound(`Transform '${id}' not found`)
    const inputNames = await resolveInputNames([transform])
    return jsonOk({
      transform: serializeTransform(transform, inputNames),
      runs: transform.runs.map(serializeTransformRun),
    })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load transform')
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
    try {
      const transform = await db.transform.update({
        where: { id },
        data: {
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.description !== undefined ? { description: data.description ?? null } : {}),
          ...(data.language !== undefined ? { language: data.language } : {}),
          ...(data.sourceCode !== undefined ? { sourceCode: data.sourceCode } : {}),
          ...(data.inputs !== undefined ? { inputsJson: JSON.stringify(data.inputs) } : {}),
          ...(data.outputDatasetName !== undefined ? { outputDatasetName: data.outputDatasetName } : {}),
        },
        include: {
          runs: { orderBy: { startedAt: 'desc' }, take: 10 },
          _count: { select: { runs: true } },
        },
      })
      const inputNames = await resolveInputNames([transform])
      audit({
        req,
        action: 'transform.update',
        resourceType: 'transform',
        resourceId: transform.id,
        resourceName: transform.name,
        detail: Object.keys(data).join(',') || null,
      })
      return jsonOk({
        transform: serializeTransform(transform, inputNames),
        runs: transform.runs.map(serializeTransformRun),
      })
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return badRequest(`A transform named '${parsed.data.name}' already exists`)
      }
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        return notFound(`Transform '${id}' not found`)
      }
      throw err
    }
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to update transform')
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
    const transform = await db.transform.findUnique({ where: { id }, select: { id: true, name: true } })
    if (!transform) return notFound(`Transform '${id}' not found`)

    // Runs cascade via the schema's onDelete: Cascade.
    await db.transform.delete({ where: { id } })

    audit({
      req,
      action: 'transform.delete',
      resourceType: 'transform',
      resourceId: transform.id,
      resourceName: transform.name,
    })

    return jsonOk({ ok: true })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to delete transform')
  }
}
