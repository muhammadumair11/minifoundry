import { cn } from '@/lib/utils'

// M3.1 — tiny mono "vN" chip for run/version rows. Matches the rounded-border
// status-chip language used across run lists (zinc border, emerald data tint).

export function VersionChip({
  versionNumber,
  className,
  title,
}: {
  versionNumber: number
  className?: string
  title?: string
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex h-4 shrink-0 items-center rounded border border-emerald-500/30 bg-emerald-500/10 px-1 font-mono text-[10px] leading-none text-emerald-700 dark:text-emerald-400',
        className,
      )}
    >
      v{versionNumber}
    </span>
  )
}
