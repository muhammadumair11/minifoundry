import { Outlet, createRootRoute, redirect } from '@tanstack/react-router'
import { Providers } from '@/components/providers'
import { AppShell } from '@/components/foundry/app-shell'
import { fetchAuthBootstrap, invalidateAuthBootstrap } from '@/lib/auth-bootstrap'
export { fetchAuthBootstrap, invalidateAuthBootstrap, refreshAuthBootstrap } from '@/lib/auth-bootstrap'

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

/** Routes reachable without any session in every mode. */
const AUTH_FREE_PATHS = ['/login', '/signup']

export const Route = createRootRoute({
  beforeLoad: async ({ location }) => {
    // Invitation links are deliberately public: recipients must be able to
    // inspect and accept one before they have a session.
    if (AUTH_FREE_PATHS.includes(location.pathname) || location.pathname.startsWith('/invite/')) return { authBootstrap: null }
    if (location.pathname.startsWith('/api-tokens')) invalidateAuthBootstrap()
    const s = await fetchAuthBootstrap()
    if (location.pathname.startsWith('/api-tokens') && s && s.role !== 'admin') {
      throw redirect({ to: '/settings' })
    }
    if (s && s.session === null && s.role === 'anonymous') {
      const next = `${location.pathname}${location.searchStr ?? ''}`
      throw redirect({ to: '/login', search: { next } })
    }
    return { authBootstrap: s }
  },
  component: RootLayout,
})

// Mirrors the old app/layout.tsx: Providers → AppShell wraps every page.
// (SiteFooter is rendered by AppShell itself.)
function RootLayout() {
  const { authBootstrap } = Route.useRouteContext()
  return (
    <Providers initialAuth={authBootstrap}>
      <AppShell>
        <Outlet />
      </AppShell>
    </Providers>
  )
}
