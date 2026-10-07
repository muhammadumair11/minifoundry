'use client'

import { useMemo, useState } from 'react'
import Link from '@/components/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { GitBranch, RotateCcw, ScanSearch, Workflow } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { StatusBadge } from '@/components/foundry/status-badge'
import { VersionChip } from '@/components/foundry/version-chip'
import { RunDetailDialog } from '@/components/foundry/orchestration/run-detail-dialog'
import { apiJson } from '@/lib/foundry-api'
import { formatDuration, formatRelative, shortId } from '@/lib/foundry-types'
import type { OrchestrationRun, RunResponse } from '@/lib/foundry-types'

type StatusFilter = 'all' | 'success' | 'failed' | 'running'
type TriggerFilter = 'all' | 'manual' | 'schedule' | 'upstream' | 'replay'

// R14 (additive): runs now carry trigger + attempt (keep the shared type local).
type OrchestrationRunWithTrigger = OrchestrationRun & { trigger?: string; attempt?: number }
type RunsListWithTrigger = { runs: OrchestrationRunWithTrigger[] }

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'success', label: 'Success' },
  { value: 'failed', label: 'Failed' },
  { value: 'running', label: 'Running' },
]

const TRIGGER_FILTERS: { value: TriggerFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'manual', label: 'Manual' },
  { value: 'schedule', label: 'Schedule' },
  { value: 'upstream', label: 'Upstream' },
  { value: 'replay', label: 'Replay' },
]

/** R14: uppercase trigger chip colors — manual=zinc, schedule=violet, upstream=teal, retry=amber; P1: replay=cyan. */
const TRIGGER_CHIP: Record<string, string> = {
  manual: 'border-zinc-500/30 bg-zinc-500/10 text-zinc-600 dark:text-zinc-400',
  schedule: 'border-violet-600/30 bg-violet-500/10 text-violet-600 dark:text-violet-400',
  upstream: 'border-teal-600/30 bg-teal-500/10 text-teal-600 dark:text-teal-400',
  retry: 'border-amber-600/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  replay: 'border-cyan-600/30 bg-cyan-500/10 text-cyan-600 dark:text-cyan-400',
}

