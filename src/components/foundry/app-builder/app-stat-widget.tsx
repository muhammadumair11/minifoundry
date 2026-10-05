'use client'

// AppStatWidget — a single aggregate over an object type, respecting the app's
// global filters. count uses the governed total from /api/objects; sum/avg/
// min/max aggregate the first page of rows client-side (≤200 objects, matching
// the platform's page cap — noted in the footnote when truncated).

import { Loader2, TriangleAlert } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { filtersForType, useAppObjects, type ActiveFilter } from './use-app-objects'
import type {
  AppFilterDef,
  AppStatWidget as AppStatWidgetConfig,
  OntologyObjectType,
} from '@/lib/foundry-types'

interface AppStatWidgetProps {
  widget: AppStatWidgetConfig
  objectTypes: OntologyObjectType[]
  filterDefs: AppFilterDef[]
  filterValues: Record<string, string>
}

function aggregate(
  agg: 'sum' | 'avg' | 'min' | 'max',
  values: number[],
): number | null {
  if (values.length === 0) return null
  switch (agg) {
    case 'sum':
      return values.reduce((a, b) => a + b, 0)
    case 'avg':
      return values.reduce((a, b) => a + b, 0) / values.length
    case 'min':
      return Math.min(...values)
    case 'max':
      return Math.max(...values)
  }
}

function formatValue(value: number | null, agg: string): string {
  if (value === null) return '—'
  if (agg === 'count') return Math.round(value).toLocaleString('en-US')
  const abs = Math.abs(value)
  const decimals = abs >= 100 ? 0 : abs >= 1 ? 1 : 2
  return value.toLocaleString('en-US', { maximumFractionDigits: decimals })
}

export function AppStatWidget({ widget, objectTypes, filterDefs, filterValues }: AppStatWidgetProps) {
  const objectType = objectTypes.find((t) => t.apiName === widget.objectTypeApiName) ?? null
  const isCount = widget.agg === 'count'
  const filters: ActiveFilter[] = objectType
    ? filtersForType(filterDefs, filterValues, objectType.apiName, objectType.properties)
    : []
  const query = useAppObjects(objectType ? objectType.apiName : null, filters, 1, isCount ? 1 : 200)

  if (!objectType) {
    return (
      <div className="flex h-24 flex-col items-center justify-center gap-1 rounded-md border border-dashed text-center">
        <TriangleAlert className="h-4 w-4 text-amber-500" aria-hidden />
        <p className="text-[11px] text-muted-foreground">
          Object type <span className="font-mono">{widget.objectTypeApiName}</span> not found
        </p>
      </div>
    )
  }

  if (query.isLoading) return <Skeleton className="h-24 w-full" />

  if (query.isError) {
    return (
      <div className="flex h-24 flex-col items-center justify-center gap-1 rounded-md border border-dashed text-center">
        <TriangleAlert className="h-4 w-4 text-rose-500" aria-hidden />
        <p className="max-w-[200px] truncate px-2 text-[11px] text-muted-foreground">
          {query.error instanceof Error ? query.error.message : 'Failed to load'}
        </p>
      </div>
    )
  }

  const rows = query.data?.rows ?? []
  const total = query.data?.total ?? 0
  let value: number | null
  if (isCount) {
    value = total
  } else {
    const prop = widget.valueProperty
    const values = prop
      ? rows.map((r) => Number(r.values[prop])).filter((n) => Number.isFinite(n))
      : []
    value = aggregate(widget.agg as 'sum' | 'avg' | 'min' | 'max', values)
  }

  const truncated = !isCount && total > rows.length

  return (
    <div className="flex h-24 flex-col justify-center gap-1 rounded-md border border-border/60 bg-muted/20 px-4">
      <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {query.isFetching && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
        {objectType.displayName}
      </p>
      <p className="text-2xl font-semibold tabular-nums tracking-tight text-foreground">
        {formatValue(value, widget.agg)}
      </p>
      <p className="truncate text-[10px] text-muted-foreground">
        {isCount
          ? `${total.toLocaleString('en-US')} objects matching filters`
          : `${widget.agg} of ${widget.valueProperty ?? '—'}${truncated ? ` · first ${rows.length} of ${total.toLocaleString('en-US')}` : ''}`}
      </p>
    </div>
  )
}
