'use client'

import { format, parseISO } from 'date-fns'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { StatusBadge, StatusDot } from '@/components/foundry/status-badge'
import { LogViewer } from '@/components/foundry/log-viewer'
import { VersionChip } from '@/components/foundry/version-chip'
import { formatDuration, shortId, type RunSummary } from '@/lib/foundry-types'

export function RunPanel({
  runs,
  selectedRun,
  onSelectRun,
  onClose,
}: {
  runs: RunSummary[]
  selectedRun: RunSummary | null
  onSelectRun: (id: string) => void
  onClose: () => void
}) {
  return (
    <section aria-label="Run panel" className="border-t border-border bg-card">
      {/* header */}
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <p className="shrink-0 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            Runs
          </p>
          <div className="foundry-scroll flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto pb-0.5">
            {runs.length === 0 && (
              <span className="font-mono text-[11px] text-muted-foreground/80">no runs yet</span>
            )}
            {runs.map((run) => (
              <button
                key={run.id}
                type="button"
                onClick={() => onSelectRun(run.id)}
                className={cn(
                  'flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2 font-mono text-[10px] transition-colors',
                  selectedRun?.id === run.id
                    ? 'border-foreground/40 bg-accent text-foreground'
                    : 'border-border bg-muted text-muted-foreground hover:border-foreground/30 hover:text-foreground',
                )}
                aria-label={`Run ${shortId(run.id, 6)} — ${run.status}`}
                aria-pressed={selectedRun?.id === run.id}
              >
                <StatusDot status={run.status} className="h-1.5 w-1.5" />
                {shortId(run.id, 6)}
                {run.versionNumber != null && (
                  <VersionChip
                    versionNumber={run.versionNumber}
                    className="h-3.5 px-1 text-[9px]"
                    title={`Executed pipeline version v${run.versionNumber}`}
                  />
                )}
                <span className="text-muted-foreground/80">
                  {format(parseISO(run.startedAt), 'HH:mm:ss')}
                </span>
              </button>
            ))}
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          className="h-7 w-7 shrink-0 p-0 text-muted-foreground hover:text-foreground"
          aria-label="Close run panel"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>

      {/* selected run details */}
      {selectedRun && (
        <div className="border-t border-border px-3 py-2">
          <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
            <StatusBadge status={selectedRun.status} />
            {selectedRun.versionNumber != null && (
              <VersionChip
                versionNumber={selectedRun.versionNumber}
                title="Pipeline version this run executed"
              />
            )}
            <span className="font-mono text-[11px] text-muted-foreground">
              started {format(parseISO(selectedRun.startedAt), 'MMM d, HH:mm:ss')}
            </span>
            <span className="font-mono text-[11px] text-muted-foreground">
              finished{' '}
              {selectedRun.finishedAt
                ? format(parseISO(selectedRun.finishedAt), 'MMM d, HH:mm:ss')
                : '—'}
            </span>
            <span className="font-mono text-[11px] text-foreground">
              {formatDuration(selectedRun.startedAt, selectedRun.finishedAt)}
            </span>
            <span className="font-mono text-[11px] text-muted-foreground/80">{selectedRun.id}</span>
          </div>
          <LogViewer logs={selectedRun.logs ?? []} />
        </div>
      )}
    </section>
  )
}
