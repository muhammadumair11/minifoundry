'use client'

// Dashboard builder/viewer (Task 14-d). View mode = responsive widget grid fed
// by POST …/data (source of truth). Edit mode (editor-gated) = local draft with
// add / reorder / remove widgets + inline rename, committed by ONE Save PATCH
// (consistent with the "Save button" pattern; no autosave). Refresh re-queries
// live data — Ontology widgets resolve through their governed backing data.

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ArrowLeft,
  LayoutDashboard,
  Loader2,
  PencilLine,
  RefreshCw,
  Save,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { apiJson, apiSend, toastApiError } from '@/lib/foundry-api'
import { formatRelative } from '@/lib/foundry-types'
import type {
  DashboardInfo,
  DashboardWidget,
  DatasetsListResponse,
  OntologyListResponse,
  SessionResponse,
} from '@/lib/foundry-types'
import { DashboardWidgetCard } from '@/components/foundry/dashboard-widget-card'
import { AddWidgetDialog } from '@/components/foundry/add-widget-dialog'

const canEditRole = (role: SessionResponse['role'] | undefined) => role === 'editor' || role === 'admin'

interface Draft {
  title: string
  description: string
  widgets: DashboardWidget[]
}

function draftOf(d: DashboardInfo): Draft {
  return {
    title: d.title,
    description: d.description ?? '',
    widgets: d.widgets.map((w) => ({ ...w, config: { ...w.config } })),
  }
}

