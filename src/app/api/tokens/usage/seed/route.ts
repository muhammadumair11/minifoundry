// POST /api/tokens/usage/seed — M10.1 demo-traffic seeder (ADMIN ONLY).
// Synthesizes realistic ApiRequestLog rows so the usage dashboard/chart has
// data to render before real traffic accumulates. Uses the newest ACTIVE
// (revokedAt null) ApiToken as the tokenId for every synthetic row.
//
// IDEMPOTENCE VALVE: refuses when recent usage data already exists. Beyond the
// spec'd ">20 rows in the last 1h" check it also refuses on ANY future-dated
// row — the seeder spreads the current (partial) hour bucket evenly across the
// full hour, so its tail lands slightly in the future, and no real request can
// ever be dated in the future. With the spec'd 3–20 rows/hour density the
// last-1h count alone would often stay below 20 after a seed, so the
// future-row check is what makes the immediate repeat-seed → 400
// deterministic. Same error body for both checks.

import { z } from 'zod'
import { db } from '@/lib/db'
import { badRequest, jsonOk, serverError, zodErrorMessage } from '@/lib/api-utils'
import { audit, requireRole } from '@/lib/governance'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

const HOUR_MS = 3_600_000

const seedSchema = z.object({
  hours: z.number().int().optional(),
})

/** Route mix weighted like real v1 usage (cumulative weight 100). */
const ROUTE_MIX: Array<{ route: string; weight: number }> = [
  { route: '/whoami', weight: 10 },
  { route: '/datasets', weight: 20 },
  { route: '/datasets/:id', weight: 15 },
  { route: '/datasets/:id/rows', weight: 25 },
  { route: '/objects/:type', weight: 15 },
  { route: '/pipelines', weight: 10 },
  { route: '/pipelines/:id', weight: 5 },
]

/**
 * Status mix: ~96% 200, ~2% 404, ~1% 403, ~1% 429. The spec's ~1% "401" is
 * mapped to 403 because the v1 guard never logs unauthenticated 401s (no
 * token identity) — 403 keeps an error class in the demo data.
 */
function pickStatus(): number {
  const r = Math.random()
  if (r < 0.96) return 200
  if (r < 0.98) return 404
  if (r < 0.99) return 403
  return 429
}

/** 5–120ms, lognormal-ish: bell-ish u∈[0,1] mapped through exp (median ≈ 25ms). */
function pickDurationMs(): number {
  const u = (Math.random() + Math.random() + Math.random()) / 3
  return Math.min(120, Math.max(5, Math.round(Math.exp(1.6 + 3.2 * u))))
}

function pickRoute(): string {
  const r = Math.random() * 100
  let acc = 0
  for (const entry of ROUTE_MIX) {
    acc += entry.weight
    if (r < acc) return entry.route
  }
  return ROUTE_MIX[ROUTE_MIX.length - 1].route
}

export async function POST(req: NextRequest) {
  try {
    const denied = requireRole(req, 'admin')
    if (denied) return denied

    let body: unknown = {}
    try {
      const raw = await req.json()
      body = raw ?? {}
    } catch {
      body = {} // empty/absent body → defaults
    }
    const parsed = seedSchema.safeParse(body)
    if (!parsed.success) return badRequest(zodErrorMessage(parsed))

    const hours = Math.min(48, Math.max(6, Math.floor(parsed.data.hours ?? 24)))

    // Idempotence valve — see file header.
    const now = Date.now()
    const recent = await db.apiRequestLog.count({
      where: { createdAt: { gte: new Date(now - HOUR_MS) } },
    })
    const future = await db.apiRequestLog.count({
      where: { createdAt: { gt: new Date(now) } },
    })
    if (recent > 20 || future > 0) {
      return badRequest('usage data already exists — clear it first')
    }

    const token = await db.apiToken.findFirst({
      where: { revokedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true },
    })
    if (!token) {
      return badRequest('no active API token found — create one first')
    }

    // Exactly `hours` full-hour buckets ending at the current hour boundary:
    // floorHour(now)-(hours-1)h … floorHour(now). Rows are spread EVENLY
    // within each bucket (midpoint spacing) so hour buckets align exactly.
    const firstBucketMs = Math.floor(now / HOUR_MS) * HOUR_MS - (hours - 1) * HOUR_MS
    const data: Array<{
      tokenId: string
      route: string
      status: number
      durationMs: number
      createdAt: Date
    }> = []

    for (let h = 0; h < hours; h++) {
      const bucketStart = firstBucketMs + h * HOUR_MS
      // Smooth diurnal-ish wave (peak ~14:00 UTC, trough ~02:00) + jitter,
      // clamped to the spec'd 3–20 requests/hour band.
      const hourOfDay = new Date(bucketStart).getUTCHours()
      const wave = Math.cos(((hourOfDay - 14) / 24) * Math.PI * 2)
      const jitter = Math.random() * 3 - 1.5
      const count = Math.min(20, Math.max(3, Math.round(11.5 + 8.5 * wave + jitter)))
      const step = HOUR_MS / count
      for (let i = 0; i < count; i++) {
        data.push({
          tokenId: token.id,
          route: pickRoute(),
          status: pickStatus(),
          durationMs: pickDurationMs(),
          createdAt: new Date(bucketStart + (i + 0.5) * step),
        })
      }
    }

    const result = await db.apiRequestLog.createMany({ data })

    audit({
      req,
      action: 'apiUsage.seed',
      resourceType: 'apiToken',
      resourceId: token.id,
      resourceName: token.name,
      detail: `rows=${result.count}`,
    })

    return jsonOk({ seeded: result.count }, 201)
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to seed API usage')
  }
}
