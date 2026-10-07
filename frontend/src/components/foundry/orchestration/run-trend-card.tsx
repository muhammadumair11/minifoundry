'use client'

// M10.1 observability (Task 8-c) — "Run duration trend" on /orchestration.
// Pure frontend: reuses the EXISTING ['runs','all'] cache (GET /api/runs —
// last 100, desc) and draws durationMs oldest → newest with status-coded
// dots (success emerald / failed rose / running amber ring). Read-only, so
// it renders for every role; the page's other cards are untouched.

import { useQuery } from '@tanstack/react-query'
import { Timer, Workflow } from 'lucide-react'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { TooltipProps } from 'recharts'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  AXIS_TICK,
  ChartTooltipShell,
  useChartAnimationDuration,
  useChartTheme,
} from '@/components/foundry/charts/chart-kit'
import { apiJson } from '@/lib/foundry-api'
import { formatRelative } from '@/lib/foundry-types'
import type { RunsListResponse } from '@/lib/foundry-types'

// One plotted point — a run with its sequence index (oldest = 1).
type TrendPoint = {
  seq: number
  pipelineName: string
  status: string
  startedAt: string
  durationMs: number | null
}

/** "37ms" / "1.2s" — chart-scale duration label (durations here are small). */
function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export function RunTrendCard() {
  // Same query key + fn as JobsCard's "All" tab → one shared cache entry.
  const runsQuery = useQuery<RunsListResponse>({
    queryKey: ['runs', 'all'],
    queryFn: () => apiJson<RunsListResponse>('/api/runs'),
  })
  const runs = runsQuery.data?.runs ?? []
  const animationDuration = useChartAnimationDuration()
  const theme = useChartTheme()

  // API returns newest → oldest; the trend reads oldest → newest.
  const data: TrendPoint[] = [...runs]
    .reverse()
    .map((r, i) => ({
      seq: i + 1,
      pipelineName: r.pipelineName,
      status: r.status,
      startedAt: r.startedAt,
      durationMs: r.durationMs,
    }))

  // Header stats — over successful runs only (durations are known there).
  const okDurations = runs
    .filter((r) => r.status === 'success' && r.durationMs != null)
    .map((r) => r.durationMs as number)
  const avg =
    okDurations.length > 0
      ? Math.round(okDurations.reduce((a, b) => a + b, 0) / okDurations.length)
      : null
  const fastest = okDurations.length > 0 ? Math.min(...okDurations) : null
  const slowest = okDurations.length > 0 ? Math.max(...okDurations) : null

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b p-4">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <Timer className="h-4 w-4 text-muted-foreground" aria-hidden />
            Run duration trend
          </CardTitle>
          <CardDescription className="mt-1 text-xs text-muted-foreground">
            Duration of the last 100 pipeline runs, oldest → newest.
          </CardDescription>
        </div>

        {/* Thin mono stats — avg / fastest / slowest successful duration */}
        <dl className="flex flex-wrap items-center gap-1.5" aria-label="Duration stats">
          <StatChip label="avg" value={avg != null ? fmtMs(avg) : '—'} valueClass="text-emerald-600 dark:text-emerald-400" />
          <StatChip label="fastest" value={fastest != null ? fmtMs(fastest) : '—'} />
          <StatChip label="slowest" value={slowest != null ? fmtMs(slowest) : '—'} />
        </dl>
      </CardHeader>

      <CardContent className="p-4">
        {runsQuery.isLoading ? (
          <Skeleton className="h-[220px] w-full" aria-hidden />
        ) : runsQuery.isError ? (
          <p className="py-8 text-center text-sm text-rose-600 dark:text-rose-400">
            {runsQuery.error instanceof Error ? runsQuery.error.message : 'Failed to load runs.'}
          </p>
        ) : data.length < 2 ? (
          // Friendly guard — a trend needs at least two points.
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <Workflow className="h-7 w-7 text-muted-foreground/70" aria-hidden />
            <p className="text-sm font-medium text-muted-foreground">
              Not enough runs to draw a trend.
            </p>
            <p className="text-xs text-muted-foreground/80">
              Run a pipeline a couple of times — durations will chart here.
            </p>
          </div>
        ) : (
          <>
            <div className="min-w-0">
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke={theme.grid} strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="seq"
                    tick={{ ...AXIS_TICK, fill: theme.tick }}
                    tickLine={false}
                    axisLine={{ stroke: theme.grid }}
                    tickFormatter={(v: number) => String(v)}
                    interval="preserveStartEnd"
                    minTickGap={24}
                  />
                  <YAxis
                    width={34}
                    tick={{ ...AXIS_TICK, fill: theme.tick }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v: number) => fmtMs(v)}
                  />
                  <Tooltip
                    content={<TrendTooltip />}
                    cursor={{ stroke: theme.tick, strokeDasharray: '3 3' }}
                  />
                  <Line
                    type="monotone"
                    dataKey="durationMs"
                    stroke={theme.series}
                    strokeWidth={2}
                    // running runs have no duration yet → gaps, not zeros
                    connectNulls={false}
                    dot={<RunDot />}
                    activeDot={false}
                    animationDuration={animationDuration}
                    isAnimationActive={animationDuration > 0}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] text-muted-foreground/80">
              <span>run #1 = oldest · x = sequence</span>
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: theme.series }}
                  aria-hidden
                />{' '}
                success
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: theme.error }}
                  aria-hidden
                />{' '}
                failed
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="h-2 w-2 rounded-full border"
                  style={{ borderColor: theme.warn }}
                  aria-hidden
                />{' '}
                running
              </span>
            </p>
          </>
        )}
      </CardContent>
    </Card>
  )
}

