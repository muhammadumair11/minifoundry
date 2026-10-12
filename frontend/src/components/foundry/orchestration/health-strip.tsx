'use client'

import { Activity, Gauge, ListX, Timer } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import type { HealthResponse } from '@/lib/foundry-types'

function successRateTone(rate: number): string {
  if (rate >= 95) return 'text-emerald-600 dark:text-emerald-400'
  if (rate >= 70) return 'text-amber-600 dark:text-amber-400'
  return 'text-rose-600 dark:text-rose-400'
}

function StatCard({
  label,
  icon: Icon,
  children,
  ariaLabel,
}: {
  label: string
  icon: React.ComponentType<{ className?: string }>
  children: React.ReactNode
  ariaLabel?: string
}) {
  return (
    <Card aria-label={ariaLabel ?? label}>
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
          <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        </div>
        <div className="mt-2">{children}</div>
      </CardContent>
    </Card>
  )
}

export function HealthStrip({
  health,
  loading,
}: {
  health: HealthResponse | undefined
  loading: boolean
}) {
  return (
    <section
      aria-label="Platform health"
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
    >
      {/* Success rate */}
      <StatCard label="Success Rate" icon={Gauge} ariaLabel="Success rate">
        {loading || !health ? (
          <Skeleton className="h-9 w-24" />
        ) : (
          <p
            className={`font-mono text-3xl font-semibold tabular-nums ${successRateTone(health.successRatePct)}`}
          >
            {health.successRatePct}%
          </p>
        )}
      </StatCard>

      {/* Average duration */}
      <StatCard label="Avg Duration" icon={Timer}>
        {loading || !health ? (
          <Skeleton className="h-9 w-24" />
        ) : (
          <p className="font-mono text-3xl font-semibold tabular-nums text-foreground">
            {health.avgDurationMs === null ? '—' : `${health.avgDurationMs}ms`}
          </p>
        )}
      </StatCard>

      {/* Runs (7d) */}
      <StatCard label="Runs (7d)" icon={Activity}>
        {loading || !health ? (
          <Skeleton className="h-9 w-20" />
        ) : (
          <div className="flex items-baseline gap-2">
            <p className="font-mono text-3xl font-semibold tabular-nums text-foreground">
              {health.runs7d}
            </p>
            <p
              className={`font-mono text-[11px] ${health.failed7d > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-muted-foreground/80'}`}
            >
              {health.failed7d} failed
            </p>
          </div>
        )}
      </StatCard>

      {/* Failing pipelines */}
      <StatCard label="Failing Pipelines" icon={ListX}>
        {loading || !health ? (
          <Skeleton className="h-9 w-16" />
        ) : (
          <div className="flex items-center gap-2">
            {health.failingPipelines.length > 0 && (
              <span
                className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-rose-500 dark:bg-rose-400"
                aria-hidden
              />
            )}
            <p
              className={`font-mono text-3xl font-semibold tabular-nums ${
                health.failingPipelines.length > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-foreground'
              }`}
            >
              {health.failingPipelines.length}
            </p>
            {health.failingPipelines.length > 0 && (
              <a
                href="#failing-pipelines"
                className="self-center font-mono text-[11px] text-muted-foreground underline decoration-border underline-offset-2 transition-colors hover:text-rose-600 dark:hover:text-rose-400"
              >
                view
              </a>
            )}
          </div>
        )}
      </StatCard>
    </section>
  )
}
