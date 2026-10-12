import { Outlet, createRootRoute, redirect } from '@tanstack/react-router'
import { Providers } from '@/components/providers'
import { AppShell } from '@/components/foundry/app-shell'

// ─── Mode-aware auth gate ────────────────────────────────────────────────
//
// GET /api/session resolves the EFFECTIVE actor (the gateway + auth service
// apply the runtime-mode rules):
//   • demo mode, no cookies      → { role: 'admin',      session: null } → PASS (sandbox)
//   • shared mode, no session    → { role: 'anonymous',  session: null } → GATE → /login?next=…
//   • signed in (either mode)    → { role: <role>,       session: {...} } → PASS
// The bootstrap fetch is cached module-wide and re-run after login/signup/
// logout via invalidateAuthBootstrap(). A network failure (backend down)
// FAILS OPEN — pages surface their own query errors instead of a redirect
// loop, matching the legacy app's behavior when the API was unreachable.

type SessionBootstrap = { role: string; session: unknown | null }

let cached: Promise<SessionBootstrap | null> | null = null

/** Drop the cached auth bootstrap (call after any auth-state change). */
export function invalidateAuthBootstrap(): void {
  cached = null
}

/** Drop the cache and return the fresh bootstrap (used by logout flows). */
export function refreshAuthBootstrap(): Promise<SessionBootstrap | null> {
  invalidateAuthBootstrap()
  return fetchAuthBootstrap()
}

export function fetchAuthBootstrap(): Promise<SessionBootstrap | null> {
  if (!cached) {
    cached = fetch('/api/session')
      .then((r) => (r.ok ? (r.json() as Promise<SessionBootstrap>) : null))
      .catch(() => null)
  }
  return cached
}

/** Routes reachable without any session in every mode. */
const AUTH_FREE_PATHS = ['/login', '/signup']

export const Route = createRootRoute({
  beforeLoad: async ({ location }) => {
    // Invitation links are deliberately public: recipients must be able to
    // inspect and accept one before they have a session.
    if (AUTH_FREE_PATHS.includes(location.pathname) || location.pathname.startsWith('/invite/')) return
    const s = await fetchAuthBootstrap()
    if (s && s.session === null && s.role === 'anonymous') {
      const next = `${location.pathname}${location.searchStr ?? ''}`
      throw redirect({ to: '/login', search: { next } })
    }
  },
  component: RootLayout,
})

// Mirrors the old app/layout.tsx: Providers → AppShell wraps every page.
// (SiteFooter is rendered by AppShell itself.)
function RootLayout() {
  return (
    <Providers>
      <AppShell>
        <Outlet />
      </AppShell>
    </Providers>
  )
}
