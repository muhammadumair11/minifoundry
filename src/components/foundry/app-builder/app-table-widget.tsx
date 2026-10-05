'use client'

// AppTableWidget — a governed object list inside an app canvas. Rows come from
// GET /api/objects (same masking + filter pipeline as the object explorer);
// clicking a row sets the app-wide selection so the map flies to the object
// and the detail panel opens with links + actions.

import { useState } from 'react'
import Link from 'next/link'
import { ChevronLeft, ChevronRight, ExternalLink, Loader2, Table2, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { getObjectColorClasses, OntologyIcon } from '@/components/foundry/ontology/icon-map'
import { filtersForType, formatObjectValue, useAppObjects, type ActiveFilter, type AppExploration } from './use-app-objects'
import type {
  AppFilterDef,
  AppObjectRef,
  AppTableWidget as AppTableWidgetConfig,
  OntologyObjectType,
} from '@/lib/foundry-types'

const MASK_LITERAL = '------'
const PAGE_SIZE = 25

interface AppTableWidgetProps {
  widget: AppTableWidgetConfig
  objectTypes: OntologyObjectType[]
  filterDefs: AppFilterDef[]
  filterValues: Record<string, string>
  exploration?: AppExploration | null
  selection: AppObjectRef | null
  onSelect: (ref: AppObjectRef | null) => void
}

export function AppTableWidget({
  widget,
  objectTypes,
  filterDefs,
  filterValues,
  exploration,
  selection,
  onSelect,
}: AppTableWidgetProps) {
  const [page, setPage] = useState(1)
  const objectType = objectTypes.find((t) => t.apiName === widget.objectTypeApiName) ?? null
  const filters: ActiveFilter[] = objectType
    ? filtersForType(filterDefs, filterValues, objectType.apiName, objectType.properties, exploration)
    : []
  const query = useAppObjects(objectType ? objectType.apiName : null, filters, page, PAGE_SIZE)

  if (!objectType) {
    return (
      <div className="flex h-40 flex-col items-center justify-center gap-1.5 rounded-md border border-dashed text-center">
        <TriangleAlert className="h-5 w-5 text-amber-500" aria-hidden />
        <p className="text-xs text-muted-foreground">
          Object type <span className="font-mono">{widget.objectTypeApiName}</span> is not in the Ontology.
        </p>
      </div>
    )
  }

  const allColumns = query.data?.columns ?? objectType.properties.map((p) => ({ apiName: p.apiName, displayName: p.displayName, dataType: p.dataType, isTitle: p.isTitle, hideInTable: p.hideInTable }))
  const visibleColumns = (() => {
    const wanted = (widget.columns ?? []).filter((c) => allColumns.some((col) => col.apiName === c))
    if (wanted.length > 0) return allColumns.filter((col) => wanted.includes(col.apiName))
    const defaults = allColumns.filter((col) => !col.hideInTable)
    const title = defaults.find((col) => col.isTitle)
    const rest = defaults.filter((col) => col !== title)
    return (title ? [title, ...rest] : rest).slice(0, 7)
  })()

  const rows = query.data?.rows ?? []
  const total = query.data?.total ?? 0
  const color = getObjectColorClasses(objectType.color)
  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1
  const to = Math.min(page * PAGE_SIZE, total)

  if (query.isLoading) {
    return (
      <div className="space-y-2 p-1">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    )
  }

  if (query.isError) {
    return (
      <div className="flex h-40 flex-col items-center justify-center gap-1.5 rounded-md border border-dashed text-center">
        <TriangleAlert className="h-5 w-5 text-rose-500" aria-hidden />
        <p className="max-w-xs text-xs text-muted-foreground">
          {query.error instanceof Error ? query.error.message : 'Failed to load objects'}
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      <div className="foundry-scroll -mx-1 max-h-[360px] overflow-auto px-1">
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 z-[1] bg-card">
            <tr className="border-b border-border">
              {visibleColumns.map((col) => (
                <th
                  key={col.apiName}
                  className="whitespace-nowrap px-2 py-1.5 text-left font-medium text-muted-foreground"
                  title={col.apiName}
                >
                  {col.displayName || col.apiName}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={visibleColumns.length} className="px-2 py-8 text-center text-muted-foreground">
                  <Table2 className="mx-auto mb-2 h-5 w-5 text-muted-foreground/50" aria-hidden />
                  No objects match the current filters.
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const isSelected =
                  selection?.objectTypeApiName === objectType.apiName && selection.pk === row.pk
                return (
                  <tr
                    key={row.pk}
                    onClick={() => onSelect(isSelected ? null : { objectTypeApiName: objectType.apiName, pk: row.pk })}
                    className={cn(
                      'cursor-pointer border-b border-border/50 transition-colors',
                      isSelected ? 'bg-indigo-50 dark:bg-indigo-950/40' : 'hover:bg-accent/50',
                    )}
                    aria-selected={isSelected}
                  >
                    {visibleColumns.map((col) => {
                      const value = row.values[col.apiName]
                      return (
                        <td key={col.apiName} className="max-w-[220px] truncate px-2 py-1.5 text-foreground">
                          {col.isTitle ? (
                            <span className="flex items-center gap-1.5">
                              <span className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded border', color.border, color.bg)}>
                                <OntologyIcon name={objectType.icon} className={cn('h-2.5 w-2.5', color.text)} />
                              </span>
                              <span className="truncate font-medium">{formatObjectValue(value)}</span>
                            </span>
                          ) : value === MASK_LITERAL ? (
                            <span className="italic text-muted-foreground/70">{MASK_LITERAL}</span>
                          ) : (
                            <span className={cn(typeof value === 'number' && 'tabular-nums')}>{formatObjectValue(value)}</span>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Footer: pagination + explorer deep link */}
      <div className="mt-2 flex items-center justify-between gap-2 border-t border-border/60 pt-2">
        <Link
          href={`/objects/${encodeURIComponent(objectType.apiName)}`}
          className="flex items-center gap-1 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          <ExternalLink className="h-3 w-3" aria-hidden />
          Open in explorer
        </Link>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] text-muted-foreground">
            {query.isFetching ? <Loader2 className="mr-1 inline h-3 w-3 animate-spin" aria-hidden /> : null}
            {from.toLocaleString('en-US')}–{to.toLocaleString('en-US')} of {total.toLocaleString('en-US')}
          </span>
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="icon"
              className="h-6 w-6"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              aria-label="Previous page"
            >
              <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-6 w-6"
              disabled={to >= total}
              onClick={() => setPage((p) => p + 1)}
              aria-label="Next page"
            >
              <ChevronRight className="h-3.5 w-3.5" aria-hidden />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
