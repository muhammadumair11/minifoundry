'use client'

import { useEffect, useRef } from 'react'
import { format, parseISO } from 'date-fns'
import { cn } from '@/lib/utils'
import type { RunLog } from '@/lib/foundry-types'

const LEVEL_STYLES: Record<RunLog['level'], string> = {
  error: 'text-rose-600 dark:text-rose-400',
  warn: 'text-amber-600 dark:text-amber-400',
  success: 'text-emerald-600 dark:text-emerald-400',
  info: 'text-muted-foreground',
}

export function LogViewer({
  logs,
  className,
  maxHeightClass = 'max-h-64',
  ariaLabel = 'Pipeline run logs',
}: {
  logs: RunLog[]
  className?: string
  maxHeightClass?: string
  /** Override for non-pipeline contexts (e.g. transform workbooks). */
  ariaLabel?: string
}) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // 'nearest' scrolls the log container to its bottom without yanking
    // ancestor containers (e.g. the window) when already in view.
    bottomRef.current?.scrollIntoView({ block: 'nearest' })
  }, [logs.length])

  if (logs.length === 0) {
    return (
      <div
        className={cn(
          'rounded-md border border-border bg-card p-4 text-center font-mono text-xs text-muted-foreground',
          maxHeightClass,
          className,
        )}
      >
        No logs recorded for this run.
      </div>
    )
  }

  return (
    <div
      className={cn(
        'foundry-scroll overflow-y-auto rounded-md border border-border bg-card p-3 font-mono text-xs leading-5',
        maxHeightClass,
        className,
      )}
      role="log"
      aria-label={ariaLabel}
    >
      {logs.map((log, i) => {
        let time = '--:--:--'
        try {
          time = format(parseISO(log.ts), 'HH:mm:ss')
        } catch {
          /* keep placeholder */
        }
        return (
          <div key={i} className="flex gap-2 whitespace-pre-wrap break-words">
            <span className="shrink-0 text-muted-foreground/80">{time}</span>
            <span className={cn('shrink-0 w-12 text-right font-medium', LEVEL_STYLES[log.level] ?? LEVEL_STYLES.info)}>
              {log.level.toUpperCase()}
            </span>
            <span className="text-foreground">{log.msg}</span>
          </div>
        )
      })}
      <div ref={bottomRef} />
    </div>
  )
}
