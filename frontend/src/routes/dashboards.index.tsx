import { createFileRoute, redirect } from '@tanstack/react-router'

// Legacy src/app/dashboards/page.tsx was a server redirect to /applications.
export const Route = createFileRoute('/dashboards/')({
  beforeLoad: () => {
    throw redirect({ to: '/applications' })
  },
})