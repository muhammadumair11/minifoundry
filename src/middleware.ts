// MiniFoundry — platform auth boundary (Phase 0 "Foundation").
//
// In SHARED mode (`MF_DEMO_MODE=false`) this middleware requires authentication
// for EVERY /api/* request: either a valid `foundry-session` cookie or the
// scheduler's `x-service-token` header (token VALUE is validated, not just
// presence). Without one, the caller gets 401 — anonymous shared-mode requests
// can neither read nor mutate data, no matter what any individual route forgets
// to guard. It also neutralizes the role simulator cookie as an escalation
// vector: without a session it grants nothing at this boundary.
//
// In DEMO mode (default) this middleware is a pass-through — the sandbox's
// anonymous-admin behavior is preserved.
//
// Allowlist (both modes): auth + session routes must stay reachable so users
// can authenticate in the first place, and /api/health stays open for
// liveness probes (it returns aggregate well-being only, no row data).

import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { getSession } from '@/lib/auth-service'
import { isDemoMode, isServiceAuthorized } from '@/lib/runtime-mode'

const ALLOWED_PREFIXES = [
  '/api/auth', // login/logout — how a caller becomes authenticated
  '/api/session', // role simulator + whoami (demo affordance)
  '/api/health', // liveness probe (aggregate platform health, no domain rows)
  '/api/foundry/v1', // every v1 route validates its own bearer API token
]

export function middleware(req: NextRequest) {
  if (isDemoMode()) return NextResponse.next()

  const { pathname } = req.nextUrl
  if (!pathname.startsWith('/api/')) return NextResponse.next()
  if (ALLOWED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return NextResponse.next()

  const hasSession = Boolean(getSession(req))
  const hasServiceToken = isServiceAuthorized(req)
  if (hasSession || hasServiceToken) return NextResponse.next()

  return NextResponse.json(
    {
      error:
        'Authentication required. MiniFoundry is running in shared mode — sign in at /login ' +
        '(machine callers: x-service-token header).',
    },
    { status: 401 },
  )
}

export const config = {
  matcher: ['/api/:path*'],
  // The session verify uses node:crypto (HMAC) — run this middleware on the
  // Node.js runtime (stable in Next 16), not the edge sandbox.
  runtime: 'nodejs',
}
