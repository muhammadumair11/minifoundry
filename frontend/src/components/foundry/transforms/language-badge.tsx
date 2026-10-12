'use client'

import { cn } from '@/lib/utils'
import type { TransformLanguage } from '@/lib/foundry-types'

// Language visual language: SQL = emerald tint, JavaScript = amber tint,
// Python = violet tint (mono).
const LANGUAGE_META: Record<
  TransformLanguage,
  { label: string; className: string }
> = {
  sql: {
    label: 'SQL',
    className: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  },
  javascript: {
    label: 'JS',
    className: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  },
  python: {
    label: 'PY',
    className: 'border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-400',
  },
}

export function LanguageBadge({
  language,
  className,
}: {
  language: TransformLanguage
  className?: string
}) {
  const meta = LANGUAGE_META[language] ?? LANGUAGE_META.sql
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded border px-1.5 py-px font-mono text-[10px] font-medium tracking-wide',
        meta.className,
        className,
      )}
      aria-label={`Language: ${meta.label}`}
    >
      {meta.label}
    </span>
  )
}
