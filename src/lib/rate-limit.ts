// MiniFoundry — M10 in-memory sliding-window rate limiter for API tokens.
// Map<tokenId, number[]> of request timestamps; entries older than the window
// are pruned on every call. Module-level state is fine at learning scale
// (single-process dev server); a production clone would use Redis.

import { TOKEN_RATE_LIMIT } from '@/lib/token-service'

const WINDOW_MS = 60_000

const hits = new Map<string, number[]>()

export interface RateLimitResult {
  allowed: boolean
  /** Requests still available in the current window (0 when blocked). */
  remaining: number
  /** Epoch ms when the oldest request in the window expires. */
  resetMs: number
  /** Seconds until the caller may retry (0 when allowed). */
  retryAfterSeconds: number
}

/**
 * Record one request for `tokenId` and decide whether it fits the window.
 * Prunes expired timestamps first, so memory stays bounded per active token.
 */
export function checkRateLimit(tokenId: string, limit: number = TOKEN_RATE_LIMIT): RateLimitResult {
  const now = Date.now()
  const recent = (hits.get(tokenId) ?? []).filter((ts) => now - ts < WINDOW_MS)

  if (recent.length >= limit) {
    hits.set(tokenId, recent)
    const resetMs = recent[0] + WINDOW_MS
    return {
      allowed: false,
      remaining: 0,
      resetMs,
      retryAfterSeconds: Math.max(1, Math.ceil((resetMs - now) / 1000)),
    }
  }

  recent.push(now)
  hits.set(tokenId, recent)
  const resetMs = recent[0] + WINDOW_MS
  return {
    allowed: true,
    remaining: limit - recent.length,
    resetMs,
    retryAfterSeconds: 0,
  }
}

/** Drop all remembered timestamps for a token (used when a token is revoked). */
export function resetRateLimit(tokenId: string): void {
  hits.delete(tokenId)
}
