// GET /api/applications/[id] — application detail (any role may view).
// PATCH — update name/description/config (editor+ role).
// DELETE — remove the application (editor+ role).

import { z } from 'zod'
import { db } from '@/lib/db'
import { badRequest, jsonOk, notFound, serverError, zodErrorMessage } from '@/lib/api-utils'
import { audit, requireRole } from '@/lib/governance'
import { appConfigSchema, serializeApplication } from '../shared'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

const patchSchema = z.object({
  name: z.string().min(1, 'name is required').max(200).optional(),
  description: z.string().max(2000).nullish(),
  config: appConfigSchema.optional(),
})

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const application = await db.application.findUnique({ where: { id } })
    if (!application) return notFound(`Application '${id}' not found`)
    return jsonOk({ application: serializeApplication(application) })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load application')
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

    const existing = await db.application.findUnique({ where: { id }, select: { id: true, name: true } })
    if (!existing) return notFound(`Application '${id}' not found`)

    const updated = await db.application.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.description !== undefined ? { description: data.description ?? null } : {}),
        ...(data.config !== undefined ? { configJson: JSON.stringify(data.config) } : {}),
      },
    })

    audit({
      req,
      action: 'application.update',
      resourceType: 'application',
      resourceId: updated.id,
      resourceName: updated.name,
      detail:
        data.config !== undefined
          ? `widgets=${data.config.widgets.length} filters=${data.config.filters.length}${data.name !== undefined ? ' (renamed)' : ''}`
          : data.name !== undefined
            ? 'renamed'
            : null,
    })

    return jsonOk({ application: serializeApplication(updated) })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to update application')
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const denied = requireRole(req, 'editor')
    if (denied) return denied

    const { id } = await params
    const existing = await db.application.findUnique({ where: { id }, select: { id: true, name: true } })
    if (!existing) return notFound(`Application '${id}' not found`)

    await db.application.delete({ where: { id } })

    audit({
      req,
      action: 'application.delete',
      resourceType: 'application',
      resourceId: existing.id,
      resourceName: existing.name,
    })

    return jsonOk({ ok: true, deleted: existing.id })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to delete application')
  }
}
