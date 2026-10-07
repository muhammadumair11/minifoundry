// Drop-in replacements for the `next/navigation` hooks used across the app,
// implemented on TanStack Router. Converted files keep their call sites:
//   import { useRouter, usePathname, useParams, useSearchParams } from '@/lib/next-navigation'

import { useCallback, useMemo } from 'react'
import {
  useRouter as useTanstackRouter,
  useRouterState,
} from '@tanstack/react-router'

/** Current pathname (was `usePathname()`). */
export function usePathname(): string {
  return useRouterState({ select: (s) => s.location.pathname }) as unknown as string
}

/** Merged params of all active matches (was `useParams()`). */
export function useParams<T extends Record<string, string> = Record<string, string>>(): T {
  return useRouterState({
    select: (s) => {
      const merged: Record<string, string> = {}
      for (const match of s.matches) {
        Object.assign(merged, match.params as Record<string, string>)
      }
      return merged
    },
  }) as unknown as T
}

/** Split a legacy href ('/datasets?project=x#h') into TanStack parts. */
function splitHref(href: string): { to: string; search: Record<string, string>; hash?: string } {
  const [beforeHash, hash] = href.split('#')
  const [to, qs] = beforeHash.split('?')
  const search: Record<string, string> = {}
  if (qs) {
    for (const [k, v] of new URLSearchParams(qs)) search[k] = v
  }
  return { to: to || '/', search, hash: hash ? `#${hash}` : undefined }
}

/** Router object with the legacy push/replace/back surface (was `useRouter()`). */
export function useRouter() {
  const router = useTanstackRouter()
  return useMemo(
    () => ({
      push: (href: string) => {
        const { to, search, hash } = splitHref(href)
        void router.navigate({ to: to as never, search: search as never, hash: hash as never })
      },
      replace: (href: string, options?: { scroll?: boolean }) => {
        const { to, search, hash } = splitHref(href)
        void router.navigate({
          to: to as never,
          search: search as never,
          hash: hash as never,
          replace: true,
          resetScroll: options?.scroll !== false,
        })
      },
      back: () => {
        router.history.back()
      },
      forward: () => {
        router.history.forward()
      },
      refresh: () => {
        // Data lives in TanStack Query; a full reload matches next's refresh
        // semantics closely enough for the (rare) legacy call sites.
        window.location.reload()
      },
      prefetch: () => {
        // no-op: SPA bundles are preloaded by the router.
      },
    }),
    [router],
  )
}

/**
 * `useSearchParams()` replacement. Next.js returns the params object
 * DIRECTLY (not a [params, setter] tuple like React Router) — the legacy
 * pages only ever read `.get(...)`, so that is exactly what this returns.
 */
export function useSearchParams(): URLSearchParams {
  const searchStr = useRouterState({ select: (s) => s.location.searchStr })
  return useMemo(() => new URLSearchParams(searchStr ?? ''), [searchStr])
}
