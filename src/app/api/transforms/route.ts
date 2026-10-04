// GET/POST /api/transforms — M4 code transforms (workbooks).
// GET lists every transform with resolved input dataset names and the latest
// run summary; POST creates one (editor+ role, zod-validated).

import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { badRequest, jsonOk, serverError, zodErrorMessage } from '@/lib/api-utils'
import { audit, requireRole } from '@/lib/governance'
import { resolveInputNames, serializeTransform } from '@/lib/transform-engine'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

const createSchema = z.object({
  name: z.string().min(1, 'name is required'),
  description: z.string().nullish(),
  language: z.enum(['sql', 'javascript', 'python']).default('sql'),
  sourceCode: z.string().min(1, 'sourceCode is required'),
  inputs: z.array(z.string().min(1)).default([]),
  outputDatasetName: z.string().min(1, 'outputDatasetName is required'),
})

export async function GET() {
  try {
    const transforms = await db.transform.findMany({
      orderBy: { createdAt: 'asc' },
      include: {
        runs: { orderBy: { startedAt: 'desc' }, take: 1 },
        _count: { select: { runs: true } },
      },
    })
    const inputNames = await resolveInputNames(transforms)
    return jsonOk({ transforms: transforms.map((t) => serializeTransform(t, inputNames)) })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load transforms')
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

    const { name, description, language, sourceCode, inputs, outputDatasetName } = parsed.data
    try {
      const transform = await db.transform.create({
        data: {
          name,
          description: description ?? null,
          language,
          sourceCode,
          inputsJson: JSON.stringify(inputs),
          outputDatasetName,
        },
        include: {
          runs: { orderBy: { startedAt: 'desc' }, take: 1 },
          _count: { select: { runs: true } },
        },
      })
      const inputNames = await resolveInputNames([transform])
      audit({
        req,
        action: 'transform.create',
        resourceType: 'transform',
        resourceId: transform.id,
        resourceName: transform.name,
      })
      return jsonOk({ transform: serializeTransform(transform, inputNames) }, 201)
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return badRequest(`A transform named '${name}' already exists`)
      }
      throw err
    }
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to create transform')
  }
}