function sameDraft(a: Draft, b: Draft): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export default function DashboardBuilderPage() {
  const params = useParams<{ id: string }>()
  const dashboardId = params.id
  const queryClient = useQueryClient()

  const sessionQuery = useQuery<SessionResponse>({
    queryKey: ['session'],
    queryFn: () => apiJson<SessionResponse>('/api/session'),
    staleTime: 30_000,
  })
  const canEdit = canEditRole(sessionQuery.data?.role)

  const dashboardQuery = useQuery<{ dashboard: DashboardInfo }>({
    queryKey: ['dashboard', dashboardId],
    queryFn: () => apiJson<{ dashboard: DashboardInfo }>(`/api/dashboards/${dashboardId}`),
  })
  const dashboard = dashboardQuery.data?.dashboard ?? null

  const datasetsQuery = useQuery<DatasetsListResponse>({
    queryKey: ['datasets'],
    queryFn: () => apiJson<DatasetsListResponse>('/api/datasets'),
  })
  const ontologyQuery = useQuery<OntologyListResponse>({
    queryKey: ['ontology'],
    queryFn: () => apiJson<OntologyListResponse>('/api/ontology'),
  })

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [spinning, setSpinning] = useState(false)

  const startEditing = () => {
    if (!dashboard) return
    setDraft(draftOf(dashboard))
    setEditing(true)
  }

  const discard = () => {
    if (dashboard) setDraft(draftOf(dashboard))
    setEditing(false)
  }

  const saveMutation = useMutation({
    mutationFn: (d: Draft) =>
      apiSend<{ dashboard: DashboardInfo }>(`/api/dashboards/${dashboardId}`, 'PATCH', {
        title: d.title.trim() || 'Untitled dashboard',
        description: d.description.trim() === '' ? null : d.description.trim(),
        widgets: d.widgets,
      }),
    onSuccess: (res) => {
      toast.success('Dashboard saved', { description: `${res.dashboard.widgets.length} widgets` })
      queryClient.invalidateQueries({ queryKey: ['dashboard', dashboardId] })
      queryClient.invalidateQueries({ queryKey: ['dashboards'] })
      setEditing(false)
      setDraft(null)
    },
    onError: (err: Error) => toastApiError(err, 'Could not save dashboard'),
  })

  const refresh = () => {
    setSpinning(true)
    void queryClient.invalidateQueries({ queryKey: ['dashboard-widget'] })
    void queryClient.invalidateQueries({ queryKey: ['dashboard', dashboardId] })
    setTimeout(() => setSpinning(false), 700)
  }

  const dirty = useMemo(
    () => editing && draft != null && dashboard != null && !sameDraft(draft, draftOf(dashboard)),
    [editing, draft, dashboard],
  )

  if (dashboardQuery.isLoading) {
    return (
      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:py-8">
        <Skeleton className="mb-4 h-10 w-full" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-64 w-full" />
          ))}
        </div>
      </div>
    )
  }

  if (dashboardQuery.isError || !dashboard) {
    return (
      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:py-8">
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-2 p-8 text-center">
            <p className="text-sm font-medium text-foreground">
              {dashboardQuery.error instanceof Error ? dashboardQuery.error.message : 'Dashboard not found'}
            </p>
            <Button asChild variant="outline" size="sm" className="mt-1 gap-1.5">
              <Link href="/dashboards">
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
                Back to dashboards
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  const widgets = editing && draft ? draft.widgets : dashboard.widgets

  const moveWidget = (index: number, dir: -1 | 1) => {
    setDraft((prev) => {
      if (!prev) return prev
      const next = [...prev.widgets]
      const j = index + dir
      if (j < 0 || j >= next.length) return prev
      ;[next[index], next[j]] = [next[j], next[index]]
      return { ...prev, widgets: next }
    })
  }

  const removeWidget = (index: number) => {
    setDraft((prev) => {
      if (!prev) return prev
      return { ...prev, widgets: prev.widgets.filter((_, i) => i !== index) }
    })
  }

  const addWidget = (widget: DashboardWidget) => {
    setDraft((prev) => {
      if (!prev) return prev
      return { ...prev, widgets: [...prev.widgets, widget] }
    })
    toast.success('Widget added', { description: `${widget.title} — press Save to commit` })
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:py-8">
      {/* Header (compact Foundry pattern) */}
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          {editing && draft ? (
            <div className="grid gap-2">
              <div className="flex items-center gap-2">
                <PencilLine className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                <Input
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  aria-label="Dashboard title"
                  placeholder="Dashboard title"
                  className="h-8 max-w-md text-sm font-medium"
                />
              </div>
              <Input
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                aria-label="Dashboard description"
                placeholder="Description (optional)"
                className="h-8 max-w-md text-xs text-muted-foreground"
              />
            </div>
          ) : (
            <>
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <LayoutDashboard className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                <h1 className="truncate text-sm font-medium tracking-tight text-foreground">{dashboard.title}</h1>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {widgets.length} {widgets.length === 1 ? 'widget' : 'widgets'}
                </span>
              </div>
              {dashboard.description && (
                <p className="mt-1 max-w-2xl truncate text-xs text-muted-foreground">{dashboard.description}</p>
              )}
              <p className="mt-1 font-mono text-[11px] text-muted-foreground/80">
                updated {formatRelative(dashboard.updatedAt)}
                {dashboard.createdBy ? ` · by ${dashboard.createdBy}` : ''}
              </p>
            </>
          )}
        </div>

        {/* Actions: Refresh always; edit tools editor-gated */}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={refresh} aria-label="Refresh widget data">
            <RefreshCw className={cn('h-3.5 w-3.5', spinning && 'animate-spin')} aria-hidden />
            Refresh
          </Button>
          {editing && draft ? (
            <>
              <AddWidgetDialog
                datasets={datasetsQuery.data?.datasets ?? []}
                objectTypes={ontologyQuery.data?.objectTypes ?? []}
                onAdd={addWidget}
              />
              <Button
                size="sm"
                className="gap-1.5"
                disabled={!dirty || saveMutation.isPending}
                onClick={() => saveMutation.mutate(draft)}
              >
                {saveMutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  <Save className="h-3.5 w-3.5" aria-hidden />
                )}
                Save
              </Button>
              <Button variant="ghost" size="sm" className="gap-1.5" onClick={discard} disabled={saveMutation.isPending}>
                <X className="h-3.5 w-3.5" aria-hidden />
                Discard
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={startEditing}
              disabled={!canEdit}
              title={canEdit ? 'Edit layout and widgets' : 'requires editor role (current: viewer)'}
            >
              <PencilLine className="h-3.5 w-3.5" aria-hidden />
              Edit
            </Button>
          )}
        </div>
      </div>

      {/* Widget grid: span 2 → double column on md+ */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {widgets.map((w, i) => (
          <div key={w.id} className={cn(w.span === 2 && 'md:col-span-2 xl:col-span-2')}>
            <DashboardWidgetCard
              dashboardId={dashboardId}
              widget={w}
              editMode={editing}
              isFirst={i === 0}
              isLast={i === widgets.length - 1}
              onMove={(dir) => moveWidget(i, dir)}
              onRemove={() => removeWidget(i)}
            />
          </div>
        ))}
        {editing && widgets.length === 0 && (
          <div className="flex h-48 flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-center md:col-span-2 xl:col-span-3">
            <LayoutDashboard className="h-7 w-7 text-muted-foreground/70" aria-hidden />
            <p className="text-sm font-medium text-muted-foreground">Empty canvas</p>
            <p className="max-w-sm text-xs text-muted-foreground/80">
              Use “Add widget” to visualize an Ontology object type or a dataset.
            </p>
          </div>
        )}
      </div>

      {/* Edit-mode hint */}
      {editing && (
        <p className="mt-3 font-mono text-[11px] text-muted-foreground/80">
          edit mode — changes are local until you press Save
        </p>
      )}
    </div>
  )
}
