// GET /api/transforms/[id]/runs?limit=20 — run history for one transform,
// latest first. limit is capped at 100.

import { db } from '@/lib/db'
import { jsonOk, notFound, serverError } from '@/lib/api-utils'
import { serializeTransformRun } from '@/lib/transform-engine'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const transform = await db.transform.findUnique({ where: { id }, select: { id: true } })
    if (!transform) return notFound(`Transform '${id}' not found`)

    const parsed = Number(req.nextUrl.searchParams.get('limit') ?? '20')
    const limit = Number.isFinite(parsed) ? Math.min(Math.max(Math.trunc(parsed), 1), 100) : 20

    const runs = await db.transformRun.findMany({
      where: { transformId: id },
      orderBy: { startedAt: 'desc' },
      take: limit,
    })
    return jsonOk({ runs: runs.map(serializeTransformRun) })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load transform runs')
  }
}
