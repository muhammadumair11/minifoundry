import type { QueryClient } from '@tanstack/react-query'
import type { SessionResponse } from '@/lib/foundry-types'

export type OrganizationsResponse = {
  organizations: Array<{ id: string; name: string; role: string }>
}
export type AuthBootstrap = Omit<SessionResponse, 'role'> & {
  role: string
  organizations?: OrganizationsResponse
}

let cached: Promise<AuthBootstrap | null> | null = null

export function invalidateAuthBootstrap(): void {
  cached = null
}

export function refreshAuthBootstrap(): Promise<AuthBootstrap | null> {
  invalidateAuthBootstrap()
  return fetchAuthBootstrap()
}

async function loadAuthBootstrap(): Promise<AuthBootstrap | null> {
  try {
    const response = await fetch('/api/session', { cache: 'no-store', credentials: 'same-origin' })
    if (!response.ok) return null
    const session: AuthBootstrap = await response.json()
    if (session.session) {
      // Finish the identity lookup BEFORE mounting the authenticated shell.
      // A temporary roster failure must not discard a valid session.
      try {
        const organizations = await fetch('/api/organizations', { cache: 'no-store', credentials: 'same-origin' })
        if (organizations.ok) session.organizations = await organizations.json()
      } catch { /* the header's query can retry this lookup */ }
    }
    return session
  } catch {
    return null
  }
}

export function fetchAuthBootstrap(): Promise<AuthBootstrap | null> {
  cached ??= loadAuthBootstrap()
  return cached
}

/** Seed both caches before any identity/permission query observer mounts. */
export function seedAuthQueries(client: QueryClient, bootstrap?: AuthBootstrap | null): void {
  if (!bootstrap) return
  const { organizations, ...session } = bootstrap
  const role = session.role
  if (role !== 'admin' && role !== 'editor' && role !== 'viewer') return
  client.setQueryData<SessionResponse>(['session'], { ...session, role })
  if (session.session && organizations) client.setQueryData(['organizations'], organizations)
}
