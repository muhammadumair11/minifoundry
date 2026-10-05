import { redirect } from 'next/navigation'

// The catalog is unified under Applications. Existing dashboard detail URLs
// remain available from the "Earlier dashboards" section there.
export default function DashboardsPage() {
  redirect('/applications')
}
