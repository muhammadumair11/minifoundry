// PATCH /api/connectors/[id] — update a connector's name/config (R14 14-b).
// Used by the connectors UI edit dialog (rest_url URL/format/dataPath fields).

import { z } from 'zod'
import { db } from '@/lib/db'
import {
  badRequest,
  jsonOk,
  notFound,
  serializeConnector,
  serverError,
  zodErrorMessage,
} from '@/lib/api-utils'
import { audit, requireRole } from '@/lib/governance'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

const patchSchema = z.object({
  name: z.string().min(1).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
})

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const denied = requireRole(req, 'editor')
    if (denied) return denied

    const { id } = await params
    const existing = await db.connector.findUnique({ where: { id } })
    if (!existing) return notFound(`Connector '${id}' not found`)

    let body: unknown
    try {
      body = await req.json()
    } catch {
      return badRequest('Request body must be valid JSON')
    }
    const parsed = patchSchema.safeParse(body)
    if (!parsed.success) return badRequest(zodErrorMessage(parsed))

    // Config merge: the dialog sends the full config object, but a partial
    // PATCH keeps unknown keys (learning-scale: shallow merge on purpose).
    let nextConfig = existing.config
    if (parsed.data.config !== undefined) {
      const merged = { ...serializeConfig(existing.config), ...parsed.data.config }
      nextConfig = JSON.stringify(merged)
    }

    const connector = await db.connector.update({
      where: { id },
      data: {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.config !== undefined ? { config: nextConfig } : {}),
      },
    })

    audit({
      req,
      action: 'connector.update',
      resourceType: 'connector',
      resourceId: connector.id,
      resourceName: connector.name,
      detail: `updated ${[
        parsed.data.name !== undefined ? 'name' : null,
        parsed.data.config !== undefined ? 'config' : null,
      ].filter(Boolean).join(', ')}`,
    })

    return jsonOk({ connector: serializeConnector(connector) })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to update connector')
  }
}

function serializeConfig(configJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(configJson) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
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
    const existing = await db.connector.findUnique({ where: { id } })
    if (!existing) return notFound(`Connector '${id}' not found`)

    // Ingestion rows reference the connector only loosely (connectorId is a
    // plain column with no FK), so the connector row deletes cleanly.
    await db.connector.delete({ where: { id } })

    audit({
      req,
      action: 'connector.delete',
      resourceType: 'connector',
      resourceId: existing.id,
      resourceName: existing.name,
    })

    return jsonOk({ ok: true, deleted: existing.id, name: existing.name })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to delete connector')
  }
}
