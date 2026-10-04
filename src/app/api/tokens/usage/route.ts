// GET/DELETE /api/tokens/usage — M10.1 API usage observability (ADMIN ONLY).
// GET aggregates the last 24h of ApiRequestLog rows (written by the v1 guard)
// into a dashboard payload: totals, per-hour series (zero-filled, UTC hour
// boundaries), per-token join (in memory — logs outlive tokens), top templated
// routes and recent errors. DELETE clears ALL rows (QA reset valve).

import { db } from '@/lib/db'
import { jsonOk, serverError } from '@/lib/api-utils'
import { audit, requireRole } from '@/lib/governance'
import type { ApiUsageBucket, ApiUsageRoute, ApiUsageToken } from '@/lib/foundry-types'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

/** Dashboard window — the endpoint always returns exactly this many buckets. */
const USAGE_WINDOW_HOURS = 24

/** Safety cap: aggregation runs on at most this many rows (learning-scale). */
const USAGE_ROW_CAP = 20_000

/** Top-N routes in the payload. */
const TOP_ROUTES = 6

/** Tail length of recentErrors. */
const RECENT_ERRORS = 10

const HOUR_MS = 3_600_000

/**
 * WHY JS AGGREGATION: Prisma groupBy cannot truncate timestamps to hour
 * buckets on SQLite (no date_trunc), and raw SQL would bypass the typed
 * client this project standardizes on. So we select only the needed columns
 * capped at USAGE_ROW_CAP and aggregate in JS — fine at learning-scale.
 *
 * BUCKETS: exactly 24 hourly buckets ending at the current hour (oldest =
 * floorHour(now)-23h, newest = floorHour(now)). Any row in the leading sliver
 * of the 24h window (between now-24h and the oldest bucket, max 59min) counts
 * toward `total` but no bucket — keeps the series exactly windowHours long.
 */
export async function GET(req: NextRequest) {
  try {
    const denied = requireRole(req, 'admin')
    if (denied) return denied

    const now = Date.now()
    const since = new Date(now - USAGE_WINDOW_HOURS * HOUR_MS)

    const rows = await db.apiRequestLog.findMany({
      where: { createdAt: { gte: since } },
      select: { id: true, tokenId: true, route: true, status: true, durationMs: true, createdAt: true },
      take: USAGE_ROW_CAP,
    })

    // ── Hour buckets (zero-filled, oldest → newest, UTC boundaries) ──
    const firstBucketMs = Math.floor(now / HOUR_MS) * HOUR_MS - (USAGE_WINDOW_HOURS - 1) * HOUR_MS
    const buckets: ApiUsageBucket[] = Array.from({ length: USAGE_WINDOW_HOURS }, (_, i) => ({
      hourIso: hourIso(firstBucketMs + i * HOUR_MS),
      count: 0,
      errors: 0,
    }))

    // ── Per-token / per-route / totals ──
    const byToken = new Map<string, { count: number; lastSeenMs: number }>()
    const byRoute = new Map<string, number>()
    let ok = 0
    let errors = 0
    let limited = 0
    let durationSum = 0

    for (const row of rows) {
      const status = row.status
      const isOk = status >= 200 && status < 300
      const isError = status >= 400
      if (isOk) ok++
      if (isError) errors++
      if (status === 429) limited++
      durationSum += row.durationMs

      const bucketIdx = Math.floor(row.createdAt.getTime() / HOUR_MS) - firstBucketMs / HOUR_MS
      if (bucketIdx >= 0 && bucketIdx < USAGE_WINDOW_HOURS) {
        buckets[bucketIdx].count++
        if (isError) buckets[bucketIdx].errors++
      }

      const tokenAgg = byToken.get(row.tokenId)
      if (tokenAgg) {
        tokenAgg.count++
        tokenAgg.lastSeenMs = Math.max(tokenAgg.lastSeenMs, row.createdAt.getTime())
      } else {
        byToken.set(row.tokenId, { count: 1, lastSeenMs: row.createdAt.getTime() })
      }
      byRoute.set(row.route, (byRoute.get(row.route) ?? 0) + 1)
    }

    // ── Token join (in memory by id — logs survive token deletion) ──
    const tokenIds = [...byToken.keys()]
    const tokens = tokenIds.length
      ? await db.apiToken.findMany({
          where: { id: { in: tokenIds } },
          select: { id: true, name: true, prefix: true },
        })
      : []
    const tokenById = new Map(tokens.map((t) => [t.id, t]))
    const tokenRows: ApiUsageToken[] = [...byToken.entries()]
      .map(([tokenId, agg]) => ({
        tokenId,
        name: tokenById.get(tokenId)?.name ?? '(deleted token)',
        prefix: tokenById.get(tokenId)?.prefix ?? null,
        count: agg.count,
        lastSeen: new Date(agg.lastSeenMs).toISOString(),
      }))
      .sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen))

    const routeRows: ApiUsageRoute[] = [...byRoute.entries()]
      .map(([route, count]) => ({ route, count }))
      .sort((a, b) => b.count - a.count || a.route.localeCompare(b.route))
      .slice(0, TOP_ROUTES)

    const recentErrors = rows
      .filter((r) => r.status >= 400)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, RECENT_ERRORS)
      .map((r) => ({
        id: r.id,
        route: r.route,
        status: r.status,
        tokenId: r.tokenId,
        createdAt: r.createdAt.toISOString(),
      }))

    return jsonOk({
      windowHours: USAGE_WINDOW_HOURS,
      total: rows.length,
      ok,
      errors,
      limited,
      avgDurationMs: rows.length ? Math.round(durationSum / rows.length) : null,
      byHour: buckets,
      byToken: tokenRows,
      topRoutes: routeRows,
      recentErrors,
    })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load API usage')
  }
}

// DELETE /api/tokens/usage — clear ALL request logs (admin QA reset valve).
export async function DELETE(req: NextRequest) {
  try {
    const denied = requireRole(req, 'admin')
    if (denied) return denied

    const result = await db.apiRequestLog.deleteMany({})
    audit({
      req,
      action: 'apiUsage.clear',
      resourceType: 'apiToken',
      detail: `rows=${result.count}`,
    })
    return jsonOk({ pruned: result.count })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to clear API usage')
  }
}

/** '2026-10-02T19:00' — UTC hour boundary label for the byHour series. */
function hourIso(ms: number): string {
  const d = new Date(ms)
  const p2 = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}` +
    `T${p2(d.getUTCHours())}:00`
  )
}
