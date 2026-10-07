'use client'

// M3.1 pipeline versioning — builder "Versions" control (Task 9-c).
// Popover listing immutable graph snapshots (GET /api/pipelines/[id]/versions,
// desc) with per-version run counts + a restore action. Restore is editor+
// (GatedButton pattern): it loads the snapshot's graph into the canvas via
// onRestored and POSTs /restore, which appends a NEW "restored from v<N>"
// snapshot — history stays append-only. Versions list is public (viewer-safe).

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { History, Loader2, RotateCcw, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { GatedButton } from '@/components/foundry/governance/gated-button'
import { apiJson, apiSend, toastApiError } from '@/lib/foundry-api'
import { cn } from '@/lib/utils'
import { formatRelative } from '@/lib/foundry-types'
import type {
  PipelineGraph,
  PipelineVersionsResponse,
  RestorePipelineResponse,
  SessionResponse,
} from '@/lib/foundry-types'

export function VersionsControl({
  pipelineId,
  versionCount,
  onRestored,
}: {
  pipelineId: string
  /** Pipeline detail's versionCount — instant badge paint while versions load. */
  versionCount?: number
  /** Called with the restored graph so the builder can re-seed the canvas. */
  onRestored?: (graph: PipelineGraph | null) => void
}) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [restoreTarget, setRestoreTarget] = useState<number | null>(null)

  const versionsQuery = useQuery<PipelineVersionsResponse>({
    queryKey: ['pipeline-versions', pipelineId],
    queryFn: () => apiJson<PipelineVersionsResponse>(`/api/pipelines/${pipelineId}/versions`),
    staleTime: 10_000,
  })
  const versions = versionsQuery.data?.versions ?? []
  const latestVersionNumber = versions[0]?.versionNumber ?? null

  // Restore mutates the pipeline → editor+ (list itself is public).
  const sessionQuery = useQuery<SessionResponse>({
    queryKey: ['session'],
    queryFn: () => apiJson<SessionResponse>('/api/session'),
    staleTime: 30_000,
  })
  const role = sessionQuery.data?.role ?? 'viewer'
  const canEdit = role === 'editor' || role === 'admin'

  const restoreMutation = useMutation({
    mutationFn: (from: number) =>
      apiSend<RestorePipelineResponse>(`/api/pipelines/${pipelineId}/restore`, 'POST', {
        versionNumber: from,
      }),
    onSuccess: (res, from) => {
      toast.success(`Restored v${from} as v${res.version.versionNumber}`, {
        description: res.version.note ?? 'Canvas reloaded with the restored graph.',
      })
      onRestored?.(res.pipeline.graph)
      void queryClient.invalidateQueries({ queryKey: ['pipeline', pipelineId] })
      void queryClient.invalidateQueries({ queryKey: ['pipeline-versions', pipelineId] })
      void queryClient.invalidateQueries({ queryKey: ['runs'] })
      void queryClient.invalidateQueries({ queryKey: ['pipelines'] })
    },
    onError: (err) => toastApiError(err, 'Restore failed'),
  })

  const badgeCount = versionsQuery.data ? versions.length : versionCount

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-xs"
            aria-label="Pipeline versions"
          >
            {versionsQuery.isFetching ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <History className="h-3.5 w-3.5" aria-hidden />
            )}
            <span className="hidden sm:inline">Versions</span>
            {badgeCount !== undefined && (
              <span className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                {badgeCount}
              </span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          sideOffset={6}
          collisionPadding={8}
          className="w-[min(20rem,calc(100vw-1.5rem))] p-0"
        >
          <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-3">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              Versions
            </p>
            {badgeCount !== undefined && (
              <span className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                {badgeCount}
              </span>
            )}
          </div>

          {versionsQuery.isLoading ? (
            <div className="space-y-2 border-t border-border p-4">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : versionsQuery.isError ? (
            <p className="border-t border-border p-4 text-sm text-rose-600 dark:text-rose-400">
              {versionsQuery.error instanceof Error
                ? versionsQuery.error.message
                : 'Failed to load versions.'}
            </p>
          ) : versions.length === 0 ? (
            <div className="flex flex-col items-center gap-2 border-t border-border p-6 text-center">
              <History className="h-6 w-6 text-muted-foreground" aria-hidden />
              <p className="text-sm text-foreground">No versions yet</p>
              <p className="text-xs text-muted-foreground/80">
                Saving the pipeline snapshots its graph as an immutable version.
              </p>
            </div>
          ) : (
            <ul
              className="foundry-scroll max-h-96 divide-y divide-border overflow-y-auto border-t border-border"
              aria-label="Pipeline version history"
            >
              {versions.map((v) => {
                const isLatest = v.versionNumber === latestVersionNumber
                const isRestoreNote = v.note?.startsWith('restored from v') ?? false
                return (
                  <li
                    key={v.versionNumber}
                    className="flex items-start gap-2 px-4 py-2.5 transition-colors hover:bg-accent"
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="font-mono text-xs font-semibold text-foreground">
                          v{v.versionNumber}
                        </span>
                        {isLatest && (
                          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
                            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400" />
                            current
                          </span>
                        )}
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {v.nodeCount} {v.nodeCount === 1 ? 'node' : 'nodes'}
                        </span>
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {v.runCount} {v.runCount === 1 ? 'run' : 'runs'}
                        </span>
                      </div>
                      {v.note && (
                        <p
                          className={cn(
                            'truncate text-[11px]',
                            isRestoreNote ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground',
                          )}
                          title={v.note}
                        >
                          {v.note}
                        </p>
                      )}
                      <div className="flex items-center gap-2 font-mono text-[10px] text-muted-foreground/80">
                        <span className="shrink-0">{formatRelative(v.createdAt)}</span>
                        <span className="truncate" title={v.createdBy ?? undefined}>
                          {v.createdBy ?? '—'}
                        </span>
                      </div>
                    </div>
                    {!isLatest && (
                      <GatedButton
                        allowed={canEdit}
                        reason={`requires editor role (current: ${role})`}
                        variant="ghost"
                        size="sm"
                        onClick={() => setRestoreTarget(v.versionNumber)}
                        disabled={restoreMutation.isPending}
                        className="h-7 shrink-0 gap-1 px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
                        aria-label={`Restore version v${v.versionNumber}`}
                      >
                        <Undo2 className="h-3 w-3" aria-hidden />
                        Restore
                      </GatedButton>
                    )}
                  </li>
                )
              })}
            </ul>
          )}

          <p className="border-t border-border px-4 py-2 font-mono text-[10px] text-muted-foreground/80">
            runs pin the version they execute · restore appends a new snapshot
          </p>
        </PopoverContent>
      </Popover>

      {/* Restore confirm — rendered outside the Popover so it survives the
          popover closing under the modal overlay. */}
      <AlertDialog
        open={restoreTarget !== null}
        onOpenChange={(o) => {
          if (!o) setRestoreTarget(null)
        }}
      >
        <AlertDialogContent className="bg-card">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base text-foreground">
              Restore v{restoreTarget}?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-sm text-muted-foreground">
              Loads v{restoreTarget}&apos;s graph into the canvas and saves it as the next
              version. Runs will pin the new version.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="text-muted-foreground hover:text-foreground">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => restoreTarget !== null && restoreMutation.mutate(restoreTarget)}
              disabled={restoreMutation.isPending}
              className="gap-1.5"
            >
              {restoreMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <RotateCcw className="h-4 w-4" aria-hidden />
              )}
              Restore v{restoreTarget}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
