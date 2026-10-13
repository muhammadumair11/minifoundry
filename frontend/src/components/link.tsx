// Drop-in replacement for `next/link` on top of TanStack Router.
// Keeps the legacy `href` prop (query strings and hashes included) so
// converted components stay minimal-diff:
//   import Link from '@/components/link'   // was: from 'next/link'
//   <Link href="/datasets?project=x" className="...">Datasets</Link>

import { Link as RouterLink } from '@tanstack/react-router'
import type { ComponentProps, ReactNode } from 'react'

type RouterLinkProps = ComponentProps<typeof RouterLink>

export interface LinkProps extends Omit<RouterLinkProps, 'to' | 'search' | 'hash' | 'children'> {
  href: string
  children?: ReactNode
}

function splitHref(href: string): { to: string; search: Record<string, string>; hash?: string } {
  const [beforeHash, hash] = href.split('#')
  const [to, qs] = beforeHash.split('?')
  const search: Record<string, string> = {}
  if (qs) {
    for (const [k, v] of new URLSearchParams(qs)) search[k] = v
  }
  return { to: to || '/', search, hash: hash || undefined }
}

export default function Link({ href, children, ...rest }: LinkProps) {
  const { to, search, hash } = splitHref(href)
  return (
    <RouterLink
      {...(rest as unknown as RouterLinkProps)}
      to={to as never}
      search={search as never}
      hash={hash as never}
    >
      {children}
    </RouterLink>
  )
}
