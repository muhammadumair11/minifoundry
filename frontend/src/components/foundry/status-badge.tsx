import { cn } from '@/lib/utils'

type StatusVariant = 'success' | 'failed' | 'running' | 'neutral'

const VARIANTS: Record<StatusVariant, { dot: string; text: string; ring: string; bg: string }> = {
  success: {
    dot: 'bg-emerald-500 dark:bg-emerald-400',
    text: 'text-emerald-600 dark:text-emerald-400',
    ring: 'border-emerald-500/40',
    bg: 'bg-emerald-500/10',
  },
  failed: {
    dot: 'bg-rose-500 dark:bg-rose-400',
    text: 'text-rose-600 dark:text-rose-400',
    ring: 'border-rose-500/40',
    bg: 'bg-rose-500/10',
  },
  running: {
    dot: 'bg-amber-500 dark:bg-amber-400 animate-pulse',
    text: 'text-amber-600 dark:text-amber-400',
    ring: 'border-amber-500/40',
    bg: 'bg-amber-500/10',
  },
  neutral: {
    dot: 'bg-zinc-400 dark:bg-zinc-500',
    text: 'text-muted-foreground',
    ring: 'border-border',
    bg: 'bg-muted',
  },
}

export function statusVariant(status: string | null | undefined): StatusVariant {
  switch ((status ?? '').toLowerCase()) {
    case 'success':
    case 'succeeded':
      return 'success'
    case 'failed':
    case 'error':
      return 'failed'
    case 'running':
      return 'running'
    default:
      return 'neutral'
  }
}

export function StatusDot({
  status,
  className,
}: {
  status: string | null | undefined
  className?: string
}) {
  const v = VARIANTS[statusVariant(status)]
  return (
    <span
      aria-hidden
      className={cn('inline-block h-2 w-2 shrink-0 rounded-full', v.dot, className)}
    />
  )
}

export function StatusBadge({
  status,
  className,
}: {
  status: string | null | undefined
  className?: string
}) {
  const v = VARIANTS[statusVariant(status)]
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[11px] font-medium',
        v.ring,
        v.bg,
        v.text,
        className,
      )}
    >
      <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', v.dot)} />
      {status ?? 'unknown'}
    </span>
  )
}
