'use client'

import { useQuery } from '@tanstack/react-query'
import { BarChart3, TriangleAlert } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { WidgetVisual, fmtValue } from '@/components/foundry/dashboard-charts'
import { apiJson, apiSend } from '@/lib/foundry-api'
import { cn } from '@/lib/utils'
import { filtersForType, type AppExploration } from './use-app-objects'
import type { AppChartWidget as ChartConfig, AppFilterDef, AppObjectRef, ObjectDetailResponse, OntologyObjectType } from '@/lib/foundry-types'

interface Props {
  widget: ChartConfig
  objectTypes: OntologyObjectType[]
  filterDefs: AppFilterDef[]
  filterValues: Record<string, string>
  exploration: AppExploration | null
  selection: AppObjectRef | null
  onExplore: (value: AppExploration | null) => void
}

export function AppChartWidget({ widget, objectTypes, filterDefs, filterValues, exploration, selection, onExplore }: Props) {
  const objectType = objectTypes.find((type) => type.apiName === widget.objectTypeApiName)
  const filters = objectType
    ? filtersForType(filterDefs, filterValues, objectType.apiName, objectType.properties, exploration)
    : []
  const query = useQuery<{ rows: { name: string; value: number }[]; total: number }>({
    queryKey: ['objects', 'app-chart', widget, filters],
    queryFn: () => apiSend('/api/applications/data', 'POST', {
      objectTypeApiName: widget.objectTypeApiName,
      filters,
      groupBy: widget.groupBy,
      agg: widget.agg,
      valueProperty: widget.valueProperty,
      topN: widget.topN,
    }),
    enabled: !!objectType,
    staleTime: 15_000,
  })
  const selectedObject = useQuery<ObjectDetailResponse>({
    queryKey: ['object', selection?.objectTypeApiName, selection?.pk],
    queryFn: () => apiJson<ObjectDetailResponse>(`/api/objects/${encodeURIComponent(selection!.objectTypeApiName)}/${encodeURIComponent(selection!.pk)}`),
    enabled: selection?.objectTypeApiName === widget.objectTypeApiName,
  })
  const selectedRaw = selectedObject.data?.object.values[widget.groupBy]
  const selectedCategory = selectedRaw == null || selectedRaw === '' ? '(empty)' : String(selectedRaw)

  if (!objectType) return <p className="p-5 text-xs text-muted-foreground">Object type {widget.objectTypeApiName} is unavailable.</p>
  if (query.isLoading) return <Skeleton className="h-72 w-full" />
  if (query.isError) return (
    <div className="flex h-56 items-center justify-center gap-2 text-xs text-muted-foreground">
      <TriangleAlert className="h-4 w-4 text-rose-500" aria-hidden />
      {query.error instanceof Error ? query.error.message : 'Chart could not load'}
    </div>
  )
  const rows = query.data?.rows ?? []
  if (!rows.length) return (
    <div className="flex h-56 flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
      <BarChart3 className="h-5 w-5" aria-hidden />No objects match the current filters.
    </div>
  )
  return (
    <div className="space-y-2">
      <div className="h-64"><WidgetVisual type={widget.chartType} rows={rows} /></div>
      <div className="flex flex-wrap gap-1.5 border-t border-border/60 pt-2" aria-label="Filter by chart category">
        {rows.map((row) => {
          const active = exploration?.objectTypeApiName === widget.objectTypeApiName &&
            exploration.property === widget.groupBy && exploration.value === row.name
          const selected = selectedObject.data != null && selectedCategory === row.name
          return (
            <button
              type="button"
              key={row.name}
              aria-pressed={active}
              onClick={() => onExplore(active ? null : {
                objectTypeApiName: widget.objectTypeApiName,
                property: widget.groupBy,
                value: row.name,
              })}
              className={cn('rounded-full border px-2 py-1 text-[11px] transition-colors hover:border-foreground/30',
                selected && 'ring-2 ring-emerald-500/70 ring-offset-1 ring-offset-background',
                active ? 'border-foreground/50 bg-accent text-foreground' : 'border-border text-muted-foreground')}
              title={`Filter ${objectType.displayName} to ${row.name}`}
            >
              {row.name} <span className="font-mono opacity-70">{fmtValue(row.value)}</span>
            </button>
          )
        })}
      </div>
      {selectedObject.data && <p className="text-[10px] text-emerald-700 dark:text-emerald-400">
        Selected object is in {selectedCategory}
      </p>}
      <p className="font-mono text-[10px] text-muted-foreground">{query.data?.total.toLocaleString('en-US')} objects in scope · select a category to filter the app</p>
    </div>
  )
}
