import { expect, test } from 'bun:test'
import { loadSavedTokens, saveTokenToLocalStorage, setSavedTokenScope } from '../src/components/foundry/api/saved-tokens'

test('saved secrets cannot cross users, organizations or unauthenticated scopes', () => {
  const original = globalThis.window
  const values = new Map<string, string>()
  globalThis.window = { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } } as unknown as typeof window
  try {
    values.set('foundry_api_tokens', JSON.stringify([{ secret: 'legacy-unattributed' }]))
    setSavedTokenScope('alice', 'org-a')
    expect(loadSavedTokens()).toEqual([])
    saveTokenToLocalStorage({ id: 't1', name: 'test', prefix: 'test', secret: 'test-secret', createdAt: '' })
    setSavedTokenScope('bob', 'org-a')
    expect(loadSavedTokens()).toEqual([])
    setSavedTokenScope('alice', 'org-b')
    expect(loadSavedTokens()).toEqual([])
    setSavedTokenScope(null, null)
    expect(loadSavedTokens()).toEqual([])
    setSavedTokenScope('alice', 'org-a')
    expect(loadSavedTokens()[0].id).toBe('t1')
  } finally {
    globalThis.window = original
    setSavedTokenScope(null, null)
  }
})
