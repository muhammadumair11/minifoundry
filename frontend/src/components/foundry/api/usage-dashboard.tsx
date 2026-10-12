'use client'

// M10.1 observability (Task 8-c) — "API usage — last 24h" card on /api-tokens,
// driven by GET /api/tokens/usage (admin-only, 8-b contract in agent-ctx).
// First Recharts usage in the app: emerald request area with a rose error
// overlay over 24 zero-filled UTC hour buckets, stat pills, top templated
// routes, per-token table and the recent-errors tail. Admin actions: seed
// demo traffic (400 valve → info toast) and clear logs (confirm dialog).

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Activity,
  CheckCircle2,
  FlaskConical,
  Loader2,
  ShieldAlert,
  Trash2,
} from 'lucide-react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { TooltipProps } from 'recharts'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { GatedButton } from '@/components/foundry/governance/gated-button'
import {
  AXIS_TICK,
  ChartTooltipShell,
  useChartAnimationDuration,
  useChartTheme,
} from '@/components/foundry/charts/chart-kit'
import { apiJson, apiSend, toastApiError } from '@/lib/foundry-api'
import { formatRelative } from '@/lib/foundry-types'
import type {
  ApiUsageClearResponse,
  ApiUsageResponse,
  ApiUsageSeedResponse,
} from '@/lib/foundry-types'

// byHour datum with a ready-to-render HH:00 label (hourIso '2026-10-01T21:00').
type HourPoint = { label: string; count: number; errors: number }

