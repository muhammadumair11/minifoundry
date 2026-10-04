// MiniFoundry — M10 auth + guard helpers for the public /api/foundry/v1/* routes.
// Every v1 route is READ-ONLY and token-authenticated: an ApiToken acts with
// VIEWER role, so column-marking masking applies (governance across the API
// surface). Each successful request bumps lastUsedAt/requestCount (fire-and-
// forget) and counts against the per-token sliding-window rate limit.
// M10.1: every AUTHENTICATED request is also logged to ApiRequestLog (fire-and-
// forget) for the usage dashboard — unauthenticated 401s are never logged (no
// token identity), but 429s are (the token id is known by then).

import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import type { ApiToken } from '@prisma/client'
import { db } from '@/lib/db'
import { authenticateApiToken, TOKEN_RATE_LIMIT } from '@/lib/token-service'
import { checkRateLimit, resetRateLimit, type RateLimitResult } from '@/lib/rate-limit'

export { TOKEN_RATE_LIMIT }

export type ApiTokenAuth =
  | { ok: true; token: ApiToken }
  | { ok: false; response: NextResponse }

/**
 * Token guard for v1 routes. Returns `{ ok: true, token }` on a valid live
 * token, otherwise a ready-to-return 401:
 * { error: 'invalid or missing API token' }.
 * On success the token's lastUsedAt/requestCount are updated fire-and-forget.
 */
export async function requireApiToken(req: NextRequest): Promise<ApiTokenAuth> {
  const token = await authenticateApiToken(req)
  if (!token) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'invalid or missing API token' }, { status: 401 }),
    }
  }
  touchToken(token.id)
  return { ok: true, token }
}

/** Fire-and-forget usage tracking — must never delay or break the response. */
function touchToken(tokenId: string): void {
  void db.apiToken
    .update({
      where: { id: tokenId },
      data: { lastUsedAt: new Date(), requestCount: { increment: 1 } },
    })
    .catch(() => {
      // usage tracking must never mask the response
    })
}

/** Attach X-RateLimit-Limit / -Remaining / -Reset (epoch ms) to a response. */
export function withRateLimitHeaders(response: NextResponse, rate: RateLimitResult): NextResponse {
  response.headers.set('X-RateLimit-Limit', String(TOKEN_RATE_LIMIT))
  response.headers.set('X-RateLimit-Remaining', String(rate.remaining))
  response.headers.set('X-RateLimit-Reset', String(rate.resetMs))
  return response
}

/** 429 with Retry-After + rate-limit headers. */
export function rateLimitExceeded(rate: RateLimitResult): NextResponse {
  const response = NextResponse.json(
    { error: 'rate limit exceeded', retryAfterSeconds: rate.retryAfterSeconds },
    { status: 429 },
  )
  response.headers.set('Retry-After', String(rate.retryAfterSeconds))
  return withRateLimitHeaders(response, rate)
}

/**
 * Preferred wrapper for v1 route handlers:
 * 1. 401 when the Bearer token is missing/unknown/revoked,
 * 2. 429 (+ Retry-After) when the token is over the rate limit,
 * 3. otherwise runs the handler and attaches rate-limit headers to its response.
 */
export async function withApiToken(
  req: NextRequest,
  handler: (ctx: { token: ApiToken; rate: RateLimitResult }) => Promise<NextResponse>,
): Promise<NextResponse> {
  const startedAt = Date.now()
  const auth = await requireApiToken(req)
  if (!auth.ok) return auth.response // 401: no token identity → NOT logged

  const rate = checkRateLimit(auth.token.id)
  if (!rate.allowed) {
    // 429: the token id is known, so it IS logged (M10.1).
    logApiRequest({ tokenId: auth.token.id, pathname: req.nextUrl.pathname, status: 429, startedAt })
    return rateLimitExceeded(rate)
  }

  try {
    const response = await handler({ token: auth.token, rate })
    logApiRequest({
      tokenId: auth.token.id,
      pathname: req.nextUrl.pathname,
      status: response.status,
      startedAt,
    })
    return withRateLimitHeaders(response, rate)
  } catch (err) {
    // Handler crashed before producing a response: log the resulting 500 and
    // rethrow — the route's own try/catch still builds the response.
    logApiRequest({ tokenId: auth.token.id, pathname: req.nextUrl.pathname, status: 500, startedAt })
    throw err
  }
}

/** Drop a token's rate-limit window (called by the revoke route). */
export function forgetTokenRateLimit(tokenId: string): void {
  resetRateLimit(tokenId)
}