/** Status-coded dot: success = series, failed = error, running = warn ring. */
function RunDot(props: { cx?: number; cy?: number; payload?: TrendPoint }) {
  const theme = useChartTheme()
  const { cx, cy, payload } = props
  if (cx == null || cy == null || !payload) return null
  const stroke = { stroke: theme.tooltipBg, strokeWidth: 1 }
  if (payload.status === 'failed') {
    return <circle cx={cx} cy={cy} r={3.5} fill={theme.error} {...stroke} />
  }
  if (payload.status === 'running') {
    return <circle cx={cx} cy={cy} r={4} fill="none" stroke={theme.warn} strokeWidth={1.5} />
  }
  return <circle cx={cx} cy={cy} r={2.5} fill={theme.series} {...stroke} />
}

/** Themed mono tooltip — pipeline, status, duration, relative start. */
function TrendTooltip({ active, payload }: TooltipProps<number, string>) {
  if (!active || !payload || payload.length === 0) return null
  const point = payload[0].payload as TrendPoint
  const statusClass =
    point.status === 'failed'
      ? 'text-rose-600 dark:text-rose-400'
      : point.status === 'running'
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-emerald-600 dark:text-emerald-400'
  return (
    <ChartTooltipShell>
      <p className="max-w-48 truncate text-xs font-semibold" title={point.pipelineName}>
        {point.pipelineName}
      </p>
      <p className="mt-1 font-mono text-[11px]">
        <span className={statusClass}>{point.status}</span>
        <span className="text-muted-foreground">
          {' '}
          ·{' '}
          {point.durationMs != null ? (
            <span className="text-foreground/80">{point.durationMs}ms</span>
          ) : (
            'no duration yet'
          )}
        </span>
      </p>
      <p className="font-mono text-[11px] text-muted-foreground">
        started {formatRelative(point.startedAt)}
      </p>
    </ChartTooltipShell>
  )
}

function StatChip({
  label,
  value,
  valueClass,
}: {
  label: string
  value: string
  valueClass?: string
}) {
  return (
    <div className="flex items-baseline gap-1.5 rounded-md border border-border bg-muted/50 px-2 py-1 font-mono text-[11px]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={valueClass ?? 'font-semibold tabular-nums text-foreground'}>{value}</dd>
    </div>
  )
}
