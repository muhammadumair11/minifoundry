// MiniFoundry — shared client-side fetch helper (Task 2-c).
// Throws Error with the API's { error } message so TanStack Query + sonner
// can surface it directly. Handles 204 No Content (e.g. DELETE endpoints).

import { toast } from 'sonner'

export async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    const err = new Error(body?.error ?? `Request failed (${res.status})`)
    // P2: attach the parsed error body so callers can read structured
    // detail (e.g. publish reasons: { error, detail: { reasons: [] } }).
    ;(err as Error & { payload?: unknown }).payload = body
    throw err
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

/** POST/PUT/DELETE JSON helper with the same error semantics as apiJson. */
export async function apiSend<T>(
  url: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body?: unknown,
): Promise<T> {
  return apiJson<T>(url, {
    method,
    ...(body !== undefined
      ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  })
}

/**
 * M9 API error UX: surface the server's { error } message (e.g. 403
 * "requires admin role (current: viewer)") as a sonner toast.
 * Call from mutation onError handlers; returns the message for reuse.
 */
export function toastApiError(err: unknown, title: string): string {
  const message = err instanceof Error ? err.message : 'Request failed'
  toast.error(title, { description: message })
  return message
}
