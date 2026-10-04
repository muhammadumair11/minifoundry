// GET  /api/ontology — all object types with nested properties, links, actions.
// POST /api/ontology — create an object type from a backing dataset's latest
//                      schema (derives Property rows, humanized display names).

import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import {
  badRequest,
  jsonOk,
  notFound,
  parseSchema,
  serverError,
  zodErrorMessage,
} from '@/lib/api-utils'
import {
  OBJECT_TYPE_INCLUDE,
  deriveProperties,
  serializeObjectType,
} from '@/lib/ontology-service'
import { audit, requireRole } from '@/lib/governance'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

// GET /api/ontology — list object types.
export async function GET() {
  try {
    const objectTypes = await db.objectType.findMany({
      orderBy: { createdAt: 'asc' },
      include: OBJECT_TYPE_INCLUDE,
    })
    return jsonOk({ objectTypes: objectTypes.map(serializeObjectType) })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load ontology')
  }
}

const SLUG_RE = /^[a-z][a-z0-9_-]{1,63}$/

const createSchema = z.object({
  displayName: z.string().min(1),
  apiName: z
    .string()
    .regex(SLUG_RE, 'apiName must be a lowercase slug (letters, numbers, "-" or "_"), starting with a letter')
    .optional(),
  sourceDatasetId: z.string().min(1),
  primaryKey: z.string().min(1),
  titleProperty: z.string().min(1).optional(),
  description: z.string().nullish(),
  icon: z.string().min(1).optional(),
  color: z.string().min(1).optional(),
})

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

// POST /api/ontology — create an object type backed by a dataset.
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
    const input = parsed.data

    const apiName = input.apiName ?? slugify(input.displayName)
    if (!SLUG_RE.test(apiName)) {
      return badRequest(
        `Could not derive a valid apiName from displayName '${input.displayName}' — provide apiName explicitly`,
      )
    }

    const taken = await db.objectType.findUnique({ where: { apiName }, select: { id: true } })
    if (taken) return badRequest(`apiName '${apiName}' is already in use`)

    const dataset = await db.dataset.findUnique({
      where: { id: input.sourceDatasetId },
      include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1 } },
    })
    if (!dataset) return notFound(`Dataset '${input.sourceDatasetId}' not found`)
    if (dataset.versions.length === 0) {
      return badRequest(`Dataset '${dataset.name}' has no versions to derive properties from`)
    }

    const schema = parseSchema(dataset.versions[0])
    const titleProperty = input.titleProperty ?? input.primaryKey

    if (!schema.some((c) => c.name === input.primaryKey)) {
      return badRequest(
        `Primary key '${input.primaryKey}' not found in dataset '${dataset.name}' (columns: ${schema.map((c) => c.name).join(', ') || 'none'})`,
      )
    }
    if (!schema.some((c) => c.name === titleProperty)) {
      return badRequest(
        `titleProperty '${titleProperty}' not found in dataset '${dataset.name}' (columns: ${schema.map((c) => c.name).join(', ') || 'none'})`,
      )
    }

    const objectType = await db.objectType.create({
      data: {
        apiName,
        displayName: input.displayName,
        description: input.description ?? null,
        sourceDatasetId: dataset.id,
        primaryKey: input.primaryKey,
        icon: input.icon ?? 'box',
        color: input.color ?? 'emerald',
        properties: {
          create: deriveProperties(
            schema,
            input.primaryKey,
            input.titleProperty,
          ) as Prisma.PropertyUncheckedCreateInput[],
        },
      },
      include: OBJECT_TYPE_INCLUDE,
    })

    audit({
      req,
      action: 'ontology.create',
      resourceType: 'ontology',
      resourceId: objectType.id,
      resourceName: objectType.displayName,
      detail: `apiName '${objectType.apiName}' backed by dataset '${dataset.name}'`,
    })

    return jsonOk({ objectType: serializeObjectType(objectType) }, 201)
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to create object type')
  }
}
