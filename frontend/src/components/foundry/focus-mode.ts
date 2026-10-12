'use client'

// Focus mode (R11 "Focus Workspace") — a persisted, immersive state that
// hides the app chrome (sidebar, top bar, footer) so builder surfaces
// (transform workbench, pipeline canvas) get the whole viewport.
//
// Same storage pattern as the sidebar rail preference: localStorage +
// useSyncExternalStore (reads the stored value during hydration — no flash,
// no setState-in-effect) + a custom window event so all listeners on the
// page re-render in lockstep. Cross-tab sync rides the `storage` event.

import { useCallback, useSyncExternalStore } from 'react'

const FOCUS_KEY = 'mf.focus'

function subscribe(onStoreChange: () => void) {
  window.addEventListener('mf:focus', onStoreChange)
  window.addEventListener('storage', onStoreChange)
  return () => {
    window.removeEventListener('mf:focus', onStoreChange)
    window.removeEventListener('storage', onStoreChange)
  }
}

/** [focusEnabled, setFocusEnabled] — persisted in localStorage('mf.focus'). */
export function useFocusMode(): [boolean, (next: boolean) => void] {
  const focus = useSyncExternalStore(
    subscribe,
    () => window.localStorage.getItem(FOCUS_KEY) === '1',
    () => false, // server snapshot: chrome visible (SSR + first paint agree)
  )
  const setFocus = useCallback((next: boolean) => {
    try {
      window.localStorage.setItem(FOCUS_KEY, next ? '1' : '0')
    } catch {
      /* private mode etc. — preference just won't persist */
    }
    window.dispatchEvent(new Event('mf:focus'))
  }, [])
  return [focus, setFocus]
}
