// GET/POST /api/projects — platform projects/spaces.

import { z } from 'zod'
import { db } from '@/lib/db'
import { badRequest, jsonOk, serverError, zodErrorMessage } from '@/lib/api-utils'
import { requireRole } from '@/lib/governance'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

const createSchema = z.object({
  name: z.string().min(1, 'name is required'),
  description: z.string().optional(),
})

export async function GET() {
  try {
    const projects = await db.project.findMany({
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { datasets: true, pipelines: true } } },
    })
    return jsonOk({
      projects: projects.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        datasetsCount: p._count.datasets,
        pipelinesCount: p._count.pipelines,
      })),
    })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load projects')
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

    const project = await db.project.create({
      data: { name: parsed.data.name, description: parsed.data.description ?? null },
    })
    return jsonOk({ project }, 201)
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to create project')
  }
}
