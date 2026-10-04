'use client'

import { useQuery } from '@tanstack/react-query'
import { CalendarClock } from 'lucide-react'
import { HealthStrip } from '@/components/foundry/orchestration/health-strip'
import { SchedulesCard } from '@/components/foundry/orchestration/schedules-card'
import { JobsCard } from '@/components/foundry/orchestration/jobs-card'
import { ExecutionQueueCard } from '@/components/foundry/orchestration/execution-queue-card'
import { FreshnessCard } from '@/components/foundry/orchestration/freshness-card'
import { RunTrendCard } from '@/components/foundry/orchestration/run-trend-card'
import { apiJson } from '@/lib/foundry-api'
import type { HealthResponse } from '@/lib/foundry-types'

export default function OrchestrationPage() {
  // Health powers the top strip + freshness card; refetches every 15s.
  const healthQuery = useQuery<HealthResponse>({
    queryKey: ['health'],
    queryFn: () => apiJson<HealthResponse>('/api/health'),
    refetchInterval: 15_000,
  })

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:py-8">
      {/* Header (compact Foundry pattern) */}
      <header className="mb-4 flex flex-wrap items-center gap-2">
        <CalendarClock className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="text-sm font-medium tracking-tight text-foreground">Orchestration</h1>
        <span className="text-xs text-muted-foreground">
          schedules · job history · platform health
        </span>
        <span className="font-mono text-[11px] text-muted-foreground/80">
          auto-refresh 15s
        </span>
      </header>

      {/* Health strip */}
      <HealthStrip health={healthQuery.data} loading={healthQuery.isLoading} />

      {/* Schedules + Data freshness */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SchedulesCard />
        <FreshnessCard
          datasets={healthQuery.data?.datasets ?? []}
          failingPipelines={healthQuery.data?.failingPipelines ?? []}
          loading={healthQuery.isLoading}
        />
      </div>

      {/* Run duration trend (Task 8-c) — read-only chart above the jobs list;
          shares the ['runs','all'] cache with JobsCard. */}
      <div className="mt-4">
        <RunTrendCard />
      </div>

      {/* Jobs — full width */}
      <div className="mt-4">
        <ExecutionQueueCard />
      </div>
      <div className="mt-4">
        <JobsCard />
      </div>
    </div>
  )
}
