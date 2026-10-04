// GET/POST /api/pipelines — pipeline list & creation.

import { z } from 'zod'
import { db } from '@/lib/db'
import { badRequest, jsonOk, parseJsonSafe, serverError, zodErrorMessage } from '@/lib/api-utils'
import type { PipelineGraph } from '@/lib/engine'
import { audit, requireRole } from '@/lib/governance'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

const graphSchema = z.object({
  nodes: z.array(z.record(z.string(), z.unknown())),
  edges: z.array(z.record(z.string(), z.unknown())),
})

const createSchema = z.object({
  name: z.string().min(1, 'name is required'),
  description: z.string().optional(),
  graph: graphSchema.optional(),
})

export async function GET() {
  try {
    const pipelines = await db.pipeline.findMany({
      orderBy: { updatedAt: 'desc' },
      include: {
        runs: {
          orderBy: { startedAt: 'desc' },
          take: 1,
          select: { id: true, status: true, startedAt: true, finishedAt: true },
        },
        _count: { select: { runs: true } },
      },
    })
    return jsonOk({
      pipelines: pipelines.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        graph: parseJsonSafe<PipelineGraph | null>(p.graphJson, null),
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        runsCount: p._count.runs,
        lastRun: p.runs[0] ?? null,
      })),
    })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load pipelines')
  }
}

export async function POST(req: NextRequest) {
  try {
    const denied = requireRole(req, 'editor')
    if (denied) return denied

    let body: unknown
    try {
      body = await req.json()
    } catch {
      return badRequest('Request body must be valid JSON')
    }
    const parsed = createSchema.safeParse(body)
    if (!parsed.success) return badRequest(zodErrorMessage(parsed))

    const pipeline = await db.pipeline.create({
      data: {
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        graphJson: JSON.stringify(parsed.data.graph ?? { nodes: [], edges: [] }),
      },
    })

    audit({
      req,
      action: 'pipeline.create',
      resourceType: 'pipeline',
      resourceId: pipeline.id,
      resourceName: pipeline.name,
    })
    return jsonOk(
      {
        pipeline: {
          id: pipeline.id,
          name: pipeline.name,
          description: pipeline.description,
          graph: parseJsonSafe<PipelineGraph>(pipeline.graphJson, { nodes: [], edges: [] }),
          createdAt: pipeline.createdAt,
          updatedAt: pipeline.updatedAt,
        },
      },
      201,
    )
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to create pipeline')
  }
}