// ─── M10.1: API usage logging ─────────────────────────────────────────

/** Request logs older than this are pruned (throttled, see logApiRequest). */
export const LOG_RETENTION_HOURS = 48

/** Route placeholder for a path segment after `datasets`/`pipelines`. */
const V1_ID_SEGMENT = ':id'
/** Route placeholders for the 1-2 path segments after `objects`. */
const V1_TYPE_SEGMENT = ':type'
const V1_PK_SEGMENT = ':pk'

const V1_PREFIX = '/api/foundry/v1'
const MAX_ROUTE_LENGTH = 64

/**
 * Collapse a request pathname into a stable route template so usage aggregates
 * group by SHAPE, not by id: `/api/foundry/v1/datasets/cmu123/rows` →
 * `/datasets/:id/rows`; `/api/foundry/v1/objects/supplier/SUP-001` →
 * `/objects/:type/:pk`; `/api/foundry/v1/whoami` → `/whoami`.
 * Non-v1 paths are returned as-is, truncated to 64 chars.
 */
export function templateRoute(pathname: string): string {
  if (pathname !== V1_PREFIX && !pathname.startsWith(V1_PREFIX + '/')) {
    return pathname.length > MAX_ROUTE_LENGTH ? pathname.slice(0, MAX_ROUTE_LENGTH) : pathname
  }
  const parts = pathname.slice(V1_PREFIX.length).split('/').filter(Boolean)
  const out: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const prev = i > 0 ? parts[i - 1] : undefined
    if (prev === 'datasets' || prev === 'pipelines') {
      out.push(V1_ID_SEGMENT)
    } else if (prev === 'objects') {
      out.push(V1_TYPE_SEGMENT)
    } else if (i >= 2 && parts[i - 2] === 'objects') {
      out.push(V1_PK_SEGMENT)
    } else {
      out.push(parts[i])
    }
  }
  return '/' + out.join('/')
}

/**
 * Delete request logs older than LOG_RETENTION_HOURS. Returns the row count.
 * Also exported for admin tooling; logApiRequest calls it on a 5-minute throttle.
 */
export async function pruneApiRequestLogs(): Promise<number> {
  const result = await db.apiRequestLog.deleteMany({
    where: { createdAt: { lt: new Date(Date.now() - LOG_RETENTION_HOURS * 3_600_000) } },
  })
  return result.count
}

const PRUNE_THROTTLE_MS = 5 * 60_000
/** Module-level throttle: at most one prune attempt per 5 minutes. */
let lastPruneAt = 0

/**
 * Fire-and-forget ApiRequestLog write for one authenticated v1 request.
 * Computes durationMs from `startedAt` (epoch ms captured at guard entry) and
 * templates the route so aggregates group by shape. Must never delay or break
 * the response; pruning piggybacks here on a 5-minute throttle.
 */
export function logApiRequest(params: {
  tokenId: string
  pathname: string
  status: number
  startedAt: number
}): void {
  const durationMs = Math.max(0, Math.round(Date.now() - params.startedAt))
  void db.apiRequestLog
    .create({
      data: {
        tokenId: params.tokenId,
        route: templateRoute(params.pathname),
        status: params.status,
        durationMs,
      },
    })
    .catch(() => {
      // usage logging must never mask the response
    })
  const now = Date.now()
  if (now - lastPruneAt > PRUNE_THROTTLE_MS) {
    lastPruneAt = now
    void pruneApiRequestLogs().catch(() => {
      // pruning is best-effort
    })
  }
}

// ─── V1 list envelope helpers ────────────────────────────────────────

export interface V1Page {
  page: number
  pageSize: number
}

/** Parse ?page= (1-based, default 1) and ?pageSize= (default 50, max 200). */
export function v1PageFrom(url: URL): V1Page {
  const page = Math.max(1, Math.floor(Number(url.searchParams.get('page') ?? '1') || 1))
  const pageSize = Math.min(200, Math.max(1, Math.floor(Number(url.searchParams.get('pageSize') ?? '50') || 50)))
  return { page, pageSize }
}

/** 1-based pagination block for list envelopes; totalPages is 0 when empty. */
export function v1Pagination(page: V1Page, total: number) {
  return {
    page: page.page,
    pageSize: page.pageSize,
    total,
    totalPages: Math.ceil(total / page.pageSize),
  }
}

/** Standard list envelope: { data, pagination }. */
export function v1List<T>(data: T[], page: V1Page, total: number) {
  return { data, pagination: v1Pagination(page, total) }
}
