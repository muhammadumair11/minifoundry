// GET /api/dashboards/[id] — dashboard detail (any role may view).
// PATCH — update title/description/widgets (editor+ role).
// DELETE — remove the dashboard (editor+ role).

import { z } from 'zod'
import { db } from '@/lib/db'
import { badRequest, jsonOk, notFound, serverError, zodErrorMessage } from '@/lib/api-utils'
import { audit, requireRole } from '@/lib/governance'
import { serializeDashboard, widgetSchema } from '../shared'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

const patchSchema = z.object({
  title: z.string().min(1, 'title is required').max(200).optional(),
  description: z.string().max(2000).nullish(),
  widgets: z.array(widgetSchema).max(50).optional(),
})

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const dashboard = await db.dashboard.findUnique({ where: { id } })
    if (!dashboard) return notFound(`Dashboard '${id}' not found`)
    return jsonOk({ dashboard: serializeDashboard(dashboard) })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load dashboard')
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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

    const existing = await db.dashboard.findUnique({ where: { id }, select: { id: true, title: true } })
    if (!existing) return notFound(`Dashboard '${id}' not found`)

    const updated = await db.dashboard.update({
      where: { id },
      data: {
        ...(data.title !== undefined ? { title: data.title } : {}),
        ...(data.description !== undefined ? { description: data.description ?? null } : {}),
        ...(data.widgets !== undefined ? { layoutJson: JSON.stringify(data.widgets) } : {}),
      },
    })

    audit({
      req,
      action: 'dashboard.update',
      resourceType: 'dashboard',
      resourceId: updated.id,
      resourceName: updated.title,
      detail:
        data.widgets !== undefined
          ? `widgets=${data.widgets.length}${data.title !== undefined ? ' (renamed)' : ''}`
          : data.title !== undefined
            ? 'renamed'
            : null,
    })

    return jsonOk({ dashboard: serializeDashboard(updated) })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to update dashboard')
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const denied = requireRole(req, 'editor')
    if (denied) return denied

    const { id } = await params
    const existing = await db.dashboard.findUnique({ where: { id }, select: { id: true, title: true } })
    if (!existing) return notFound(`Dashboard '${id}' not found`)

    await db.dashboard.delete({ where: { id } })

    audit({
      req,
      action: 'dashboard.delete',
      resourceType: 'dashboard',
      resourceId: existing.id,
      resourceName: existing.title,
    })

    return jsonOk({ ok: true, deleted: existing.id })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to delete dashboard')
  }
}
