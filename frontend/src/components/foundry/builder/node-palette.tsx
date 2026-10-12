'use client'

import { NODE_META, NODE_TYPES } from './node-meta'
import { cn } from '@/lib/utils'
import type { NodeTypeName } from '@/lib/foundry-types'

export function NodePalette({
  onAdd,
  className,
  compact,
}: {
  onAdd: (type: NodeTypeName) => void
  className?: string
  compact?: boolean
}) {
  const items = NODE_TYPES.map((type) => ({ type, meta: NODE_META[type] }))

  if (compact) {
    return (
      <div
        className={cn('foundry-scroll flex gap-1.5 overflow-x-auto pb-1', className)}
        role="toolbar"
        aria-label="Add transform node"
      >
        {items.map(({ type, meta }) => {
          const Icon = meta.icon
          return (
            <button
              key={type}
              type="button"
              onClick={() => onAdd(type)}
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-[11px] font-medium text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
              aria-label={`Add ${meta.label} node`}
            >
              <Icon className="h-3 w-3 text-muted-foreground" aria-hidden />
              {meta.label}
            </button>
          )
        })}
      </div>
    )
  }

  return (
    <aside
      className={cn('flex w-52 shrink-0 flex-col overflow-hidden border-r border-border bg-card', className)}
      aria-label="Node palette"
    >
      <p className="border-b border-border px-3 py-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        Transforms
      </p>
      <div className="foundry-scroll flex-1 space-y-1 overflow-y-auto p-2">
        {items.map(({ type, meta }) => {
          const Icon = meta.icon
          return (
            <button
              key={type}
              type="button"
              onClick={() => onAdd(type)}
              title={meta.hint}
              className="group flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent"
              aria-label={`Add ${meta.label} node`}
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-border bg-muted">
                <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
              </span>
              <span className="min-w-0">
                <span className="block text-xs font-medium text-foreground">
                  {meta.label}
                </span>
                <span className="block truncate text-[10px] text-muted-foreground/80">{meta.hint}</span>
              </span>
            </button>
          )
        })}
      </div>
    </aside>
  )
}
