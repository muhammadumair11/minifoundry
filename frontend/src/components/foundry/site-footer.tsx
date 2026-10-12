'use client'

import { useQuery } from '@tanstack/react-query'
import type { ApiStats } from '@/lib/foundry-types'

export function SiteFooter() {
  const { data } = useQuery<ApiStats>({
    queryKey: ['stats'],
    queryFn: async () => {
      const res = await fetch('/api/stats')
      if (!res.ok) throw new Error('Failed to load stats')
      return res.json()
    },
  })

  return (
    <footer className="mt-auto border-t border-border bg-background pb-[env(safe-area-inset-bottom)]">
      <div className="mx-auto flex flex-col items-start justify-between gap-1 px-4 py-3 text-[11px] text-muted-foreground sm:flex-row sm:items-center">
        <p>
          <span className="font-semibold text-foreground/80">MiniFoundry</span> · learning-scale
          Foundry clone
        </p>
        <p className="font-mono text-[11px]">
          datasets: <span className="text-foreground/70">{data?.datasets ?? '—'}</span> · rows:{' '}
          <span className="text-foreground/70">{data?.totalRows ?? '—'}</span> · runs:{' '}
          <span className="text-foreground/70">{data?.runs ?? '—'}</span>
        </p>
      </div>
    </footer>
  )
}
