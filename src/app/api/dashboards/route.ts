// GET /api/dashboards — list dashboards with widgetCount (any role may view).
// POST /api/dashboards — create an empty dashboard (editor+ role required).

import { z } from 'zod'
import { db } from '@/lib/db'
import { badRequest, jsonOk, parseJsonSafe, serverError, zodErrorMessage } from '@/lib/api-utils'
import { audit, getActor, requireRole } from '@/lib/governance'
import { serializeDashboard } from './shared'
import type { DashboardWidget } from '@/lib/foundry-types'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

const postSchema = z.object({
  title: z.string().min(1, 'title is required').max(200),
  description: z.string().max(2000).nullish(),
})

export async function GET(req: NextRequest) {
  try {
    const dashboards = await db.dashboard.findMany({
      orderBy: { updatedAt: 'desc' },
      select: { id: true, title: true, description: true, layoutJson: true, createdAt: true, updatedAt: true },
    })
    return jsonOk({
      dashboards: dashboards.map((d) => ({
        id: d.id,
        title: d.title,
        description: d.description,
        createdAt: d.createdAt.toISOString(),
        updatedAt: d.updatedAt.toISOString(),
        widgetCount: parseJsonSafe<DashboardWidget[]>(d.layoutJson, []).length,
      })),
    })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load dashboards')
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
    const parsed = postSchema.safeParse(body)
    if (!parsed.success) return badRequest(zodErrorMessage(parsed))

    const actor = getActor(req)
    const dashboard = await db.dashboard.create({
      data: {
        title: parsed.data.title,
        description: parsed.data.description ?? null,
        layoutJson: '[]',
        createdBy: actor.email,
      },
    })

    audit({
      req,
      action: 'dashboard.create',
      resourceType: 'dashboard',
      resourceId: dashboard.id,
      resourceName: dashboard.title,
    })

    return jsonOk({ dashboard: serializeDashboard(dashboard) }, 201)
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to create dashboard')
  }
}
