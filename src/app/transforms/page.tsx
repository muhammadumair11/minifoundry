'use client'

// M4 Code Workbooks (Task 5-b) — the /transforms showpiece.
// Two-pane layout: workbook list (sidebar) + editor (code, inputs, run,
// preview / logs / run-history). Backend contract: agent-ctx 5-a.

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Braces,
  ChevronDown,
  ChevronUp,
  Database,
  Info,
  Loader2,
  Maximize2,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  PencilLine,
  Play,
  Plus,
  Save,
  Sparkles,
  SquareCode,
  Table2,
  Trash2,
  ScrollText,
  History,
} from 'lucide-react'
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
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { StatusDot } from '@/components/foundry/status-badge'
import { LogViewer } from '@/components/foundry/log-viewer'
import { GatedButton } from '@/components/foundry/governance/gated-button'
import { useFocusMode } from '@/components/foundry/focus-mode'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { LanguageBadge } from '@/components/foundry/transforms/language-badge'
import { NewWorkbookDialog } from '@/components/foundry/transforms/new-workbook-dialog'
import { CodeEditor, type SchemaTable } from '@/components/foundry/code-editor'
import { apiJson, apiSend, toastApiError } from '@/lib/foundry-api'
import { formatRelative } from '@/lib/foundry-types'
import type {
  DatasetDetailResponse,
  DatasetSummary,
  FoundryRole,
  SeedTransformsResponse,
  SessionResponse,
  TransformDetailResponse,
  TransformLanguage,
  TransformRunResponse,
  TransformRunSummary,
  TransformRunsListResponse,
  TransformSummary,
  TransformsListResponse,
  DatasetsListResponse,
} from '@/lib/foundry-types'
import { cn } from '@/lib/utils'

const EDITOR_NOTE: Record<TransformLanguage, string> = {
  sql: 'tables are named after datasets:  FROM shipments JOIN suppliers ON ...',
  javascript:
    'code runs as the body of function(input) — return an array of rows;  input.rows = first input,  input.datasets["Name"] = any input',
  python:
    'define transform(input) — return a list of dicts;  input["rows"] = first input,  input["datasets"]["Name"] = any input,  print() shows up in run logs',
}

const EDITOR_FILE: Record<TransformLanguage, string> = {
  sql: 'query.sql',
  javascript: 'transform.js',
  python: 'transform.py',
}

const canEditRole = (role: FoundryRole | undefined) => role === 'editor' || role === 'admin'

// ── Page ─────────────────────────────────────────────────────────────