export function UsageDashboard({ isAdmin }: { isAdmin: boolean }) {
  const queryClient = useQueryClient()
  const [clearOpen, setClearOpen] = useState(false)
  const animationDuration = useChartAnimationDuration()
  const theme = useChartTheme()

  const usageQuery = useQuery<ApiUsageResponse>({
    queryKey: ['api-usage'],
    queryFn: () => apiJson<ApiUsageResponse>('/api/tokens/usage'),
    enabled: isAdmin,
    retry: false,
    refetchInterval: 30_000,
  })
  const usage = usageQuery.data

  const seedMutation = useMutation({
    mutationFn: () => apiSend<ApiUsageSeedResponse>('/api/tokens/usage/seed', 'POST'),
    onSuccess: (res) => {
      toast.success(`Seeded ${res.seeded} synthetic requests`, {
        description: 'Synthetic 24h traffic — clear it any time below.',
      })
      void queryClient.invalidateQueries({ queryKey: ['api-usage'] })
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : 'Request failed'
      // The seeder's idempotence valve (8-b) answers 400 with guidance —
      // surface those as info toasts, everything else as a hard error.
      if (message.includes('usage data already exists') || message.includes('no active API token')) {
        toast.info(message)
      } else {
        toastApiError(err, 'Could not seed demo traffic')
      }
    },
  })

  const clearMutation = useMutation({
    mutationFn: () => apiSend<ApiUsageClearResponse>('/api/tokens/usage', 'DELETE'),
    onSuccess: (res) => {
      toast.success(`Cleared ${res.pruned} log rows`, {
        description: 'Tokens are unaffected.',
      })
      setClearOpen(false)
      void queryClient.invalidateQueries({ queryKey: ['api-usage'] })
    },
    onError: (err) => toastApiError(err, 'Could not clear usage data'),
  })

  // GET /api/tokens/usage is admin-only (8-b): if a stale role slips through,
  // render the same "admin-only" note pattern as the token list above.
  if (usageQuery.isError) {
    const message =
      usageQuery.error instanceof Error ? usageQuery.error.message : 'Failed to load usage.'
    return (
      <Card className="mb-6">
        <CardContent className="p-8">
          {message.includes('requires admin') ? (
            <div className="flex flex-col items-center gap-1.5 text-center">
              <ShieldAlert className="h-6 w-6 text-muted-foreground/70" aria-hidden />
              <p className="text-sm font-medium text-muted-foreground">
                The usage dashboard is admin-only.
              </p>
              <p className="text-xs text-muted-foreground/80">
                Switch to admin in the header to see 24h API traffic analytics.
              </p>
            </div>
          ) : (
            <p className="text-center text-sm text-rose-600 dark:text-rose-400">{message}</p>
          )}
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="mb-6">
      {/* Header: title + window badge left, stat pills right (wrap on mobile) */}
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-x-4 gap-y-3 border-b p-4 sm:p-5">
        <div className="min-w-0">
          <CardTitle className="flex flex-wrap items-center gap-2 text-sm font-semibold">
            <Activity className="h-4 w-4 text-muted-foreground" aria-hidden />
            API usage
            <span className="rounded border border-border bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] font-normal text-muted-foreground">
              last 24h
            </span>
          </CardTitle>
          <CardDescription className="mt-1 text-xs text-muted-foreground">
            Every authenticated <span className="font-mono text-foreground/70">/api/foundry/v1</span>{' '}
            request is logged with its templated route and duration.
          </CardDescription>
        </div>

        <dl className="flex flex-wrap items-center gap-1.5" aria-label="Usage totals">
          <StatPill label="total" value={usage ? usage.total.toLocaleString() : '·'} />
          <StatPill
            label="ok"
            value={usage ? usage.ok.toLocaleString() : '·'}
            valueClass="text-emerald-600 dark:text-emerald-400"
          />
          <StatPill
            label="errors"
            value={usage ? usage.errors.toLocaleString() : '·'}
            valueClass={usage && usage.errors > 0 ? 'text-rose-600 dark:text-rose-400' : undefined}
          />
          <StatPill
            label="limited"
            value={usage ? usage.limited.toLocaleString() : '·'}
            valueClass={usage && usage.limited > 0 ? 'text-amber-600 dark:text-amber-400' : undefined}
            title="HTTP 429 — rate limited"
          />
          <StatPill
            label="avg"
            value={usage ? (usage.avgDurationMs != null ? `${usage.avgDurationMs}ms` : '—') : '·'}
            title="Mean request duration"
          />
        </dl>
      </CardHeader>

      <CardContent className="p-4 sm:p-5">
        {usageQuery.isLoading || !usage ? (
          <div className="space-y-4">
            <Skeleton className="h-[220px] w-full" />
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Skeleton className="h-28 w-full" />
              <Skeleton className="h-28 w-full" />
            </div>
          </div>
        ) : (
          <>
            <UsageChart byHour={usage.byHour} animationDuration={animationDuration} />

            {/* Top routes + by-token breakdown */}
            <div className="mt-5 grid grid-cols-1 gap-6 lg:grid-cols-2">
              <TopRoutes routes={usage.topRoutes} />
              <ByTokenTable tokens={usage.byToken} />
            </div>

            {/* Recent errors tail */}
            <RecentErrors errors={usage.recentErrors} />
          </>
        )}

        {/* Admin actions — footer row, right-aligned */}
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t pt-4">
          <p className="min-w-0 font-mono text-[11px] text-muted-foreground/80">
            logs self-prune after 48h · seeded traffic is synthetic
          </p>
          {/* w-full on mobile: the two buttons wrap onto their own row */}
          <div className="flex w-full flex-wrap gap-2 sm:w-auto">
            <GatedButton
              allowed={isAdmin}
              reason="requires admin role"
              variant="outline"
              onClick={() => seedMutation.mutate()}
              disabled={seedMutation.isPending}
            >
              {seedMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <FlaskConical className="h-4 w-4" aria-hidden />
              )}
              Generate demo traffic
            </GatedButton>
            <GatedButton
              allowed={isAdmin}
              reason="requires admin role"
              variant="outline"
              onClick={() => setClearOpen(true)}
              disabled={clearMutation.isPending}
              className="text-muted-foreground hover:bg-rose-500/10 hover:text-rose-600 dark:hover:text-rose-400"
            >
              {clearMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Trash2 className="h-4 w-4" aria-hidden />
              )}
              Clear usage data
            </GatedButton>
          </div>
        </div>
      </CardContent>

      {/* Clear confirm */}
      <AlertDialog
        open={clearOpen}
        onOpenChange={(open) => {
          if (!clearMutation.isPending) setClearOpen(open)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base">
              Clear all API usage data?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Removes all API request logs. Tokens are unaffected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => clearMutation.mutate()}
              disabled={clearMutation.isPending}
              className="bg-rose-600 text-white hover:bg-rose-500 dark:bg-rose-500 dark:text-zinc-950 dark:hover:bg-rose-400"
            >
              {clearMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Trash2 className="h-4 w-4" aria-hidden />
              )}
              Clear logs
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}

// ── Chart (requests area + errors overlay) ───────────────────────────

