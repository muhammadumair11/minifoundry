// GET/POST /api/tokens — M10 Platform API token management (ADMIN ONLY).
// GET lists tokens ordered createdAt desc — the tokenHash and the plaintext
// secret are NEVER returned. POST creates a token and returns the plaintext
// secret EXACTLY ONCE (only the sha256 hash is stored).

import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { badRequest, jsonOk, serverError, zodErrorMessage } from '@/lib/api-utils'
import { audit, requireRole } from '@/lib/governance'
import { generateToken } from '@/lib/token-service'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

const createSchema = z.object({
  name: z.string().min(1).max(64),
})

export async function GET(req: NextRequest) {
  try {
    const denied = requireRole(req, 'admin')
    if (denied) return denied

    const tokens = await db.apiToken.findMany({ orderBy: { createdAt: 'desc' } })
    return jsonOk({
      tokens: tokens.map((t) => ({
        id: t.id,
        name: t.name,
        prefix: t.prefix,
        requestCount: t.requestCount,
        lastUsedAt: t.lastUsedAt,
        revokedAt: t.revokedAt,
        createdAt: t.createdAt,
      })),
    })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load API tokens')
  }
}

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

    const generated = generateToken()
    const token = await db.apiToken.create({
      data: {
        name: parsed.data.name,
        tokenHash: generated.tokenHash,
        prefix: generated.prefix,
      },
    })

    audit({
      req,
      action: 'apiToken.create',
      resourceType: 'apiToken',
      resourceId: token.id,
      resourceName: token.name,
      detail: `name=${token.name} prefix=${token.prefix}`,
    })

    return jsonOk(
      {
        token: {
          id: token.id,
          name: token.name,
          prefix: token.prefix,
          createdAt: token.createdAt,
        },
        secret: generated.secret,
      },
      201,
    )
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return badRequest('Token name is already in use')
    }
    return serverError(err instanceof Error ? err.message : 'Failed to create API token')
  }
}
