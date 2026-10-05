'use client'

// Dashboards catalog (Task 14-d) — compact list with editor-gated creation and
// a one-click sample seed ("Shipment operations") that wires 4 widgets to the
// demo datasets' REAL columns (inspected via the datasets API, with fallbacks).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { LayoutDashboard, Loader2, Plus, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { GatedButton } from '@/components/foundry/governance/gated-button'
import { apiJson, apiSend, toastApiError } from '@/lib/foundry-api'
import { formatRelative } from '@/lib/foundry-types'
import type {
  DashboardInfo,
  DashboardListResponse,
  DashboardWidget,
  DatasetsListResponse,
  DatasetDetailResponse,
  SessionResponse,
} from '@/lib/foundry-types'

const canEditRole = (role: SessionResponse['role'] | undefined) => role === 'editor' || role === 'admin'

/** 'warehouseId' → 'Warehouse' — human titles from raw column names. */
function prettyColumn(c: string): string {
  const base = c.replace(/Id$/i, '')
  const spaced = base.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/**
 * Build the sample "Shipment operations" widgets from a dataset whose columns
 * we inspected via GET /api/datasets/[id]. Preference lists pick REAL columns
 * (status has a nice 4-way split, supplierId a 12-way one); anything missing
 * falls back to the first available column so the seed never fails on shape.
 */
function buildSampleWidgets(datasetId: string, datasetName: string, columns: { name: string; type: string }[]): DashboardWidget[] {
  const names = columns.map((c) => c.name)
  const stringCols = columns.filter((c) => c.type === 'string').map((c) => c.name)
  const firstString = stringCols[0] ?? names[0] ?? 'id'
  const pick = (prefs: string[]) => prefs.find((p) => names.includes(p)) ?? firstString

  const barGroup = pick(['supplierId', 'warehouseId', 'category', 'region', 'country'])
  const pieGroup = pick(['status', 'category', 'region', 'country'])
  const meta = { sourceType: 'dataset' as const, datasetId, datasetName }

  return [
    {
      id: 'sample-stat-count',
      type: 'stat',
      title: `Total ${datasetName.toLowerCase()}`,
      ...meta,
      config: { agg: 'count' },
      span: 1,
    },
    {
      id: 'sample-bar-group',
      type: 'bar',
      title: `${datasetName} by ${prettyColumn(barGroup)}`,
      ...meta,
      config: { groupBy: barGroup, agg: 'count', topN: 10, sortDir: 'desc' },
      span: 2,
    },
    {
      id: 'sample-pie-status',
      type: 'pie',
      title: `${datasetName} by ${prettyColumn(pieGroup)}`,
      ...meta,
      config: { groupBy: pieGroup, agg: 'count', topN: 10, sortDir: 'desc' },
      span: 1,
    },
    {
      id: 'sample-table-recent',
      type: 'table',
      title: `Recent ${datasetName.toLowerCase()}`,
      ...meta,
      config: { topN: 10 },
      span: 1,
    },
  ]
}

export default function DashboardsPage() {
  const router = useRouter()
  const queryClient = useQueryClient()

  const sessionQuery = useQuery<SessionResponse>({
    queryKey: ['session'],
    queryFn: () => apiJson<SessionResponse>('/api/session'),
    staleTime: 30_000,
  })
  const canEdit = canEditRole(sessionQuery.data?.role)

  const { data, isLoading, isError } = useQuery<DashboardListResponse>({
    queryKey: ['dashboards'],
    queryFn: () => apiJson<DashboardListResponse>('/api/dashboards'),
  })
  const dashboards = data?.dashboards ?? []

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await apiSend<{ dashboard: DashboardInfo }>('/api/dashboards', 'POST', {
        title: 'Untitled dashboard',
      })
      return res.dashboard
    },
    onSuccess: (dashboard) => {
      toast.success('Dashboard created', { description: dashboard.title })
      queryClient.invalidateQueries({ queryKey: ['dashboards'] })
      router.push(`/dashboards/${dashboard.id}`)
    },
    onError: (err: Error) => toastApiError(err, 'Could not create dashboard'),
  })

  // Sample seed: POST the dashboard, then PATCH the widget layout — client-side
  // orchestration of the same API the builder uses.
  const sampleMutation = useMutation({
    mutationFn: async (): Promise<DashboardInfo> => {
      const datasets = await apiJson<DatasetsListResponse>('/api/datasets')
      const all = datasets.datasets ?? []
      if (all.length === 0) throw new Error('No datasets found — seed sample data first (Settings → Reset workspace)')
      // Prefer the canonical shipments dataset; fall back to any shipments-like
      // name, then to the largest dataset available.
      const target =
        all.find((d) => /^shipments$/i.test(d.name)) ??
        all.find((d) => /ship/i.test(d.name)) ??
        [...all].sort((a, b) => (b.currentVersion?.rowCount ?? 0) - (a.currentVersion?.rowCount ?? 0))[0]

      const detail = await apiJson<DatasetDetailResponse>(`/api/datasets/${target.id}`)
      const columns = detail.current?.schema ?? []
      const widgets = buildSampleWidgets(target.id, target.name, columns)

      const created = await apiSend<{ dashboard: DashboardInfo }>('/api/dashboards', 'POST', {
        title: 'Shipment operations',
        description: 'Live operational view of shipment flow — totals, supplier mix, status split and recent rows.',
      })
      const patched = await apiSend<{ dashboard: DashboardInfo }>(`/api/dashboards/${created.dashboard.id}`, 'PATCH', {
        widgets,
      })
      return patched.dashboard
    },
    onSuccess: (dashboard) => {
      toast.success('Sample dashboard created', { description: `${dashboard.widgets.length} widgets wired to demo data` })
      queryClient.invalidateQueries({ queryKey: ['dashboards'] })
      router.push(`/dashboards/${dashboard.id}`)
    },
    onError: (err: Error) => toastApiError(err, 'Could not create sample dashboard'),
  })

  const busy = createMutation.isPending || sampleMutation.isPending

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:py-8">
      {/* Header (compact Foundry pattern) */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <LayoutDashboard className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <h1 className="truncate text-sm font-medium tracking-tight text-foreground">Dashboards</h1>
          {data && (
            <span className="font-mono text-[11px] text-muted-foreground">
              {dashboards.length} {dashboards.length === 1 ? 'dashboard' : 'dashboards'}
            </span>
          )}
        </div>
        <GatedButton
          allowed={canEdit}
          reason="requires editor role (current: viewer)"
          size="sm"
          onClick={() => createMutation.mutate()}
          disabled={busy}
        >
          {createMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Plus className="h-4 w-4" aria-hidden />
          )}
          New dashboard
        </GatedButton>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-36 w-full" />
          ))}
        </div>
      ) : isError ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-2 p-8 text-center">
            <p className="text-sm font-medium text-foreground">Failed to load dashboards</p>
            <p className="text-xs text-muted-foreground">Try refreshing the page.</p>
          </CardContent>
        </Card>
      ) : dashboards.length === 0 ? (
        /* Empty state — create blank or seed the sample dashboard */
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
            <LayoutDashboard className="h-8 w-8 text-muted-foreground" aria-hidden />
            <div>
              <p className="text-sm font-medium text-foreground">No dashboards yet</p>
              <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
                Dashboards are point-and-click applications over Ontology objects, with direct dataset access
                available for raw analytics. Start from a sample or a blank canvas.
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button size="sm" variant="secondary" className="gap-1.5" onClick={() => sampleMutation.mutate()} disabled={busy}>
                {sampleMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Sparkles className="h-4 w-4" aria-hidden />
                )}
                Create sample dashboard
              </Button>
              <GatedButton
                allowed={canEdit}
                reason="requires editor role (current: viewer)"
                size="sm"
                onClick={() => createMutation.mutate()}
                disabled={busy}
              >
                <Plus className="h-4 w-4" aria-hidden />
                New dashboard
              </GatedButton>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {dashboards.map((d) => (
            <Link
              key={d.id}
              href={`/dashboards/${d.id}`}
              className="group rounded-lg border border-border bg-card transition-colors hover:border-foreground/25"
              aria-label={`Open dashboard ${d.title}`}
            >
              <CardContent className="flex h-full flex-col gap-3 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted/50">
                      <LayoutDashboard className="h-4 w-4 text-muted-foreground" aria-hidden />
                    </span>
                    <h2 className="truncate text-sm font-medium text-foreground">{d.title}</h2>
                  </div>
                </div>
                {d.description && (
                  <p className="line-clamp-2 text-xs leading-5 text-muted-foreground">{d.description}</p>
                )}
                <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground">
                  <span>
                    {d.widgetCount} {d.widgetCount === 1 ? 'widget' : 'widgets'}
                  </span>
                  <span>updated {formatRelative(d.updatedAt)}</span>
                </div>
              </CardContent>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
