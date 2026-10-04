// GET /api/foundry/v1/whoami — identity + API meta for the caller's token.
// Public read API (M10): Bearer-token authenticated, viewer-role masking
// applies, rate-limit headers attached.

import { jsonOk, serverError } from '@/lib/api-utils'
import { TOKEN_RATE_LIMIT, withApiToken } from '@/lib/api-v1'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
    return await withApiToken(req, async ({ token }) => {
      return jsonOk({
        token: {
          name: token.name,
          prefix: token.prefix,
          createdAt: token.createdAt,
          lastUsedAt: token.lastUsedAt,
          requestCount: token.requestCount,
        },
        api: { version: 'v1', rateLimitPerMinute: TOKEN_RATE_LIMIT },
      })
    })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'whoami failed')
  }
}
