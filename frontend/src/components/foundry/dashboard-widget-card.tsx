'use client'

// Task 14-d — one dashboard widget: fetches its aggregation from
// POST /api/dashboards/[id]/data (source of truth) with a 30s staleTime and
// renders the right visual. In edit mode it also exposes reorder / remove
// controls (the builder page wires the handlers).

import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronUp, RotateCcw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { WidgetVisual } from '@/components/foundry/dashboard-charts'
import { apiJson } from '@/lib/foundry-api'
import type { DashboardWidget, WidgetDataResponse } from '@/lib/foundry-types'

export function DashboardWidgetCard({
  dashboardId,
  widget,
  editMode,
  isFirst,
  isLast,
  onMove,
  onRemove,
}: {
  dashboardId: string
  widget: DashboardWidget
  editMode: boolean
  isFirst: boolean
  isLast: boolean
  onMove?: (dir: -1 | 1) => void
  onRemove?: () => void
}) {
  // The whole widget object is part of the key so config edits refetch, and
  // the Refresh button can invalidate the ['dashboard-widget'] prefix.
  const query = useQuery<WidgetDataResponse>({
    queryKey: ['dashboard-widget', dashboardId, widget.id, widget],
    queryFn: () =>
      apiJson<WidgetDataResponse>(`/api/dashboards/${dashboardId}/data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ widget }),
      }),
    staleTime: 30_000,
  })

  const aggLabel =
    widget.type === 'table'
      ? 'rows'
      : widget.type === 'stat'
        ? (widget.config.agg ?? 'count')
        : `${widget.config.agg ?? 'count'}${widget.config.groupBy ? ` by ${widget.config.groupBy}` : ''}`
  const sourceLabel = widget.sourceType === 'objectType'
    ? (widget.objectTypeName ?? widget.objectTypeId ?? 'Ontology')
    : (widget.datasetName ?? widget.datasetId ?? 'Dataset')
  const sourceKind = widget.sourceType === 'objectType' ? 'object type' : 'dataset'
  const meta = `${sourceLabel} · ${sourceKind} · ${aggLabel}`

  const isError = query.isError || query.data?.error
  const errorMessage =
    (query.error instanceof Error ? query.error.message : undefined) ?? query.data?.error ?? 'Failed to load widget'

  return (
    <Card
      className={`group relative flex flex-col p-4 transition-shadow${editMode ? ' border-dashed' : ''}`}
      aria-label={`Widget ${widget.title}`}
    >
      {/* Header: title + meta, edit controls or empty spacer */}
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-medium tracking-tight text-foreground">{widget.title}</h3>
          <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{meta}</p>
        </div>
        {editMode && (
          <div className="flex shrink-0 items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              disabled={isFirst}
              onClick={() => onMove?.(-1)}
              aria-label={`Move ${widget.title} up`}
            >
              <ChevronUp className="h-3.5 w-3.5" aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              disabled={isLast}
              onClick={() => onMove?.(1)}
              aria-label={`Move ${widget.title} down`}
            >
              <ChevronDown className="h-3.5 w-3.5" aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/40 dark:hover:text-rose-400"
              onClick={() => onRemove?.()}
              aria-label={`Remove ${widget.title}`}
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </Button>
          </div>
        )}
      </div>

      {/* Body: loading skeleton / per-widget error + retry / visual */}
      {query.isLoading ? (
        <Skeleton className={`w-full ${widget.span === 2 ? 'h-56' : 'h-48'}`} aria-hidden />
      ) : isError ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-6 text-center">
          <p className="max-w-56 text-xs text-rose-600 dark:text-rose-400" role="alert">
            {errorMessage}
          </p>
          <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => query.refetch()}>
            <RotateCcw className="h-3 w-3" aria-hidden />
            Retry
          </Button>
        </div>
      ) : (
        <div className={`min-h-0 ${widget.type === 'table' ? 'flex flex-1 flex-col' : widget.span === 2 ? 'h-56' : 'h-48'}`}>
          <WidgetVisual type={widget.type} rows={query.data?.rows ?? []} />
        </div>
      )}
    </Card>
  )
}
