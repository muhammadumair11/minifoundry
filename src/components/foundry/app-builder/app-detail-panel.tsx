'use client'

// AppDetailPanel — the object view bound to the app-wide selection. Shows the
// selected object's governed properties, its links in both directions (click a
// target to navigate the app's selection to it) and every enabled Ontology
// action for the type (write-back dialog reused from the object explorer).

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ExternalLink, Link2, Loader2, X, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { apiJson } from '@/lib/foundry-api'
import { getObjectColorClasses, getOperationClasses, OntologyIcon } from '@/components/foundry/ontology/icon-map'
import { formatObjectValue } from './use-app-objects'
import { ActiveActionDialog } from './app-action-widget'
import type {
  AppObjectRef,
  ObjectDetailResponse,
  ObjectLink,
  OntologyObjectType,
} from '@/lib/foundry-types'

const MASK_LITERAL = '------'

/** R14.8 additive: the API also returns the related-object total per link. */
type ObjectLinkWithTotal = ObjectLink & { total?: number }

interface AppDetailPanelProps {
  selection: AppObjectRef
  objectTypes: OntologyObjectType[]
  canEdit: boolean
  onSelect: (ref: AppObjectRef | null) => void
  className?: string
}

function LinksSection({
  links,
  onSelect,
}: {
  links: ObjectLinkWithTotal[]
  onSelect: (ref: AppObjectRef) => void
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({})
  if (links.length === 0) {
    return <p className="px-1 text-[11px] text-muted-foreground/80">No links on this object.</p>
  }
  return (
    <div className="space-y-0.5">
      {links.map((link) => {
        const total = typeof link.total === 'number' ? link.total : link.targets.length
        const isOpen = open[link.id + link.direction] ?? false
        const targetColor = getObjectColorClasses(link.toTypeColor)
        return (
          <div key={`${link.id}-${link.direction}`}>
            <button
              type="button"
              onClick={() => setOpen((prev) => ({ ...prev, [link.id + link.direction]: !isOpen }))}
              aria-expanded={isOpen}
              className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-accent/60"
            >
              <Link2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate text-xs font-medium text-foreground">{link.toTypeDisplayName}</span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">({total})</span>
              <span className="shrink-0 font-mono text-[9px] uppercase tracking-wide text-muted-foreground/70">
                {link.direction === 'incoming' ? 'in' : 'out'}
              </span>
              <ChevronDown
                className={cn('ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', isOpen && 'rotate-180')}
                aria-hidden
              />
            </button>
            {isOpen && (
              <ul className="space-y-0.5 border-l border-border/70 py-0.5 pl-5">
                {link.targets.length === 0 ? (
                  <li className="px-1.5 py-1 text-[11px] text-muted-foreground/80">no linked objects</li>
                ) : (
                  link.targets.slice(0, 8).map((target) => (
                    <li key={target.pk}>
                      <button
                        type="button"
                        onClick={() => onSelect({ objectTypeApiName: link.toTypeApiName, pk: target.pk })}
                        className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-accent/60"
                        title={`Select ${link.toTypeDisplayName} ${target.pk} in this app`}
                      >
                        <span className={cn('flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded border p-0.5', targetColor.border, targetColor.bg)}>
                          <OntologyIcon name={link.toTypeIcon} className={cn('h-2.5 w-2.5', targetColor.text)} />
                        </span>
                        <span className="truncate text-[11px] text-foreground">{target._title}</span>
                        <span className="ml-auto shrink-0 font-mono text-[9px] text-muted-foreground">{target.pk}</span>
                      </button>
                    </li>
                  ))
                )}
              </ul>
            )}
          </div>
        )
      })}
    </div>
  )
}

export function AppDetailPanel({ selection, objectTypes, canEdit, onSelect, className }: AppDetailPanelProps) {
  const [activeAction, setActiveAction] = useState<string | null>(null)

  const detailQuery = useQuery<ObjectDetailResponse>({
    queryKey: ['object', selection.objectTypeApiName, selection.pk],
    queryFn: () =>
      apiJson<ObjectDetailResponse>(
        `/api/objects/${encodeURIComponent(selection.objectTypeApiName)}/${encodeURIComponent(selection.pk)}`,
      ),
  })

  const objectType = useMemo(
    () => objectTypes.find((t) => t.apiName === selection.objectTypeApiName) ?? null,
    [objectTypes, selection.objectTypeApiName],
  )
  const actions = useMemo(
    () => (objectType?.actions ?? []).filter((a) => a.enabled),
    [objectType],
  )

  const color = getObjectColorClasses(objectType?.color ?? detailQuery.data?.objectType.color)

  return (
    <aside
      className={cn('flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card', className)}
      aria-label="Selected object"
    >
      {/* Header */}
      <div className="flex items-start gap-2 border-b border-border/70 px-3 py-2.5">
        <span className={cn('mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border', color.border, color.bg)}>
          <OntologyIcon
            name={objectType?.icon ?? detailQuery.data?.objectType.icon}
            className={cn('h-4 w-4', color.text)}
          />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">
            {detailQuery.data?.object.values[detailQuery.data.objectType.titleProperty ?? ''] != null
              ? formatObjectValue(detailQuery.data.object.values[detailQuery.data.objectType.titleProperty ?? ''])
              : selection.pk}
          </p>
          <p className="truncate font-mono text-[10px] text-muted-foreground">
            {detailQuery.data?.objectType.displayName ?? selection.objectTypeApiName} · {selection.pk}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0"
          onClick={() => onSelect(null)}
          aria-label="Close object panel"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>

      {detailQuery.isLoading ? (
        <div className="space-y-2 p-3">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-7 w-full" />
          ))}
        </div>
      ) : detailQuery.isError || !detailQuery.data ? (
        <div className="p-3 text-xs text-rose-600 dark:text-rose-400">
          {detailQuery.error instanceof Error ? detailQuery.error.message : 'Failed to load object'}
        </div>
      ) : (
        <div className="foundry-scroll min-h-0 flex-1 overflow-y-auto">
          {/* Properties */}
          <div className="border-b border-border/60 px-3 py-2.5">
            <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Properties</p>
            <dl className="space-y-1">
              {Object.entries(detailQuery.data.object.values ?? {}).map(([key, value]) => (
                <div key={key} className="flex items-baseline justify-between gap-3 text-xs">
                  <dt className="shrink-0 font-mono text-[10px] text-muted-foreground">{key}</dt>
                  <dd
                    className={cn(
                      'truncate text-right',
                      value === MASK_LITERAL ? 'italic text-muted-foreground/70' : 'text-foreground',
                      typeof value === 'number' && 'tabular-nums',
                    )}
                    title={String(value ?? '')}
                  >
                    {formatObjectValue(value)}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          {/* Links */}
          <div className="border-b border-border/60 px-2 py-2.5">
            <p className="mb-1 px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Links</p>
            <LinksSection links={detailQuery.data.links as ObjectLinkWithTotal[]} onSelect={onSelect} />
          </div>

          {/* Actions */}
          <div className="px-3 py-2.5">
            <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Actions</p>
            {actions.length === 0 ? (
              <p className="text-[11px] text-muted-foreground/80">No actions on this object type.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {actions.map((action) => {
                  const operation = getOperationClasses(action.operation)
                  return (
                    <Button
                      key={action.id}
                      variant="outline"
                      size="sm"
                      className={cn('h-7 gap-1.5 text-xs', operation.button)}
                      disabled={!canEdit}
                      title={canEdit ? action.displayName : 'requires editor role (current: viewer)'}
                      onClick={() => setActiveAction(action.apiName)}
                    >
                      <Zap className="h-3 w-3" aria-hidden />
                      {action.displayName}
                    </Button>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="border-t border-border/70 px-3 py-2">
        <Link
          href={`/objects/${encodeURIComponent(selection.objectTypeApiName)}?pk=${encodeURIComponent(selection.pk)}`}
          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          {detailQuery.isFetching ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <ExternalLink className="h-3 w-3" aria-hidden />}
          Open in object explorer
        </Link>
      </div>

      {activeAction && (
        <ActiveActionDialog
          actionApiName={activeAction}
          prefillPk={selection.pk}
          onClose={() => setActiveAction(null)}
        />
      )}
    </aside>
  )
}
