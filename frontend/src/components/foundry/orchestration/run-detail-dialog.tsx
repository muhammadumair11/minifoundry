'use client'

// Orchestration — run detail dialog (Phase 1: reproducible builds).
// Shows the full build record for one pipeline run: identity + timing, failure
// cause, the REPRODUCIBILITY MANIFEST (pinned graph version, exact input
// dataset versions read, outputs written, per-node code fingerprints) and the
// run logs. Editors can replay the run from its recorded inputs.

import { useState } from 'react'
import Link from '@/components/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Boxes, FileCode2, History, ListTree, PlayCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { GatedButton } from '@/components/foundry/governance/gated-button'
import { StatusBadge } from '@/components/foundry/status-badge'
import { VersionChip } from '@/components/foundry/version-chip'
import { apiJson } from '@/lib/foundry-api'
import { formatDuration, formatRelative, shortId } from '@/lib/foundry-types'
import type { OrchestrationRun } from '@/lib/foundry-types'
import type { ManifestInput, ManifestNode, ManifestOutput, RunManifest } from '@/lib/engine-types'

type RunLogEntry = { ts: string; level: 'info' | 'warn' | 'error' | 'success'; msg: string }

type RunDetail = OrchestrationRun & {
  pipelineName: string
  trigger?: string
  attempt?: number
  durationMs?: number | null
  failureCause?: string | null
  outputDatasetId?: string | null
  outputVersionNumber?: number | null
  replayedFromRunId?: string | null
  logs?: RunLogEntry[]
  manifest: RunManifest | null
}

type RunDetailResponse = { run: RunDetail }
type SessionResponse = { role?: string }

/** Trigger chip colors mirror jobs-card; replay gets its own cyan family. */
const TRIGGER_CHIP: Record<string, string> = {
  manual: 'border-zinc-500/30 bg-zinc-500/10 text-zinc-600 dark:text-zinc-400',
  schedule: 'border-violet-600/30 bg-violet-500/10 text-violet-600 dark:text-violet-400',
  upstream: 'border-teal-600/30 bg-teal-500/10 text-teal-600 dark:text-teal-400',
  retry: 'border-amber-600/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  replay: 'border-cyan-600/30 bg-cyan-500/10 text-cyan-600 dark:text-cyan-400',
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-sm text-foreground">{children}</dd>
    </div>
  )
}

function ManifestSection({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode
  title: string
  children: React.ReactNode
}) {
  return (
    <div>
      <h4 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {icon}
        {title}
      </h4>
      <div className="mt-1.5">{children}</div>
    </div>
  )
}

function ManifestRows({ rows, kind }: { rows: ManifestInput[] | ManifestOutput[]; kind: 'in' | 'out' }) {
  if (rows.length === 0) {
    return <p className="text-xs text-muted-foreground">{kind === 'in' ? 'No dataset inputs.' : 'No outputs written.'}</p>
  }
  return (
    <ul className="space-y-1">
      {rows.map((r) => (
        <li key={`${r.datasetId}@${r.versionNumber}`} className="flex items-center gap-2 text-xs">
          <Link
            href={`/datasets/${r.datasetId}`}
            className="max-w-[200px] truncate text-foreground underline-offset-2 hover:underline"
            title={`Open dataset — ${r.datasetName}`}
          >
            {r.datasetName}
          </Link>
          <span className="rounded border border-border bg-muted px-1 font-mono text-[10px] text-muted-foreground">
            {kind === 'in' ? 'read' : 'wrote'} v{r.versionNumber ?? '—'}
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">{r.rowCount} rows</span>
        </li>
      ))}
    </ul>
  )
}