export default function TransformsPage() {
  const queryClient = useQueryClient()
  const [rawSelectedId, setRawSelectedId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [listCollapsed, setListCollapsed] = useState(false)

  const transformsQuery = useQuery<TransformsListResponse>({
    queryKey: ['transforms'],
    queryFn: () => apiJson<TransformsListResponse>('/api/transforms'),
  })

  const datasetsQuery = useQuery<DatasetsListResponse>({
    queryKey: ['datasets'],
    queryFn: () => apiJson<DatasetsListResponse>('/api/datasets'),
  })

  const sessionQuery = useQuery<SessionResponse>({
    queryKey: ['session'],
    queryFn: () => apiJson<SessionResponse>('/api/session'),
    staleTime: 30_000,
  })
  const canEdit = canEditRole(sessionQuery.data?.role)

  const transforms = transformsQuery.data?.transforms ?? []
  const datasets = datasetsQuery.data?.datasets ?? []

  // Derived selection: falls back to the first workbook when the raw id
  // disappears (deleted) — no effects needed.
  const selectedId =
    rawSelectedId && transforms.some((t) => t.id === rawSelectedId)
      ? rawSelectedId
      : (transforms[0]?.id ?? null)
  const selectedTransform = transforms.find((t) => t.id === selectedId) ?? null

  const detailQuery = useQuery<TransformDetailResponse>({
    queryKey: ['transform', selectedId],
    queryFn: () => apiJson<TransformDetailResponse>(`/api/transforms/${selectedId}`),
    enabled: !!selectedId,
  })

  const seedMutation = useMutation({
    mutationFn: () => apiSend<SeedTransformsResponse>('/api/transforms/seed-demo', 'POST'),
    onSuccess: (res) => {
      if (res.seeded) {
        toast.success(`Seeded ${res.created.length} demo workbooks`, {
          description: res.created.join(', '),
        })
      } else {
        toast.info('Demo workbooks already seeded', {
          description: `${res.skipped.length} already present — nothing to do.`,
        })
      }
      queryClient.invalidateQueries({ queryKey: ['transforms'] })
    },
    onError: (err) => toastApiError(err, 'Could not seed demo workbooks'),
  })

  const handleSelect = (id: string) => setRawSelectedId(id)
  const handleDeleted = () => setRawSelectedId(null)

  return (
    <div className="flex min-h-0 flex-col lg:h-[calc(100dvh-var(--mf-chrome-h,3.5rem)-var(--mf-footer-h,42px))]">
      {/* Compact workbench header — context only; the working area below owns
          the rest of the viewport (R11 Focus Workspace) */}
      <header className="flex h-10 shrink-0 items-center gap-2.5 border-b border-border px-3">
        <SquareCode className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="truncate text-sm font-medium tracking-tight text-foreground">
          Code Workbooks
        </h1>
        <span className="hidden shrink-0 rounded border border-border bg-muted px-1.5 py-px font-mono text-[10px] text-muted-foreground sm:inline">
          {transforms.length} workbooks · {transforms.reduce((n, t) => n + t.runsCount, 0)} runs
        </span>
        <p
          className="ml-auto hidden truncate font-mono text-[10px] text-muted-foreground/80 xl:inline"
          aria-hidden
        >
          SQL · JavaScript · Python → versioned datasets
        </p>
      </header>

      {/* Two panes — the workbook rail and the editor each scroll on their own */}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* ── Left: workbook list (collapsible to an icon rail on lg) ── */}
        <aside
          className={cn(
            'flex shrink-0 flex-col border-b border-border lg:border-b-0 lg:border-r',
            listCollapsed ? 'lg:w-11' : 'w-full lg:w-64',
          )}
          aria-label="Workbook list"
        >
          <div
            className={cn(
              'flex h-9 shrink-0 items-center gap-1.5 border-b border-border',
              listCollapsed ? 'justify-center px-0' : 'justify-between px-3',
            )}
          >
            {!listCollapsed && (
              <h2 className="truncate text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                Workbooks
              </h2>
            )}
            {transformsQuery.isLoading && (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden />
            )}
            <button
              type="button"
              onClick={() => setListCollapsed(!listCollapsed)}
              aria-label={listCollapsed ? 'Expand workbook list' : 'Collapse workbook list'}
              aria-pressed={listCollapsed}
              className="hidden h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground lg:flex"
            >
              {listCollapsed ? (
                <PanelLeftOpen className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <PanelLeftClose className="h-3.5 w-3.5" aria-hidden />
              )}
            </button>
          </div>

          {/* Expanded list — always on mobile, on lg when not collapsed */}
          <div
            className={cn(
              'foundry-scroll max-h-56 min-h-0 flex-1 overflow-y-auto p-2 lg:max-h-none',
              listCollapsed && 'lg:hidden',
            )}
          >
              {transformsQuery.isLoading ? (
                <div className="space-y-2 p-1">
                  {[0, 1, 2].map((i) => (
                    <Skeleton key={i} className="h-14 w-full" />
                  ))}
                </div>
              ) : transforms.length === 0 ? (
                <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                  Nothing here yet — create a workbook or seed the demos below.
                </p>
              ) : (
                <ul className="space-y-1">
                  {transforms.map((t) => {
                    const active = t.id === selectedId
                    return (
                      <li key={t.id}>
                        <button
                          type="button"
                          onClick={() => handleSelect(t.id)}
                          aria-current={active ? 'true' : undefined}
                          className={cn(
                            'w-full rounded-md border-l-2 px-3 py-2.5 text-left transition-colors',
                            active
                              ? 'border-l-foreground bg-accent hover:bg-accent'
                              : 'border-l-transparent hover:bg-accent/50',
                          )}
                        >
                          <div className="flex items-center gap-2">
                            <span
                              className={cn(
                                'min-w-0 flex-1 truncate text-sm font-medium',
                                active ? 'text-foreground' : 'text-muted-foreground',
                              )}
                            >
                              {t.name}
                            </span>
                            <LanguageBadge language={t.language} />
                          </div>
                          <div className="mt-1.5 flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
                            <StatusDot status={t.latestRun?.status ?? null} className="h-1.5 w-1.5" />
                            {t.latestRun ? (
                              <span className="truncate">
                                {formatRelative(t.latestRun.finishedAt)} ·{' '}
                                {t.latestRun.rowCount !== null
                                  ? `${t.latestRun.rowCount.toLocaleString()} rows`
                                  : t.latestRun.status}
                              </span>
                            ) : (
                              <span>never run</span>
                            )}
                            <span className="ml-auto shrink-0 text-muted-foreground/80">
                              {t.runsCount} {t.runsCount === 1 ? 'run' : 'runs'}
                            </span>
                          </div>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
          </div>

          {/* Collapsed rail (lg only) — one language glyph per workbook */}
          {listCollapsed && (
            <div className="foundry-scroll hidden min-h-0 flex-1 space-y-1 overflow-y-auto p-1.5 lg:block">
              {transforms.map((t) => {
                const active = t.id === selectedId
                return (
                  <Tooltip key={t.id}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => handleSelect(t.id)}
                        aria-current={active ? 'true' : undefined}
                        aria-label={`${t.name} (${t.language})`}
                        className={cn(
                          'flex h-8 w-8 items-center justify-center rounded border font-mono text-[10px] font-semibold transition-colors',
                          active
                            ? 'border-foreground/40 bg-accent text-foreground'
                            : 'border-border bg-muted/40 text-muted-foreground hover:bg-accent hover:text-foreground',
                        )}
                      >
                        {t.language === 'python' ? 'PY' : t.language === 'javascript' ? 'JS' : 'S'}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent
                      side="right"
                      className="font-mono text-[11px]"
                    >
                      {t.name}
                    </TooltipContent>
                  </Tooltip>
                )
              })}
            </div>
          )}

          {/* List actions */}
          <div
            className={cn(
              'flex shrink-0 flex-col gap-2 border-t border-border p-2.5',
              listCollapsed && 'lg:hidden',
            )}
          >
              <GatedButton
                allowed={canEdit}
                reason="requires editor role"
                variant="outline"
                size="sm"
                onClick={() => setCreateOpen(true)}
                className="w-full justify-center text-xs"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden />
                New workbook
              </GatedButton>
              <GatedButton
                allowed={canEdit}
                reason="requires editor role"
                variant="ghost"
                size="sm"
                onClick={() => seedMutation.mutate()}
                disabled={seedMutation.isPending}
                className="w-full justify-center text-xs"
              >
                {seedMutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  <Sparkles className="h-3.5 w-3.5" aria-hidden />
                )}
                Seed demo workbooks
              </GatedButton>
          </div>
        </aside>

        {/* ── Right: editor column ── */}
        <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Workbook editor">
          {!selectedTransform ? (
            <EmptyWorkbookState
              canEdit={canEdit}
              onCreate={() => setCreateOpen(true)}
              onSeed={() => seedMutation.mutate()}
              seeding={seedMutation.isPending}
            />
          ) : (
            <WorkbookEditor
              key={selectedTransform.id}
              transform={selectedTransform}
              detail={detailQuery.data ?? null}
              detailLoading={detailQuery.isLoading}
              detailError={detailQuery.error instanceof Error ? detailQuery.error.message : null}
              datasets={datasets}
              canEdit={canEdit}
              onDeleted={handleDeleted}
            />
          )}
        </section>
      </div>

      <NewWorkbookDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        datasets={datasets}
        onCreated={(id) => setRawSelectedId(id)}
      />
    </div>
  )
}

// ── Empty state ──────────────────────────────────────────────────────

function EmptyWorkbookState({
  canEdit,
  onCreate,
  onSeed,
  seeding,
}: {
  canEdit: boolean
  onCreate: () => void
  onSeed: () => void
  seeding: boolean
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 rounded-lg border border-dashed border-border bg-muted/30 p-8 text-center sm:p-12">
      <span className="flex h-14 w-14 items-center justify-center rounded-xl border border-border bg-muted/50">
        <SquareCode className="h-7 w-7 text-muted-foreground" aria-hidden />
      </span>
      <div className="max-w-lg">
        <p className="text-base font-medium text-foreground">No code workbooks yet</p>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Workbooks are code-first pipelines. Pick the flavor that fits the job:
        </p>
      </div>
      <div className="grid w-full max-w-3xl grid-cols-1 gap-3 text-left sm:grid-cols-3">
        <div className="rounded-md border border-border bg-card p-4">
          <LanguageBadge language="sql" />
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            Write a <span className="font-mono text-foreground">SELECT</span> against real
            tables named after your datasets. Best for joins and aggregations.
          </p>
        </div>
        <div className="rounded-md border border-border bg-card p-4">
          <LanguageBadge language="javascript" />
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            JavaScript body receiving{' '}
            <span className="font-mono text-amber-600 dark:text-amber-400">function(input)</span>. Best for custom
            row-level logic and flags.
          </p>
        </div>
        <div className="rounded-md border border-border bg-card p-4">
          <LanguageBadge language="python" />
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            Python module defining{' '}
            <span className="font-mono text-violet-600 dark:text-violet-300">transform(input)</span>. Best for richer
            logic — loops, sorting, scoring.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <GatedButton
          allowed={canEdit}
          reason="requires editor role"
          onClick={onSeed}
          disabled={seeding}
        >
          {seeding ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Sparkles className="h-4 w-4" aria-hidden />
          )}
          Seed demo workbooks
        </GatedButton>
        <GatedButton
          allowed={canEdit}
          reason="requires editor role"
          variant="outline"
          onClick={onCreate}
        >
          <Plus className="h-4 w-4" aria-hidden />
          New workbook
        </GatedButton>
      </div>
    </div>
  )
}

// ── Editor (remounts per workbook via key) ───────────────────────────

function WorkbookEditor({
  transform,
  detail,
  detailLoading,
  detailError,
  datasets,
  canEdit,
  onDeleted,
}: {
  transform: TransformSummary
  detail: TransformDetailResponse | null
  detailLoading: boolean
  detailError: string | null
  datasets: DatasetSummary[]
  canEdit: boolean
  onDeleted: () => void
}) {
  const queryClient = useQueryClient()
  const [draftCode, setDraftCode] = useState(transform.sourceCode)
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameValue, setRenameValue] = useState(transform.name)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<'preview' | 'logs' | 'history'>('preview')
  const [result, setResult] = useState<TransformRunResponse | null>(null)
  const [resultsOpen, setResultsOpen] = useState(true)
  const [, setFocus] = useFocusMode()

  const dirty = draftCode !== transform.sourceCode

  // Schema of the input datasets — feeds Monaco's schema-aware SQL
  // IntelliSense (tables named after datasets + real columns).
  const schemaQuery = useQuery<SchemaTable[]>({
    queryKey: ['transform-input-schema', transform.id],
    queryFn: async () => {
      const tables = await Promise.all(
        transform.inputs.map(async (inp): Promise<SchemaTable | null> => {
          if (!inp.datasetId || !inp.datasetName) return null
          try {
            const d = await apiJson<DatasetDetailResponse>(`/api/datasets/${inp.datasetId}`)
            return {
              name: inp.datasetName,
              columns: d.current.schema.map((c) => ({ name: c.name, type: c.type })),
            }
          } catch {
            return null
          }
        }),
      )
      return tables.filter((t): t is SchemaTable => t !== null)
    },
    enabled: transform.inputs.length > 0,
    staleTime: 60_000,
  })

  const runsQuery = useQuery<TransformRunsListResponse>({
    queryKey: ['transform-runs', transform.id],
    queryFn: () =>
      apiJson<TransformRunsListResponse>(`/api/transforms/${transform.id}/runs?limit=20`),
  })

  // The run shown in Preview/Logs: the fresh in-memory run, else the latest
  // run from the detail payload.
  const displayedRun: TransformRunSummary | null =
    result?.run ?? detail?.runs[0] ?? null
  const hasPreviewRows = !!result && result.preview.length >= 0 && result.run.status === 'success'

  // Output dataset chip — resolve the id from the latest successful run and
  // the display name from the datasets cache.
  const outputDatasetId =
    (result?.run.status === 'success' ? result.run.outputDatasetId : null) ??
    detail?.runs.find((r) => r.status === 'success' && r.outputDatasetId)?.outputDatasetId ??
    null
  const outputDataset = datasets.find((d) => d.id === outputDatasetId) ?? null

  const invalidateAfterChange = (id: string) => {
    queryClient.invalidateQueries({ queryKey: ['transform', id] })
    queryClient.invalidateQueries({ queryKey: ['transforms'] })
    queryClient.invalidateQueries({ queryKey: ['transform-runs', id] })
    queryClient.invalidateQueries({ queryKey: ['datasets'] })
    queryClient.invalidateQueries({ queryKey: ['stats'] })
  }

  const runMutation = useMutation({
    // Save-then-run (pipeline-builder convention): run always executes the
    // SAVED source code, so flush a dirty draft first.
    mutationFn: async () => {
      if (dirty) {
        await apiSend<TransformDetailResponse>(`/api/transforms/${transform.id}`, 'PATCH', {
          sourceCode: draftCode,
        })
      }
      return apiSend<TransformRunResponse>(`/api/transforms/${transform.id}/run`, 'POST')
    },
    onSuccess: (res) => {
      setResult(res)
      if (res.run.status === 'success') {
        setActiveTab('preview')
        toast.success('Run succeeded', {
          description: `${(res.run.rowCount ?? 0).toLocaleString()} rows → ${transform.outputDatasetName}`,
        })
      } else {
        setActiveTab('logs')
        toast.error('Run failed', {
          description: res.run.error ?? 'Check the Logs tab for details.',
        })
      }
      invalidateAfterChange(transform.id)
    },
    onError: (err) => toastApiError(err, 'Run request failed'),
  })

  const saveMutation = useMutation({
    mutationFn: () =>
      apiSend<TransformDetailResponse>(`/api/transforms/${transform.id}`, 'PATCH', {
        sourceCode: draftCode,
      }),
    onSuccess: () => {
      toast.success('Workbook saved', { description: transform.name })
      invalidateAfterChange(transform.id)
    },
    onError: (err) => toastApiError(err, 'Save failed'),
  })

  const renameMutation = useMutation({
    mutationFn: (name: string) =>
      apiSend<TransformDetailResponse>(`/api/transforms/${transform.id}`, 'PATCH', { name }),
    onSuccess: () => {
      toast.success('Workbook renamed', { description: renameValue.trim() })
      setRenameOpen(false)
      invalidateAfterChange(transform.id)
    },
    onError: (err) => toastApiError(err, 'Rename failed'),
  })

  const deleteMutation = useMutation({
    mutationFn: () => apiSend<{ ok: boolean }>(`/api/transforms/${transform.id}`, 'DELETE'),
    onSuccess: () => {
      toast.success('Workbook deleted', { description: `${transform.name} — runs and history removed` })
      setDeleteOpen(false)
      queryClient.invalidateQueries({ queryKey: ['transforms'] })
      queryClient.invalidateQueries({ queryKey: ['datasets'] })
      onDeleted()
    },
    onError: (err) => toastApiError(err, 'Delete failed'),
  })

  const run = () => {
    if (!canEdit || runMutation.isPending) return
    setResultsOpen(true) // surface the results sheet the moment a run starts
    runMutation.mutate()
  }

  const submitRename = () => {
    const next = renameValue.trim()
    if (!next || next === transform.name || renameMutation.isPending) return
    renameMutation.mutate(next)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* ── Toolbar (h-11): identity + primary actions; everything else moved
          out of the way (R11 Focus Workspace) ── */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <h2 className="min-w-0 truncate text-sm font-medium tracking-tight text-foreground">
          {transform.name}
        </h2>
        <GatedButton
          allowed={canEdit}
          reason="requires editor role"
          variant="ghost"
          size="icon"
          aria-label={`Rename ${transform.name}`}
          onClick={() => {
            setRenameValue(transform.name)
            setRenameOpen(true)
          }}
          className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
        >
          <Pencil className="h-3 w-3" aria-hidden />
        </GatedButton>
        <LanguageBadge language={transform.language} />
        {outputDatasetId ? (
          <Link
            href={`/datasets/${outputDatasetId}`}
            className="hidden max-w-[200px] items-center gap-1.5 rounded border border-border bg-muted/60 px-1.5 py-px font-mono text-[10px] text-muted-foreground transition-colors hover:text-foreground md:inline-flex"
            title={`Output dataset: ${outputDataset?.name ?? transform.outputDatasetName}`}
          >
            <Database className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
            <span className="truncate">
              {outputDataset?.name ?? transform.outputDatasetName}
            </span>
          </Link>
        ) : (
          <span className="hidden items-center gap-1.5 rounded border border-border bg-muted/40 px-1.5 py-px font-mono text-[10px] text-muted-foreground md:inline-flex">
            <Database className="h-3 w-3 shrink-0" aria-hidden />
            {transform.outputDatasetName}
          </span>
        )}
        {dirty && (
          <span className="shrink-0 font-mono text-[10px] text-amber-600 dark:text-amber-400" aria-live="polite">
            ● modified
          </span>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <span className="hidden font-mono text-[10px] text-muted-foreground/80 xl:inline">
            {draftCode.length.toLocaleString()} chars · ⌘↵ run · ⌘S save
          </span>
          <button
            type="button"
            onClick={() => setFocus(true)}
            aria-label="Focus mode — hide app chrome (Esc exits)"
            title="Focus mode (Esc exits)"
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Maximize2 className="h-3.5 w-3.5" aria-hidden />
          </button>
          <GatedButton
            allowed={canEdit}
            reason="requires editor role"
            variant="outline"
            size="sm"
            onClick={() => saveMutation.mutate()}
            disabled={!dirty || saveMutation.isPending || runMutation.isPending}
            className="h-8 gap-1.5 text-xs"
            aria-label="Save workbook"
          >
            {saveMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <Save className="h-3.5 w-3.5" aria-hidden />
            )}
            Save
          </GatedButton>
          <GatedButton
            allowed={canEdit}
            reason="requires editor role"
            size="sm"
            onClick={run}
            disabled={runMutation.isPending || saveMutation.isPending}
            className="relative h-8 gap-1.5 text-xs"
            aria-label="Run workbook"
          >
            {runMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <Play className="h-3.5 w-3.5" aria-hidden />
            )}
            Run
            {runMutation.isPending && (
              <span className="absolute -right-1 -top-1 flex h-2.5 w-2.5" aria-hidden>
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-75" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full border border-background bg-emerald-500" />
              </span>
            )}
          </GatedButton>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="More workbook actions"
                className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <MoreHorizontal className="h-4 w-4" aria-hidden />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => {
                  setRenameValue(transform.name)
                  setRenameOpen(true)
                }}
                className="gap-2 text-xs"
              >
                <PencilLine className="h-3.5 w-3.5" aria-hidden />
                Rename…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {canEdit ? (
                <DropdownMenuItem
                  onClick={() => setDeleteOpen(true)}
                  className="gap-2 text-xs text-rose-600 focus:text-rose-600 dark:text-rose-400 dark:focus:text-rose-400"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  Delete workbook
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem disabled className="gap-2 text-xs text-muted-foreground/70">
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  Delete workbook — requires editor role
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* ── Inputs strip — one line, horizontally scrollable; the language
          contract hides behind the info glyph ── */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5">
        <span className="shrink-0 font-mono text-[9px] font-semibold uppercase tracking-[0.25em] text-muted-foreground/80">
          in
        </span>
        <div className="foundry-scroll flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto whitespace-nowrap">
          {transform.inputs.length === 0 && (
            <span className="font-mono text-[11px] text-muted-foreground/80">no inputs configured</span>
          )}
          {transform.inputs.map((inp) =>
            inp.datasetName ? (
              <Link
                key={inp.datasetId}
                href={`/datasets/${inp.datasetId}`}
                className="inline-flex max-w-[200px] shrink-0 items-center gap-1.5 rounded border border-border bg-card px-1.5 py-px font-mono text-[11px] text-foreground transition-colors hover:bg-accent"
              >
                <Database className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
                <span className="truncate">{inp.datasetName}</span>
              </Link>
            ) : (
              <span
                key={inp.datasetId}
                className="inline-flex shrink-0 items-center gap-1.5 rounded border border-border bg-muted/60 px-1.5 py-px font-mono text-[11px] text-muted-foreground/80"
                title="The input dataset was deleted"
              >
                <Database className="h-3 w-3 shrink-0" aria-hidden />
                deleted dataset
              </span>
            ),
          )}
        </div>
        <button
          type="button"
          aria-label={`Language contract: ${EDITOR_NOTE[transform.language]}`}
          title={EDITOR_NOTE[transform.language]}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
        >
          <Info className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>

      {/* ── Code area — the star of the workbench: a real Monaco editor that
          fills every remaining pixel (highlighting, IntelliSense, minimap) ── */}
      <div className="flex min-h-[240px] flex-1 flex-col overflow-hidden lg:min-h-0">
        <CodeEditor
          value={draftCode}
          onChange={setDraftCode}
          language={transform.language}
          onRun={run}
          onSave={() => {
            if (canEdit && dirty && !saveMutation.isPending) saveMutation.mutate()
          }}
          readOnly={!canEdit}
          schemaTables={schemaQuery.data ?? []}
          ariaLabel={`${EDITOR_FILE[transform.language]} — ${transform.name}`}
          className="min-h-[240px] lg:min-h-0 lg:flex-1"
        />
      </div>

      {/* ── Results — collapsible bottom sheet (42% of the workbench on lg) ── */}
      <div
        className={cn(
          'flex shrink-0 flex-col border-t border-border',
          resultsOpen && 'lg:h-[42%]',
        )}
      >
        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as 'preview' | 'logs' | 'history')}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border px-2.5">
            <TabsList className="h-7 gap-0.5 bg-transparent p-0">
              <TabsTrigger
                value="preview"
                className="h-7 gap-1.5 rounded-md px-2.5 text-[11px] data-[state=active]:text-foreground"
              >
                <Table2 className="h-3 w-3" aria-hidden />
                Preview
              </TabsTrigger>
              <TabsTrigger
                value="logs"
                className="h-7 gap-1.5 rounded-md px-2.5 text-[11px] data-[state=active]:text-foreground"
              >
                <ScrollText className="h-3 w-3" aria-hidden />
                Logs
              </TabsTrigger>
              <TabsTrigger
                value="history"
                className="h-7 gap-1.5 rounded-md px-2.5 text-[11px] data-[state=active]:text-foreground"
              >
                <History className="h-3 w-3" aria-hidden />
                Run history
              </TabsTrigger>
            </TabsList>
            <div className="ml-auto flex items-center gap-2">
              {runMutation.isPending && (
                <span className="flex items-center gap-1 font-mono text-[10px] text-amber-600 dark:text-amber-400">
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                  running…
                </span>
              )}
              <button
                type="button"
                onClick={() => setResultsOpen(!resultsOpen)}
                aria-label={resultsOpen ? 'Collapse results panel' : 'Expand results panel'}
                aria-expanded={resultsOpen}
                className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {resultsOpen ? (
                  <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                ) : (
                  <ChevronUp className="h-3.5 w-3.5" aria-hidden />
                )}
              </button>
            </div>
          </div>

          {/* Preview */}
          <TabsContent
            value="preview"
            className={cn('min-h-0 flex-1 overflow-y-auto p-3', !resultsOpen && 'hidden')}
          >
            {runMutation.isPending ? (
              <div className="flex h-40 items-center justify-center gap-2 rounded-md border border-border bg-muted/40 font-mono text-xs text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin text-amber-600 dark:text-amber-400" aria-hidden />
                running workbook…
              </div>
            ) : hasPreviewRows && result ? (
              <PreviewTable result={result} outputName={transform.outputDatasetName} />
            ) : displayedRun ? (
              <div className="flex h-40 flex-col items-center justify-center gap-2 rounded-md border border-border bg-muted/40 p-4 text-center">
                <Table2 className="h-5 w-5 text-muted-foreground" aria-hidden />
                <p className="text-xs text-muted-foreground">
                  Latest run: <span className="font-mono">{displayedRun.status}</span>
                  {displayedRun.rowCount !== null &&
                    ` · ${displayedRun.rowCount.toLocaleString()} rows published`}
                </p>
                <p className="font-mono text-[10px] text-muted-foreground/80">
                  press Run to materialize a fresh preview
                </p>
              </div>
            ) : (
              <div className="flex h-40 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border bg-muted/30 p-4 text-center">
                <Table2 className="h-5 w-5 text-muted-foreground" aria-hidden />
                <p className="text-xs text-muted-foreground">
                  No results yet — press <span className="font-mono text-foreground">Run</span> to
                  execute the workbook.
                </p>
              </div>
            )}
          </TabsContent>

          {/* Logs */}
          <TabsContent
            value="logs"
            className={cn('min-h-0 flex-1 overflow-y-auto p-3', !resultsOpen && 'hidden')}
          >
            {displayedRun ? (
              <div>
                <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <StatusDot status={displayedRun.status} className="h-1.5 w-1.5" />
                    run {displayedRun.id.slice(0, 8)}
                  </span>
                  <span>
                    {formatRelative(displayedRun.startedAt)} ·{' '}
                    {displayedRun.durationMs !== null ? `${displayedRun.durationMs}ms` : '—'}
                  </span>
                  {displayedRun.error && (
                    <span className="truncate text-rose-600 dark:text-rose-400" title={displayedRun.error}>
                      {displayedRun.error}
                    </span>
                  )}
                </div>
                <LogViewer
                  key={displayedRun.id}
                  logs={displayedRun.logs ?? []}
                  maxHeightClass="max-h-[280px] lg:max-h-none"
                  ariaLabel="Workbook run logs"
                />
              </div>
            ) : (
              <div className="flex h-40 items-center justify-center rounded-md border border-dashed border-border bg-muted/30 text-xs text-muted-foreground">
                No runs yet — logs will appear here after the first run.
              </div>
            )}
          </TabsContent>

          {/* Run history */}
          <TabsContent
            value="history"
            className={cn('min-h-0 flex-1 overflow-y-auto p-3', !resultsOpen && 'hidden')}
          >
            <div className="foundry-scroll max-h-96 overflow-y-auto rounded-md border border-border bg-card lg:max-h-none">
              {detailError ? (
                <p className="p-6 text-center text-xs text-rose-600 dark:text-rose-400">{detailError}</p>
              ) : runsQuery.isLoading || (detailLoading && !detail) ? (
                <div className="space-y-2 p-3">
                  {[0, 1, 2].map((i) => (
                    <Skeleton key={i} className="h-10 w-full" />
                  ))}
                </div>
              ) : (runsQuery.data?.runs.length ?? 0) === 0 ? (
                <p className="p-6 text-center text-xs text-muted-foreground">
                  No runs recorded for this workbook.
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {(runsQuery.data?.runs ?? []).map((r) => (
                    <li
                      key={r.id}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 transition-colors hover:bg-accent/50"
                    >
                      <StatusDot status={r.status} />
                      <span
                        className={cn(
                          'font-mono text-[11px] font-medium',
                          r.status === 'success' && 'text-emerald-600 dark:text-emerald-400',
                          r.status === 'failed' && 'text-rose-600 dark:text-rose-400',
                          r.status === 'running' && 'text-amber-600 dark:text-amber-400',
                        )}
                      >
                        {r.status}
                      </span>
                      <span className="font-mono text-[11px] text-muted-foreground" title={r.startedAt}>
                        {formatRelative(r.startedAt)}
                      </span>
                      <span className="font-mono text-[11px] text-muted-foreground/80">
                        {r.durationMs !== null ? `${r.durationMs}ms` : '—'}
                      </span>
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {r.rowCount !== null ? `${r.rowCount.toLocaleString()} rows` : '—'}
                      </span>
                      {r.outputVersionNumber !== null && (
                        <span className="rounded border border-border bg-muted px-1 font-mono text-[10px] text-muted-foreground">
                          v{r.outputVersionNumber}
                        </span>
                      )}
                      {r.error && (
                        <span
                          className="ml-auto max-w-[280px] truncate font-mono text-[10px] text-rose-600/90 dark:text-rose-400/80"
                          title={r.error}
                        >
                          {r.error}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </div>

      {/* Rename dialog */}
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base text-foreground">Rename workbook</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              The output dataset name stays unchanged.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="rename-input" className="text-xs text-muted-foreground">
              Name
            </Label>
            <Input
              id="rename-input"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitRename()
              }}
              className="h-8 text-sm"
            />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" size="sm" onClick={() => setRenameOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={submitRename}
              disabled={!renameValue.trim() || renameMutation.isPending}
            >
              {renameMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : null}
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base text-foreground">
              Delete “{transform.name}”?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-sm text-muted-foreground">
              This permanently deletes the workbook. All runs and history are removed. The output
              dataset (if published) stays in the catalog.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
              className="bg-rose-600 text-white hover:bg-rose-600/90 dark:bg-rose-500 dark:hover:bg-rose-500/90"
            >
              {deleteMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Trash2 className="h-4 w-4" aria-hidden />
              )}
              Delete workbook
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ── Preview table ────────────────────────────────────────────────────

function PreviewTable({
  result,
  outputName,
}: {
  result: TransformRunResponse
  outputName: string
}) {
  const columns = result.schema
  const rows = result.preview
  const typeByName = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of columns) m.set(c.name, c.type)
    return m
  }, [columns])

  const renderCell = (value: unknown, colName: string) => {
    if (value === null || value === undefined || value === '') {
      return <span className="text-muted-foreground/60">∅</span>
    }
    const type = typeByName.get(colName)
    if (typeof value === 'boolean' || type === 'boolean') {
      return (
        <span className={value ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}>{String(value)}</span>
      )
    }
    if (typeof value === 'number' || type === 'number') {
      const n = typeof value === 'number' ? value : Number(value)
      return <span className="tabular-nums">{Number.isNaN(n) ? String(value) : n.toLocaleString()}</span>
    }
    return String(value)
  }

  return (
    <div className="rounded-md border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <p className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
          <Braces className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          output → <span className="text-foreground">{outputName}</span>
          {result.run.outputVersionNumber !== null && (
            <span className="rounded border border-border bg-muted px-1 text-[10px] text-muted-foreground">
              v{result.run.outputVersionNumber}
            </span>
          )}
        </p>
        <p className="font-mono text-[10px] text-muted-foreground">
          showing {rows.length} of {(result.run.rowCount ?? rows.length).toLocaleString()} rows ·{' '}
          {result.run.durationMs !== null ? `${result.run.durationMs}ms` : '—'}
        </p>
      </div>
      <div className="foundry-scroll max-h-80 overflow-auto lg:max-h-none">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-card">
            <TableRow className="border-border hover:bg-transparent">
              {columns.map((col) => (
                <TableHead
                  key={col.name}
                  className={cn(
                    'h-8 whitespace-nowrap px-3 font-mono text-[11px] text-muted-foreground',
                    col.type === 'number' && 'text-right',
                  )}
                >
                  {col.name}
                  <span className="ml-1 text-muted-foreground/70">
                    {col.type === 'number' ? '#' : col.type === 'boolean' ? '⌥' : 'A'}
                  </span>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, i) => (
              <TableRow key={i} className="border-border hover:bg-accent/50">
                {columns.map((col) => (
                  <TableCell
                    key={col.name}
                    className={cn(
                      'whitespace-nowrap px-3 py-1.5 font-mono text-xs text-foreground',
                      col.type === 'number' && 'text-right tabular-nums',
                    )}
                  >
                    {renderCell(row[col.name], col.name)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