function UsageChart({
  byHour,
  animationDuration,
}: {
  byHour: ApiUsageResponse['byHour']
  animationDuration: number
}) {
  const data: HourPoint[] = useMemo(
    () => byHour.map((b) => ({ label: b.hourIso.slice(11, 16), count: b.count, errors: b.errors })),
    [byHour],
  )
  const hasTraffic = data.some((d) => d.count > 0 || d.errors > 0)
  const theme = useChartTheme()

  return (
    <div className="relative min-w-0">
      {/* height ~220, full-width on every breakpoint */}
      <ResponsiveContainer width="100%" height={220}>
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="usageOkGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={theme.series} stopOpacity={0.4} />
              <stop offset="100%" stopColor={theme.series} stopOpacity={0} />
            </linearGradient>
            <linearGradient id="usageErrGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={theme.error} stopOpacity={0.18} />
              <stop offset="100%" stopColor={theme.error} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={theme.grid} strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ ...AXIS_TICK, fill: theme.tick }}
            tickLine={false}
            axisLine={{ stroke: theme.grid }}
            interval={2}
            minTickGap={0}
          />
          <YAxis
            allowDecimals={false}
            width={28}
            tick={{ ...AXIS_TICK, fill: theme.tick }}
            tickLine={false}
            axisLine={false}
          />
          <Tooltip
            content={<UsageTooltip />}
            cursor={{ stroke: theme.tick, strokeDasharray: '3 3' }}
          />
          <Area
            type="monotone"
            dataKey="count"
            name="requests"
            stroke={theme.series}
            strokeWidth={2}
            fill="url(#usageOkGradient)"
            dot={false}
            activeDot={{ r: 3, fill: theme.series, stroke: theme.tooltipBg }}
            animationDuration={animationDuration}
          />
          <Area
            type="monotone"
            dataKey="errors"
            name="errors"
            stroke={theme.error}
            strokeOpacity={0.6}
            strokeWidth={1.5}
            fill="url(#usageErrGradient)"
            dot={false}
            activeDot={{ r: 3, fill: theme.error, stroke: theme.tooltipBg }}
            animationDuration={animationDuration}
          />
        </AreaChart>
      </ResponsiveContainer>

      {/* All-zero window: flat line still renders; hint floats above it */}
      {!hasTraffic && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="rounded-md border border-border bg-background/90 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
            No traffic — Generate demo traffic below
          </p>
        </div>
      )}

      {/* Non-interactive legend chips */}
      <div className="mt-2 flex flex-wrap items-center gap-4 font-mono text-[10px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span
            className="h-1.5 w-4 rounded-full opacity-80"
            style={{ background: theme.series }}
            aria-hidden
          />
          requests/hour
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="h-1.5 w-4 rounded-full opacity-60"
            style={{ background: theme.error }}
            aria-hidden
          />
          errors/hour
        </span>
        <span className="ml-auto hidden sm:inline">UTC hour buckets · HH:00</span>
      </div>
    </div>
  )
}