export function RunDetailDialog({
  runId,
  onClose,
}: {
  runId: string | null
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [showLogs, setShowLogs] = useState(true)

  const detailQuery = useQuery<RunDetailResponse>({
    queryKey: ['run', runId],
    queryFn: () => apiJson<RunDetailResponse>(`/api/runs/${runId}`),
    enabled: Boolean(runId),
  })

  const sessionQuery = useQuery<SessionResponse>({
    queryKey: ['session'],
    queryFn: () => apiJson<SessionResponse>('/api/session'),
    enabled: Boolean(runId),
    staleTime: 60_000,
  })
  const role = sessionQuery.data?.role
  const canReplay = role === 'editor' || role === 'admin'

  const replayMutation = useMutation({
    mutationFn: (id: string) => apiJson<{ run: { id: string; status: string } }>(`/api/runs/${id}/replay`, { method: 'POST' }),
    onSuccess: (res) => {
      toast.success('Replay started from recorded inputs', {
        description: `New run ${shortId(res.run.id, 8)} — same graph, same input versions.`,
      })
      void queryClient.invalidateQueries({ queryKey: ['runs'] })
      void queryClient.invalidateQueries({ queryKey: ['run'] })
      void queryClient.invalidateQueries({ queryKey: ['health'] })
      void queryClient.invalidateQueries({ queryKey: ['stats'] })
      onClose()
    },
    onError: (err: Error) => toast.error('Replay failed', { description: err.message }),
  })

  const run = detailQuery.data?.run

  return (
    <Dialog open={Boolean(runId)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-hidden p-0 sm:max-w-xl" aria-describedby={undefined}>
        <div className="foundry-scroll max-h-[85vh] overflow-y-auto">
          <div className="p-4">
            <DialogHeader className="space-y-1 text-left">
              <div className="flex items-center gap-2">
                <DialogTitle className="text-sm font-semibold">
                  {run ? run.pipelineName : 'Run'}{' '}
                  {run && <span className="font-mono text-xs text-muted-foreground">{shortId(run.id, 8)}</span>}
                </DialogTitle>
                {run && <StatusBadge status={run.status} />}
              </div>
              <DialogDescription className="text-xs text-muted-foreground">
                Build record — what this run read, wrote and executed.
              </DialogDescription>
            </DialogHeader>

            {detailQuery.isLoading ? (
              <div className="mt-4 space-y-2">
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
            ) : detailQuery.isError || !run ? (
              <p className="mt-4 text-sm text-rose-600 dark:text-rose-400">
                {detailQuery.error instanceof Error ? detailQuery.error.message : 'Failed to load the run.'}
              </p>
            ) : (
              <div className="mt-3 space-y-4">
                {/* ── identity + timing ─────────────────────────────── */}
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
                  <Meta label="Pipeline version">
                    {run.versionNumber != null ? <VersionChip versionNumber={run.versionNumber} title="Pipeline version executed" /> : '—'}
                  </Meta>
                  <Meta label="Trigger">
                    <span
                      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                        TRIGGER_CHIP[run.trigger ?? 'manual'] ?? TRIGGER_CHIP.manual
                      }`}
                    >
                      {run.trigger ?? 'manual'}
                      {(run.attempt ?? 1) > 1 && <span className="ml-1 font-mono">×{run.attempt}</span>}
                    </span>
                  </Meta>
                  <Meta label="Started">{formatRelative(run.startedAt)}</Meta>
                  <Meta label="Duration">
                    {run.status === 'running' ? 'running…' : formatDuration(run.startedAt, run.finishedAt)}
                  </Meta>
                </dl>

                {run.replayedFromRunId && (
                  <p className="flex items-center gap-1.5 rounded border border-cyan-600/30 bg-cyan-500/10 px-2 py-1.5 text-xs text-cyan-700 dark:text-cyan-400">
                    <History className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    Replay of run <span className="font-mono">{shortId(run.replayedFromRunId, 8)}</span> — pinned to its recorded input versions.
                  </p>
                )}

                {run.failureCause && (
                  <div className="rounded border border-rose-600/30 bg-rose-500/10 px-3 py-2">
                    <h4 className="text-[11px] font-semibold uppercase tracking-wider text-rose-600 dark:text-rose-400">
                      Failure cause
                    </h4>
                    <p className="mt-1 text-xs text-foreground">{run.failureCause}</p>
                  </div>
                )}

                <Separator />

                {/* ── the manifest ──────────────────────────────────── */}
                {run.manifest ? (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground">
                        Build manifest
                      </h3>
                      <span className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                        {run.manifest.inputs.length} in · {run.manifest.outputs.length} out · {run.manifest.nodes.length} nodes
                      </span>
                    </div>

                    <ManifestSection icon={<Boxes className="h-3.5 w-3.5" aria-hidden />} title="Inputs (exact versions read)">
                      <ManifestRows rows={run.manifest.inputs} kind="in" />
                    </ManifestSection>

                    <ManifestSection icon={<ListTree className="h-3.5 w-3.5" aria-hidden />} title="Outputs (new immutable versions)">
                      <ManifestRows rows={run.manifest.outputs} kind="out" />
                    </ManifestSection>

                    {run.manifest.nodes.some((n: ManifestNode) => n.codeSha256) && (
                      <ManifestSection icon={<FileCode2 className="h-3.5 w-3.5" aria-hidden />} title="Node code fingerprints">
                        <ul className="space-y-1">
                          {run.manifest.nodes
                            .filter((n) => n.codeSha256)
                            .map((n) => (
                              <li key={n.nodeId} className="flex items-center gap-2 text-xs">
                                <span className="font-mono text-[10px] uppercase text-muted-foreground">{n.type}</span>
                                {n.label && <span className="max-w-[140px] truncate text-foreground">{n.label}</span>}
                                <span className="font-mono text-[10px] text-muted-foreground" title={`sha256 ${n.codeSha256}`}>
                                  sha256:{n.codeSha256?.slice(0, 10)}…
                                </span>
                              </li>
                            ))}
                        </ul>
                      </ManifestSection>
                    )}
                  </div>
                ) : (
                  <p className="rounded border border-dashed border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                    No build manifest — this run predates reproducible builds, so it cannot be replayed from recorded inputs.
                  </p>
                )}

                <Separator />

                {/* ── logs ──────────────────────────────────────────── */}
                <div>
                  <button
                    type="button"
                    onClick={() => setShowLogs((v) => !v)}
                    className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
                    aria-expanded={showLogs}
                  >
                    Logs {showLogs ? '▾' : '▸'}
                  </button>
                  {showLogs && (
                    <pre className="foundry-scroll mt-1.5 max-h-44 overflow-y-auto rounded border border-border bg-muted/40 p-2 font-mono text-[11px] leading-relaxed text-foreground">
                      {(run.logs ?? []).length === 0
                        ? 'No log entries.'
                        : (run.logs ?? []).map((l, i) => `${i + 1}. [${l.level}] ${l.msg}`).join('\n')}
                    </pre>
                  )}
                </div>

                {/* ── actions ───────────────────────────────────────── */}
                <div className="flex justify-end gap-2">
                  {run.manifest && (
                    <GatedButton
                      allowed={canReplay}
                      reason="Replaying requires editor role"
                      size="sm"
                      className="h-8 text-xs"
                      onClick={() => replayMutation.mutate(run.id)}
                      disabled={replayMutation.isPending}
                    >
                      <PlayCircle className="h-3.5 w-3.5" aria-hidden />
                      Replay from recorded inputs
                    </GatedButton>
                  )}
                  <Button asChild variant="outline" size="sm" className="h-8 text-xs">
                    <Link href={`/pipelines/${run.pipelineId}`}>Open builder</Link>
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
