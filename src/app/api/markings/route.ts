// GET  /api/markings — list markings with the columns they mark (read: any role).
// POST /api/markings — create a marking (admin). Duplicate names -> 400.

import { z } from 'zod'
import { db } from '@/lib/db'
import {
  badRequest,
  jsonOk,
  serverError,
  zodErrorMessage,
} from '@/lib/api-utils'
import { audit, requireRole } from '@/lib/governance'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const markings = await db.marking.findMany({
      orderBy: { createdAt: 'asc' },
      include: {
        columnMarkings: {
          orderBy: { columnName: 'asc' },
          include: { dataset: { select: { id: true, name: true } } },
        },
      },
    })
    return jsonOk({
      markings: markings.map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        color: m.color,
        minRole: m.minRole,
        createdAt: m.createdAt,
        columns: m.columnMarkings.map((cm) => ({
          datasetId: cm.datasetId,
          datasetName: cm.dataset.name,
          columnName: cm.columnName,
        })),
      })),
    })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load markings')
  }
}

const createSchema = z.object({
  name: z.string().min(1, 'name is required'),
  description: z.string().optional(),
  color: z.enum(['rose', 'amber', 'teal', 'zinc']).default('rose'),
  minRole: z.enum(['viewer', 'editor', 'admin']).default('editor'),
})

export async function POST(req: NextRequest) {
  try {
    const denied = requireRole(req, 'admin')
    if (denied) return denied

    let body: unknown
    try {
      body = await req.json()
    } catch {
      return badRequest('Request body must be valid JSON')
    }
    const parsed = createSchema.safeParse(body)
    if (!parsed.success) return badRequest(zodErrorMessage(parsed))

    const existing = await db.marking.findUnique({ where: { name: parsed.data.name }, select: { id: true } })
    if (existing) return badRequest(`Marking '${parsed.data.name}' already exists`)

    const marking = await db.marking.create({
      data: {
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        color: parsed.data.color,
        minRole: parsed.data.minRole,
      },
    })

    audit({
      req,
      action: 'marking.create',
      resourceType: 'marking',
      resourceId: marking.id,
      resourceName: marking.name,
      detail: `minRole ${marking.minRole}, color ${marking.color}`,
    })

    return jsonOk(
      {
        marking: {
          id: marking.id,
          name: marking.name,
          description: marking.description,
          color: marking.color,
          minRole: marking.minRole,
          columns: [],
        },
      },
      201,
    )
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to create marking')
  }
}
