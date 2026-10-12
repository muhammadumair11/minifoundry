'use client'

// M10 Platform API (Task 6-c) — localStorage store for API token secrets the
// user created in this browser. Powers the Try-it console on /api-docs so it
// can pre-fill a secret. Max 10 entries, newest first. Never synced anywhere.

export const SAVED_TOKENS_KEY = 'foundry_api_tokens'
export const SAVED_TOKENS_MAX = 10

export interface SavedApiToken {
  id: string
  name: string
  prefix: string
  secret: string
  createdAt: string
}

export function loadSavedTokens(): SavedApiToken[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(SAVED_TOKENS_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? (parsed as SavedApiToken[]) : []
  } catch {
    return []
  }
}

/** Prepend (or replace by id), capped at SAVED_TOKENS_MAX. */
export function saveTokenToLocalStorage(entry: SavedApiToken): void {
  if (typeof window === 'undefined') return
  const current = loadSavedTokens().filter((t) => t.id !== entry.id)
  const next = [entry, ...current].slice(0, SAVED_TOKENS_MAX)
  window.localStorage.setItem(SAVED_TOKENS_KEY, JSON.stringify(next))
}

/** Drop one saved secret (e.g. after revoking the token). */
export function removeSavedToken(id: string): void {
  if (typeof window === 'undefined') return
  const next = loadSavedTokens().filter((t) => t.id !== id)
  window.localStorage.setItem(SAVED_TOKENS_KEY, JSON.stringify(next))
}

/** Drop all saved secrets (the Explorer's "Clear saved" button). */
export function clearSavedTokens(): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(SAVED_TOKENS_KEY, JSON.stringify([]))
}
