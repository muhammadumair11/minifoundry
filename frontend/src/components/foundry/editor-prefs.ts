'use client'

// Editor preferences (Task 12-d Settings) — persisted Monaco editor settings.
//
// Same storage pattern as focus-mode / sidebar rail: localStorage +
// useSyncExternalStore (hydration-safe — the server snapshot is the default
// so SSR and first paint agree) + a custom window event so every editor on
// the page re-renders in lockstep. Cross-tab sync rides the `storage` event.

import { useCallback, useSyncExternalStore } from 'react'

const FONT_SIZE_KEY = 'mf.editor.fontSize'
export const EDITOR_FONT_SIZES = [12, 13, 14] as const
export type EditorFontSize = (typeof EDITOR_FONT_SIZES)[number]
const DEFAULT_FONT_SIZE: EditorFontSize = 13

function subscribe(onStoreChange: () => void) {
  window.addEventListener('mf:editor-prefs', onStoreChange)
  window.addEventListener('storage', onStoreChange)
  return () => {
    window.removeEventListener('mf:editor-prefs', onStoreChange)
    window.removeEventListener('storage', onStoreChange)
  }
}

function readFontSize(): EditorFontSize {
  const raw = window.localStorage.getItem(FONT_SIZE_KEY)
  const n = raw === null ? NaN : Number(raw)
  return (EDITOR_FONT_SIZES as readonly number[]).includes(n) ? (n as EditorFontSize) : DEFAULT_FONT_SIZE
}

/** [fontSize, setFontSize] — persisted in localStorage('mf.editor.fontSize'). */
export function useEditorFontSize(): [EditorFontSize, (next: EditorFontSize) => void] {
  const fontSize = useSyncExternalStore(subscribe, readFontSize, () => DEFAULT_FONT_SIZE)
  const setFontSize = useCallback((next: EditorFontSize) => {
    try {
      window.localStorage.setItem(FONT_SIZE_KEY, String(next))
    } catch {
      /* private mode etc. — preference just won't persist */
    }
    window.dispatchEvent(new Event('mf:editor-prefs'))
  }, [])
  return [fontSize, setFontSize]
}
