// GET /api/audit — audit trail, latest first.
// Optional filters: ?resourceType= (exact), ?action= (exact).
// P5 scale track: ?limit= (1..200, default 100) + ?offset= (0..10_000), with
// a meta { total, limit, offset } block for "load more" clients.

import type { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { jsonOk, serverError } from '@/lib/api-utils'

export const dynamic = 'force-dynamic'

function boundedNumber(raw: string | null, fallback: number, min: number, max: number): number {
  const n = Number(raw ?? '')
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const resourceType = url.searchParams.get('resourceType')
    const action = url.searchParams.get('action')
    const limit = boundedNumber(url.searchParams.get('limit'), 100, 1, 200)
    const offset = boundedNumber(url.searchParams.get('offset'), 0, 0, 10_000)

    const where = {
      ...(resourceType ? { resourceType } : {}),
      ...(action ? { action } : {}),
    }

    const [entries, total] = await Promise.all([
      db.auditEntry.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      db.auditEntry.count({ where }),
    ])

    return jsonOk({ entries, meta: { total, limit, offset } })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load audit entries')
  }
}
