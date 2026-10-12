'use client'

import { useState } from 'react'
import Link from '@/components/link'
import { format, parseISO } from 'date-fns'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Loader2, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { apiJson, apiSend, toastApiError } from '@/lib/foundry-api'
import { cn } from '@/lib/utils'
import { StatusBadge, StatusDot } from '@/components/foundry/status-badge'
import { LogViewer } from '@/components/foundry/log-viewer'
import { VersionChip } from '@/components/foundry/version-chip'
import { formatDuration, shortId, type RowsResponse, type RunSummary, type SessionResponse } from '@/lib/foundry-types'

type CleanupStatus = {
  state: 'none' | 'removed' | 'available'
  allowed: boolean
  mode?: 'dataset' | 'version'
  datasetName?: string
  versionNumber?: number
  reasons?: string[]
}

const PAGE_SIZE = 25
const showCell = (value: unknown) => value == null ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value)

export function RunPanel({
  runs, selectedRun, onSelectRun, onClose,
}: {
  runs: RunSummary[]
  selectedRun: RunSummary | null
  onSelectRun: (id: string) => void
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<'result' | 'logs'>('result')
  const [page, setPage] = useState(1)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const datasetId = selectedRun?.outputDatasetId
  const versionNumber = selectedRun?.outputVersionNumber
  const outputUrl = selectedRun?.pipelineId
    ? `/api/pipelines/${selectedRun.pipelineId}/runs/${selectedRun.id}/output`
    : null

  const cleanupQuery = useQuery<CleanupStatus>({
    queryKey: ['pipeline-run-output-cleanup', selectedRun?.id],
    queryFn: () => apiJson<CleanupStatus>(outputUrl!),
    enabled: Boolean(outputUrl && datasetId && versionNumber),
  })
  const rowsQuery = useQuery<RowsResponse>({
    queryKey: ['pipeline-run-output-rows', datasetId, versionNumber, page],
    queryFn: () => apiJson<RowsResponse>(`/api/datasets/${datasetId}/rows?version=${versionNumber}&page=${page}&pageSize=${PAGE_SIZE}`),
    enabled: Boolean(datasetId && versionNumber && tab === 'result' && cleanupQuery.data?.state !== 'removed'),
  })
  const sessionQuery = useQuery<SessionResponse>({
    queryKey: ['session'], queryFn: () => apiJson<SessionResponse>('/api/session'), staleTime: 30_000,
  })
  const canEdit = sessionQuery.data?.role === 'editor' || sessionQuery.data?.role === 'admin'
  const cleanupMutation = useMutation({
    mutationFn: () => apiSend<{ removed: string }>(outputUrl!, 'DELETE'),
    onSuccess: (result) => {
      setConfirmOpen(false)
      toast.success(result.removed === 'dataset' ? 'Output dataset removed' : 'Output version removed')
      void queryClient.invalidateQueries({ queryKey: ['pipeline-run-output-cleanup', selectedRun?.id] })
      void queryClient.invalidateQueries({ queryKey: ['pipeline-run-output-rows', datasetId] })
      void queryClient.invalidateQueries({ queryKey: ['datasets'] })
      void queryClient.invalidateQueries({ queryKey: ['lineage'] })
    },
    onError: (error) => toastApiError(error, 'Could not remove output'),
  })

  return (
    <section aria-label="Run panel" className="flex h-full flex-col overflow-hidden border-t border-border bg-card">
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <p className="shrink-0 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Runs</p>
          <div className="foundry-scroll flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto pb-0.5">
            {runs.length === 0 && <span className="font-mono text-[11px] text-muted-foreground/80">no runs yet</span>}
            {runs.map((run) => (
              <button
                key={run.id}
                type="button"
                onClick={() => { setPage(1); setTab('result'); onSelectRun(run.id) }}
                className={cn(
                  'flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2 font-mono text-[10px] transition-colors',
                  selectedRun?.id === run.id
                    ? 'border-foreground/40 bg-accent text-foreground'
                    : 'border-border bg-muted text-muted-foreground hover:border-foreground/30 hover:text-foreground',
                )}
                aria-label={`Run ${shortId(run.id, 10)} — ${run.status}`}
                aria-pressed={selectedRun?.id === run.id}
              >
                <StatusDot status={run.status} className="h-1.5 w-1.5" />
                {shortId(run.id, 10)}
                {run.versionNumber != null && <VersionChip versionNumber={run.versionNumber} className="h-3.5 px-1 text-[9px]" title={`Executed pipeline version v${run.versionNumber}`} />}
                <span className="text-muted-foreground/80">{format(parseISO(run.startedAt), 'HH:mm:ss')}</span>
              </button>
            ))}
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} className="h-7 w-7 shrink-0 p-0 text-muted-foreground hover:text-foreground" aria-label="Close run panel">
          <X className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>

      {selectedRun && (
        <div className="flex min-h-0 flex-1 flex-col border-t border-border">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2">
            <StatusBadge status={selectedRun.status} />
            {selectedRun.versionNumber != null && <VersionChip versionNumber={selectedRun.versionNumber} title="Pipeline version this run executed" />}
            <span className="font-mono text-[11px] text-muted-foreground">started {format(parseISO(selectedRun.startedAt), 'MMM d, HH:mm:ss')}</span>
            <span className="font-mono text-[11px] text-muted-foreground">finished {selectedRun.finishedAt ? format(parseISO(selectedRun.finishedAt), 'MMM d, HH:mm:ss') : '—'}</span>
            <span className="font-mono text-[11px] text-foreground">{formatDuration(selectedRun.startedAt, selectedRun.finishedAt)}</span>
          </div>
          <div className="flex items-center gap-3 border-b border-border px-3">
            <button type="button" onClick={() => setTab('result')} className={cn('py-1.5 text-xs', tab === 'result' ? 'border-b-2 border-primary text-foreground' : 'text-muted-foreground')} aria-pressed={tab === 'result'}>Result</button>
            <button type="button" onClick={() => setTab('logs')} className={cn('py-1.5 text-xs', tab === 'logs' ? 'border-b-2 border-primary text-foreground' : 'text-muted-foreground')} aria-pressed={tab === 'logs'}>Logs</button>
            {datasetId && versionNumber && cleanupQuery.data?.state === 'available' && canEdit && (
              <Button variant="ghost" size="sm" className="ml-auto h-7 gap-1 text-xs text-rose-600" onClick={() => setConfirmOpen(true)}>
                <Trash2 className="h-3 w-3" /> Remove output
              </Button>
            )}
          </div>
          {tab === 'logs' ? (
            <div className="foundry-scroll flex-1 overflow-auto p-3"><LogViewer logs={selectedRun.logs ?? []} maxHeightClass="" /></div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
              {!datasetId || !versionNumber ? <p className="text-xs text-muted-foreground">This run has no output dataset.</p>
                : cleanupQuery.data?.state === 'removed' || rowsQuery.isError ? <p className="text-xs text-muted-foreground">This output is no longer available.</p>
                : rowsQuery.isLoading ? <p className="text-xs text-muted-foreground">Loading result…</p>
                : rowsQuery.data ? (
                  <>
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span>{cleanupQuery.data?.datasetName ?? 'Output'} · {rowsQuery.data.total.toLocaleString()} rows · {rowsQuery.data.columns.length} columns · v{versionNumber}</span>
                      <Link className="text-primary hover:underline" href={`/datasets/${datasetId}?version=${versionNumber}`}>Open dataset</Link>
                    </div>
                    <div className="foundry-scroll min-h-0 flex-1 overflow-auto rounded border border-border">
                      <table className="w-full border-collapse text-left text-xs">
                        <thead className="sticky top-0 bg-muted"><tr>{rowsQuery.data.columns.map((column) => <th key={column.name} className="whitespace-nowrap border-b border-border px-2 py-1.5 font-medium">{column.name}</th>)}</tr></thead>
                        <tbody>{rowsQuery.data.rows.map((row, index) => <tr key={index} className="border-b border-border/50">{rowsQuery.data!.columns.map((column) => <td key={column.name} className="max-w-64 truncate whitespace-nowrap px-2 py-1 font-mono" title={showCell(row[column.name])}>{showCell(row[column.name])}</td>)}</tr>)}</tbody>
                      </table>
                      {rowsQuery.data.rows.length === 0 && <p className="p-3 text-xs text-muted-foreground">No rows in this version.</p>}
                    </div>
                    <div className="flex items-center justify-end gap-2 text-xs">
                      <Button variant="outline" size="sm" className="h-7" disabled={page === 1} onClick={() => setPage((current) => current - 1)}>Previous</Button>
                      <span>Page {page} of {Math.max(1, Math.ceil(rowsQuery.data.total / PAGE_SIZE))}</span>
                      <Button variant="outline" size="sm" className="h-7" disabled={page * PAGE_SIZE >= rowsQuery.data.total} onClick={() => setPage((current) => current + 1)}>Next</Button>
                    </div>
                  </>
                ) : null}
            </div>
          )}
        </div>
      )}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove run output?</AlertDialogTitle>
            <AlertDialogDescription>
              {cleanupQuery.data?.mode === 'dataset'
                ? `Delete ${cleanupQuery.data.datasetName} and its only version? The run record remains.`
                : `Delete version ${cleanupQuery.data?.versionNumber} of ${cleanupQuery.data?.datasetName}? The previous version becomes current. The run record remains.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {cleanupQuery.data?.reasons?.length ? (
            <ul className="list-disc space-y-1 pl-5 text-xs text-rose-600">{cleanupQuery.data.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={!cleanupQuery.data?.allowed || cleanupMutation.isPending} onClick={(event) => { event.preventDefault(); cleanupMutation.mutate() }} className="bg-rose-600 hover:bg-rose-700">
              {cleanupMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Remove output
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
