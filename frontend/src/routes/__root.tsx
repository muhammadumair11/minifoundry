import { Outlet, createRootRoute } from '@tanstack/react-router'
import { Providers } from '@/components/providers'
import { AppShell } from '@/components/foundry/app-shell'

export const Route = createRootRoute({
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