function TriggerBadge({ run }: { run: OrchestrationRunWithTrigger }) {
  const trigger = run.trigger ?? 'manual'
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <span
        className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
          TRIGGER_CHIP[trigger] ?? TRIGGER_CHIP.manual
        }`}
      >
        {trigger}
      </span>
      {(run.attempt ?? 1) > 1 && (
        <span className="font-mono text-[10px] text-muted-foreground" title={`Attempt ${run.attempt}`}>
          ×{run.attempt}
        </span>
      )}
    </span>
  )
}

export function JobsCard() {
  const queryClient = useQueryClient()
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [triggerFilter, setTriggerFilter] = useState<TriggerFilter>('all')
  // Phase 1: run-detail dialog (manifest + replay) opened from any row.
  const [detailRunId, setDetailRunId] = useState<string | null>(null)

  const runsQuery = useQuery<RunsListWithTrigger>({
    queryKey: ['runs', statusFilter],
    queryFn: () =>
      apiJson<RunsListWithTrigger>(
        statusFilter === 'all' ? '/api/runs' : `/api/runs?status=${statusFilter}`,
      ),
  })
  // R14: trigger filter is client-side (the API filters by status only).
  const runs = useMemo(() => {
    const all = runsQuery.data?.runs ?? []
    if (triggerFilter === 'all') return all
    // retry runs surface under their sibling upstream/schedule filter too
    if (triggerFilter === 'upstream') {
      return all.filter((r) => r.trigger === 'upstream' || r.trigger === 'retry')
    }
    return all.filter((r) => (r.trigger ?? 'manual') === triggerFilter)
  }, [runsQuery.data, triggerFilter])

  const retryMutation = useMutation({
    mutationFn: (runId: string) =>
      apiJson<RunResponse>(`/api/runs/${runId}/retry`, { method: 'POST' }),
    onSuccess: (res) => {
      toast.success('Retry started', {
        description: `New run ${shortId(res.run.id, 8)} queued.`,
      })
      void queryClient.invalidateQueries({ queryKey: ['runs'] })
      void queryClient.invalidateQueries({ queryKey: ['health'] })
      void queryClient.invalidateQueries({ queryKey: ['stats'] })
      void queryClient.invalidateQueries({ queryKey: ['pipeline'] })
    },
    onError: (err: Error) =>
      toast.error('Retry failed', { description: err.message }),
  })

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 border-b border-border p-4">
        <div className="flex items-center gap-2">
          <CardTitle className="text-sm font-semibold text-foreground">Jobs</CardTitle>
          {!runsQuery.isLoading && (
            <span className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {runs.length}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* R14: trigger filter chips (client-side) */}
          <Tabs
            value={triggerFilter}
            onValueChange={(v) => setTriggerFilter(v as TriggerFilter)}
            aria-label="Filter runs by trigger"
          >
            <TabsList className="h-8">
              {TRIGGER_FILTERS.map((f) => (
                <TabsTrigger
                  key={f.value}
                  value={f.value}
                  className="h-7 px-2 text-[11px]"
                >
                  {f.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <Tabs
            value={statusFilter}
            onValueChange={(v) => setStatusFilter(v as StatusFilter)}
            aria-label="Filter runs by status"
          >
            <TabsList className="h-8">
              {STATUS_FILTERS.map((f) => (
                <TabsTrigger
                  key={f.value}
                  value={f.value}
                  className="h-7 gap-1.5 px-2.5 text-xs"
                >
                  {f.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {runsQuery.isLoading ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : runsQuery.isError ? (
          <p className="p-6 text-center text-sm text-rose-600 dark:text-rose-400">
            {runsQuery.error instanceof Error
              ? runsQuery.error.message
              : 'Failed to load runs.'}
          </p>
        ) : runs.length === 0 ? (
          <div className="flex flex-col items-center gap-3 p-8 text-center">
            <Workflow className="h-8 w-8 text-muted-foreground" aria-hidden />
            <p className="text-sm text-muted-foreground">
              {statusFilter === 'all'
                ? 'No runs yet — open a pipeline and press Run.'
                : `No ${statusFilter} runs in the last 100.`}
            </p>
            <Button
              asChild
              variant="outline"
              size="sm"
              className="h-8 text-xs"
            >
              <Link href="/pipelines">
                <GitBranch className="h-3.5 w-3.5" aria-hidden />
                Go to pipelines
              </Link>
            </Button>
          </div>
        ) : (
          <div className="foundry-scroll max-h-96 overflow-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead className="h-9 px-4 text-xs text-muted-foreground">Run</TableHead>
                  <TableHead className="h-9 px-3 text-xs text-muted-foreground">Pipeline</TableHead>
                  <TableHead className="h-9 px-3 text-xs text-muted-foreground">Status</TableHead>
                  <TableHead className="h-9 px-3 text-xs text-muted-foreground">
                    Trigger<span className="sr-only"> — what caused this run</span>
                  </TableHead>
                  <TableHead className="h-9 px-3 text-xs text-muted-foreground">
                    Version<span className="sr-only"> — pipeline version executed</span>
                  </TableHead>
                  <TableHead className="h-9 px-3 text-xs text-muted-foreground">Started</TableHead>
                  <TableHead className="h-9 px-3 text-right text-xs text-muted-foreground">
                    Duration
                  </TableHead>
                  <TableHead className="h-9 w-12 px-2 text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run) => (
                  <TableRow key={run.id} className="border-border/70">
                    <TableCell
                      className="px-4 py-2 font-mono text-xs text-muted-foreground"
                      title={run.id}
                    >
                      {shortId(run.id, 8)}
                    </TableCell>
                    <TableCell className="max-w-[220px] px-3 py-2">
                      <Link
                        href={`/pipelines/${run.pipelineId}`}
                        className="block truncate text-sm text-foreground underline-offset-2 hover:underline"
                        title={`Open builder — ${run.pipelineName}`}
                      >
                        {run.pipelineName}
                      </Link>
                    </TableCell>
                    <TableCell className="px-3 py-2">
                      <StatusBadge status={run.status} />
                    </TableCell>
                    <TableCell className="px-3 py-2">
                      <TriggerBadge run={run} />
                    </TableCell>
                    <TableCell className="px-3 py-2">
                      {/* M3.1: version the run pinned; pre-versioning rows stay
                          empty (renders nothing, keeps old rows clean). */}
                      {run.versionNumber != null && (
                        <VersionChip
                          versionNumber={run.versionNumber}
                          title="Pipeline version this run executed"
                        />
                      )}
                    </TableCell>
                    <TableCell
                      className="px-3 py-2 font-mono text-xs text-muted-foreground"
                      title={run.startedAt}
                    >
                      {formatRelative(run.startedAt)}
                    </TableCell>
                    <TableCell className="px-3 py-2 text-right font-mono text-xs text-foreground">
                      {run.status === 'running' ? '—' : formatDuration(run.startedAt, run.finishedAt)}
                    </TableCell>
                    <TableCell className="px-2 py-2 text-right">
                      <div className="flex items-center justify-end gap-0.5">
                        {/* Phase 1: build record — manifest, failure cause, replay */}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDetailRunId(run.id)}
                          className="h-7 w-7 p-0 text-muted-foreground hover:bg-accent hover:text-foreground"
                          aria-label={`Open build record for run ${shortId(run.id, 8)} of ${run.pipelineName}`}
                          title="Build record — inputs, outputs, manifest, replay"
                        >
                          <ScanSearch className="h-3.5 w-3.5" aria-hidden />
                        </Button>
                        {run.status === 'failed' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => retryMutation.mutate(run.id)}
                            disabled={retryMutation.isPending && retryMutation.variables === run.id}
                            className="h-7 w-7 p-0 text-muted-foreground hover:bg-accent hover:text-foreground"
                            aria-label={`Retry run ${shortId(run.id, 8)} of ${run.pipelineName}`}
                            title="Retry run (latest inputs)"
                          >
                            <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <div className="border-t border-border px-4 py-2 font-mono text-[10px] text-muted-foreground/80">
          last 100 runs
        </div>
      </CardContent>
      {/* Phase 1: run detail — build manifest + replay from recorded inputs */}
      <RunDetailDialog runId={detailRunId} onClose={() => setDetailRunId(null)} />
    </Card>
  )
}