/** Themed mono tooltip — "HH:00 — N req · E err". */
function UsageTooltip({ active, payload }: TooltipProps<number, string>) {
  if (!active || !payload || payload.length === 0) return null
  const point = payload[0].payload as HourPoint
  return (
    <ChartTooltipShell>
      <p className="font-mono text-xs">
        {point.label} — <span className="text-emerald-600 dark:text-emerald-400">{point.count} req</span> ·{' '}
        <span className={point.errors > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-muted-foreground'}>
          {point.errors} err
        </span>
      </p>
    </ChartTooltipShell>
  )
}

// ── Header stat pill ─────────────────────────────────────────────────

function StatPill({
  label,
  value,
  valueClass,
  title,
}: {
  label: string
  value: string
  valueClass?: string
  title?: string
}) {
  return (
    <div
      className="flex items-baseline gap-1.5 rounded-md border border-border bg-muted/50 px-2 py-1 font-mono text-[11px]"
      title={title}
    >
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={valueClass ?? 'text-foreground font-semibold tabular-nums'}>
        {value}
      </dd>
    </div>
  )
}

// ── Top templated routes ─────────────────────────────────────────────

function TopRoutes({ routes }: { routes: ApiUsageResponse['topRoutes'] }) {
  const max = routes.length > 0 ? Math.max(...routes.map((r) => r.count)) : 0
  return (
    <section aria-label="Top routes">
      <h3 className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/80">
        Top routes · templated
      </h3>
      {routes.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground/80">No requests in the window.</p>
      ) : (
        <ul className="mt-2.5 space-y-2">
          {routes.map((r) => {
            const pct = max > 0 ? (r.count / max) * 100 : 0
            return (
              <li key={r.route} className="flex items-center gap-2 font-mono text-xs">
                <span className="w-36 shrink-0 truncate text-foreground/80" title={r.route}>
                  {r.route}
                </span>
                <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                  <span
                    className="block h-full rounded-full bg-emerald-600/70 dark:bg-emerald-400/70"
                    style={{ width: `${pct}%` }}
                    aria-hidden
                  />
                </span>
                <span className="w-8 shrink-0 text-right tabular-nums text-muted-foreground">
                  {r.count}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

// ── By-token breakdown (richer 7-c bars; survives token deletion) ────

function ByTokenTable({ tokens }: { tokens: ApiUsageResponse['byToken'] }) {
  const max = tokens.length > 0 ? Math.max(...tokens.map((t) => t.count)) : 0
  return (
    <section aria-label="Usage by token">
      <h3 className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/80">
        By token · {tokens.length}
      </h3>
      {tokens.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground/80">No token traffic in the window.</p>
      ) : (
        <ul className="foundry-scroll mt-2.5 max-h-48 space-y-3 overflow-y-auto pr-1">
          {tokens.map((t) => {
            const deleted = t.prefix === null
            const pct = max > 0 ? Math.max((t.count / max) * 100, t.count > 0 ? 2 : 0) : 0
            return (
              <li key={t.tokenId}>
                <div className="flex items-center gap-2">
                  {/* avatar dot — zinc for deleted tokens */}
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${deleted ? 'bg-zinc-500' : 'bg-emerald-600 dark:bg-emerald-400'}`}
                    aria-hidden
                  />
                  <span
                    className={`min-w-0 flex-1 truncate text-xs font-medium ${deleted ? 'text-muted-foreground italic' : 'text-foreground'}`}
                    title={t.name}
                  >
                    {t.name}
                  </span>
                  <span
                    className="shrink-0 rounded border border-border bg-muted/60 px-1 py-0.5 font-mono text-[10px] text-muted-foreground"
                    title={t.prefix ? `Secret prefix ${t.prefix}…` : 'Token deleted'}
                  >
                    {t.prefix ?? '—'}
                  </span>
                  <span className="w-10 shrink-0 text-right font-mono text-xs tabular-nums text-foreground">
                    {t.count.toLocaleString()}
                  </span>
                </div>
                <div className="mt-1.5 flex items-center gap-2 pl-4">
                  <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                    <span
                      className={`block h-full rounded-full ${deleted ? 'bg-muted-foreground/40' : 'bg-emerald-600/80 dark:bg-emerald-400/80'}`}
                      style={{ width: `${pct}%` }}
                      aria-hidden
                    />
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground/80">
                    last seen {formatRelative(t.lastSeen)}
                  </span>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

// ── Recent errors tail (last 10 non-2xx, 429 included) ───────────────

function RecentErrors({ errors }: { errors: ApiUsageResponse['recentErrors'] }) {
  return (
    <section aria-label="Recent errors" className="mt-5">
      <h3 className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/80">
        Recent errors · last {errors.length || '—'} of 10
      </h3>
      {errors.length === 0 ? (
        <p className="mt-2.5 flex items-center gap-2 text-xs text-muted-foreground">
          <CheckCircle2 className="h-4 w-4 text-emerald-600/70 dark:text-emerald-400/70" aria-hidden />
          no errors in window
        </p>
      ) : (
        <ul className="foundry-scroll mt-2 max-h-72 divide-y divide-border overflow-y-auto pr-1">
          {errors.map((e) => (
            <li key={e.id} className="flex items-center gap-2.5 py-1.5 font-mono text-xs">
              <span className="w-9 shrink-0 rounded border border-rose-500/30 bg-rose-500/10 px-1 py-0.5 text-center text-[10px] font-semibold text-rose-600 dark:text-rose-400">
                {e.status}
              </span>
              <span className="min-w-0 flex-1 truncate text-foreground/80">{e.route}</span>
              <span className="shrink-0 text-[10px] text-muted-foreground/80">
                {formatRelative(e.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
