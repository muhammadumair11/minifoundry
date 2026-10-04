// GET/POST /api/connectors — data connectors (sample / csv_upload / json_upload / rest_url).

import { z } from 'zod'
import { db } from '@/lib/db'
import {
  badRequest,
  jsonOk,
  serializeConnector,
  serverError,
  zodErrorMessage,
} from '@/lib/api-utils'
import { audit, requireRole } from '@/lib/governance'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

const createSchema = z.object({
  name: z.string().min(1, 'name is required'),
  type: z.enum(['csv_upload', 'json_upload', 'rest_url', 'sample']),
  config: z.record(z.string(), z.unknown()).optional().default({}),
})

export async function GET() {
  try {
    const [connectors, ingestions] = await Promise.all([
      db.connector.findMany({ orderBy: { createdAt: 'asc' } }),
      db.ingestion.findMany({
        where: { connectorId: { not: null } },
        orderBy: { startedAt: 'desc' },
      }),
    ])

    // First (most recent) ingestion per connector.
    const lastByConnector = new Map<string, (typeof ingestions)[number]>()
    for (const ing of ingestions) {
      if (ing.connectorId && !lastByConnector.has(ing.connectorId)) {
        lastByConnector.set(ing.connectorId, ing)
      }
    }

    return jsonOk({
      connectors: connectors.map((c) => serializeConnector(c, lastByConnector.get(c.id) ?? null)),
    })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load connectors')
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

    const connector = await db.connector.create({
      data: {
        name: parsed.data.name,
        type: parsed.data.type,
        config: JSON.stringify(parsed.data.config ?? {}),
      },
    })
    audit({
      req, action: 'connector.create', resourceType: 'connector',
      resourceId: connector.id, resourceName: connector.name,
    })
    return jsonOk({ connector: serializeConnector(connector) }, 201)
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to create connector')
  }
}
