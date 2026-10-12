import { afterEach, expect, test } from 'bun:test'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import {
  fetchAuthBootstrap, invalidateAuthBootstrap, seedAuthQueries,
} from '../src/lib/auth-bootstrap'

const originalFetch = globalThis.fetch
const session = {
  role: 'admin', demoMode: false, organizationId: 'test-org', organizationRole: 'owner',
  session: { email: 'owner@example.invalid', name: 'Test Owner', role: 'admin', organizationRole: 'owner' },
}
const organizations = { organizations: [{ id: 'test-org', name: 'Test Organization', role: 'owner' }] }

afterEach(() => {
  globalThis.fetch = originalFetch
  invalidateAuthBootstrap()
})

test('first authenticated render has the organization and owner identity, without refresh', async () => {
  let resolveOrganizations!: (response: Response) => void
  const pendingOrganizations = new Promise<Response>((resolve) => { resolveOrganizations = resolve })
  const calls: string[] = []
  globalThis.fetch = (async (url: string, options: RequestInit) => {
    expect(options.cache).toBe('no-store')
    expect(options.credentials).toBe('same-origin')
    calls.push(url)
    return url === '/api/session' ? Response.json(session) : pendingOrganizations
  }) as typeof fetch
  let completed = false
  const pending = fetchAuthBootstrap().then((result) => { completed = true; return result })
  // Let the session response finish; the organization lookup remains delayed.
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(completed).toBe(false)
  resolveOrganizations(Response.json(organizations))
  const bootstrap = await pending
  const client = new QueryClient()
  seedAuthQueries(client, bootstrap)
  const identity = new QueryObserver(client, { queryKey: ['session'], staleTime: 30_000 })
  const roster = new QueryObserver(client, { queryKey: ['organizations'], staleTime: 30_000 })
  expect(identity.getCurrentResult().status).toBe('success')
  expect(identity.getCurrentResult().data).toMatchObject({ organizationRole: 'owner', organizationId: 'test-org' })
  expect(roster.getCurrentResult().status).toBe('success')
  expect(roster.getCurrentResult().data).toEqual(organizations)
  expect(calls).toEqual(['/api/session', '/api/organizations'])
  client.clear()
})

test('concurrent bootstrap consumers share one complete identity lookup', async () => {
  let calls = 0
  globalThis.fetch = (async (url: string) => {
    calls++
    return Response.json(url === '/api/session' ? session : organizations)
  }) as typeof fetch
  const [first, second] = await Promise.all([fetchAuthBootstrap(), fetchAuthBootstrap()])
  expect(first).toBe(second)
  expect(first?.organizations).toEqual(organizations)
  expect(calls).toBe(2)
})

test('anonymous sessions never fetch or seed organization identity', async () => {
  const calls: string[] = []
  globalThis.fetch = (async (url: string) => {
    calls.push(url)
    return Response.json({ role: 'anonymous', session: null, demoMode: false })
  }) as typeof fetch
  const bootstrap = await fetchAuthBootstrap()
  const client = new QueryClient()
  seedAuthQueries(client, bootstrap)
  expect(calls).toEqual(['/api/session'])
  expect(client.getQueryData(['session'])).toBeUndefined()
  expect(client.getQueryData(['organizations'])).toBeUndefined()
  client.clear()
})

test('a failed organization request preserves identity and leaves its query available for retry', async () => {
  globalThis.fetch = (async (url: string) => url === '/api/session'
    ? Response.json(session)
    : Response.json({ error: 'temporarily unavailable' }, { status: 503 })) as typeof fetch
  const bootstrap = await fetchAuthBootstrap()
  expect(bootstrap?.organizationRole).toBe('owner')
  const client = new QueryClient()
  seedAuthQueries(client, bootstrap)
  expect(client.getQueryData(['session'])).toMatchObject({ organizationRole: 'owner' })
  expect(client.getQueryData(['organizations'])).toBeUndefined()
  client.clear()
})

test('invalidating auth prevents an older in-flight identity from becoming the new cached identity', async () => {
  let releaseOldOrganizations!: (response: Response) => void
  const oldOrganizations = new Promise<Response>((resolve) => { releaseOldOrganizations = resolve })
  let old = true
  const viewer = {
    ...session, role: 'viewer', organizationId: 'other-org', organizationRole: 'viewer',
    session: { email: 'viewer@example.invalid', name: 'Test Viewer', role: 'viewer' },
  }
  globalThis.fetch = (async (url: string) => {
    if (url === '/api/session') return Response.json(old ? session : viewer)
    return old ? oldOrganizations : Response.json({ organizations: [{ id: 'other-org', name: 'Other Organization', role: 'viewer' }] })
  }) as typeof fetch
  const previous = fetchAuthBootstrap()
  await new Promise((resolve) => setTimeout(resolve, 0))
  invalidateAuthBootstrap()
  old = false
  const current = await fetchAuthBootstrap()
  releaseOldOrganizations(Response.json(organizations))
  await previous
  expect(await fetchAuthBootstrap()).toBe(current)
  expect(current?.session?.email).toBe('viewer@example.invalid')
  const client = new QueryClient()
  seedAuthQueries(client, current)
  expect(client.getQueryData(['session'])).toMatchObject({ organizationId: 'other-org', organizationRole: 'viewer' })
  expect(JSON.stringify(client.getQueryData(['organizations']))).not.toContain('Test Organization')
  client.clear()
})

test('a failed session request does not seed any identity', async () => {
  globalThis.fetch = (async () => { throw new Error('offline') }) as typeof fetch
  const bootstrap = await fetchAuthBootstrap()
  const client = new QueryClient()
  seedAuthQueries(client, bootstrap)
  expect(bootstrap).toBeNull()
  expect(client.getQueryData(['session'])).toBeUndefined()
  client.clear()
})
