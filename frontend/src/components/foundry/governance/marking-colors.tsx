'use client'

// MiniFoundry governance — marking color + chip visuals (Task 4-c).
// Same literal-class pattern as components/foundry/ontology/icon-map.tsx so
// Tailwind's scanner picks everything up. Backend color enum: rose|amber|teal|zinc.

import { Lock } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { MarkingColor } from '@/lib/foundry-types'

export interface MarkingColorClasses {
  border: string
  bg: string
  text: string
  dot: string
}

const MARKING_COLOR_CLASSES: Record<MarkingColor, MarkingColorClasses> = {
  rose: {
    border: 'border-rose-500/40',
    bg: 'bg-rose-500/10',
    text: 'text-rose-600 dark:text-rose-400',
    dot: 'bg-rose-500 dark:bg-rose-400',
  },
  amber: {
    border: 'border-amber-500/40',
    bg: 'bg-amber-500/10',
    text: 'text-amber-600 dark:text-amber-400',
    dot: 'bg-amber-500 dark:bg-amber-400',
  },
  teal: {
    border: 'border-teal-500/40',
    bg: 'bg-teal-500/10',
    text: 'text-teal-600 dark:text-teal-400',
    dot: 'bg-teal-500 dark:bg-teal-400',
  },
  zinc: {
    border: 'border-border',
    bg: 'bg-muted',
    text: 'text-muted-foreground',
    dot: 'bg-zinc-400 dark:bg-zinc-500',
  },
}

/** Resolve marking color classes; unknown/null falls back to rose (defensive). */
export function getMarkingColorClasses(color: string | null | undefined): MarkingColorClasses {
  if (!color) return MARKING_COLOR_CLASSES.rose
  return MARKING_COLOR_CLASSES[color.toLowerCase() as MarkingColor] ?? MARKING_COLOR_CLASSES.rose
}

export const MARKING_COLOR_CHOICES = ['rose', 'amber', 'teal', 'zinc'] as const

export function MarkingColorDot({
  color,
  className,
}: {
  color: string | null | undefined
  className?: string
}) {
  return (
    <span
      aria-hidden
      className={cn('h-2 w-2 shrink-0 rounded-full', getMarkingColorClasses(color).dot, className)}
    />
  )
}

/** Small "locked by <marking>" chip — used on schema columns + masking notes. */
export function MarkingChip({
  name,
  color,
  className,
}: {
  name: string
  color: string | null | undefined
  className?: string
}) {
  const classes = getMarkingColorClasses(color)
  return (
    <span
      title={`Gated by marking “${name}”`}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0 font-mono text-[10px] leading-4',
        classes.border,
        classes.bg,
        classes.text,
        className,
      )}
    >
      <Lock className="h-2.5 w-2.5" aria-hidden />
      {name}
    </span>
  )
}
