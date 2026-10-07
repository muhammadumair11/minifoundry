'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from '@/components/link'
import { useParams, useSearchParams } from '@/lib/next-navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { format, formatDistanceToNow, parseISO } from 'date-fns'
import {
  Archive,
  ArrowLeftRight,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Database,
  Download,
  FolderKanban,
  GitBranch,
  GitMerge,
  History,
  Loader2,
  MessageSquare,
  Search,
  ShieldCheck,
  Sparkles,
  SquareCode,
  Table2,
  Upload,
  Workflow,
  Zap,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { apiJson, apiSend, toastApiError } from '@/lib/foundry-api'
import {
  MASK_LITERAL,
  shortId,
  type DatasetDetailResponse,
  type LineageGraph,
  type MarkingsListResponse,
  type PruneResponse,
  type ProjectsListResponse,
  type RowsResponse,
  type SessionResponse,
  type VersionProvenance,
} from '@/lib/foundry-types'
import { MarkingChip } from '@/components/foundry/governance/marking-colors'
import { GatedButton } from '@/components/foundry/governance/gated-button'
import DatasetBranchBar from '@/components/foundry/dataset-branch-bar'
import DatasetQualityPanel from '@/components/foundry/dataset-quality-panel'
import DatasetDiffPanel from '@/components/foundry/dataset-diff-panel'
import DatasetPublicationBanner from '@/components/foundry/dataset-publication-banner'
import DatasetAclButton from '@/components/foundry/dataset-acl-button'
import DatasetWatchButton from '@/components/foundry/dataset-watch-button'
import DatasetDiscussion from '@/components/foundry/dataset-discussion'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

const PAGE_SIZE = 50

/** Retention choices (M2): keep newest N versions; 0 = unlimited. */
const RETENTION_CHOICES = [5, 10, 20, 50, 0] as const

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(t)
  }, [value, delayMs])
  return debounced
}

function renderCellValue(value: unknown, type: string | undefined): React.ReactNode {
  if (value === null || value === undefined || value === '') {
    return <span className="text-muted-foreground/60">∅</span>
  }
  if (value === MASK_LITERAL) {
    return <span className="italic text-muted-foreground/80">{MASK_LITERAL}</span>
  }
  if (typeof value === 'boolean' || type === 'boolean') {
    return (
      <span className={value ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}>
        {String(value)}
      </span>
    )
  }
  if (typeof value === 'number') {
    return <span className="tabular-nums">{value.toLocaleString()}</span>
  }
  return String(value)
}

/** Per-version provenance icon (shape reads at a glance in the timeline). */
const PROVENANCE_ICONS: Record<VersionProvenance['kind'], typeof Upload> = {
  ingestion: Upload,
  pipeline: Workflow,
  transform: SquareCode,
  action: Zap,
  merge: GitMerge,
  seed: Sparkles,
  unknown: CircleDot,
}

/** Human-readable version writer ("Pipeline — Shipment Overview") with a
 *  deep link when one exists; falls back to the raw short id. */
function ProvenanceLabel({ provenance, createdBy }: { provenance?: VersionProvenance | null; createdBy: string | null }) {
  if (!provenance) {
    return <span title={createdBy ?? undefined}>by {shortId(createdBy, 10)}</span>
  }
  const Icon = PROVENANCE_ICONS[provenance.kind] ?? CircleDot
  const content = (
    <span className="inline-flex max-w-full items-center gap-1" title={`${provenance.label}${provenance.detail ? ` (${provenance.detail})` : ''} · ${createdBy ?? ''}`}>
      <Icon className="h-3 w-3 shrink-0 text-muted-foreground/80" aria-hidden />
      <span className="truncate">{provenance.label}</span>
    </span>
  )
  if (provenance.href) {
    return (
      <Link
        href={provenance.href}
        className="max-w-[240px] truncate text-foreground/90 underline-offset-2 hover:underline"
      >
        {content}
      </Link>
    )
  }
  return <span className="max-w-[240px] truncate">{content}</span>
}

export default function DatasetDetailPage() {
  const params = useParams<{ id: string }>()
  const id = params.id

  const searchParams = useSearchParams()
  const linkedVersion = Number(searchParams.get('version'))
  const [selectedVersion, setSelectedVersion] = useState<number | null>(
    Number.isInteger(linkedVersion) && linkedVersion > 0 ? linkedVersion : null,
  )
  const [page, setPage] = useState(1)
  const [searchInput, setSearchInput] = useState('')
  const searchQuery = useDebouncedValue(searchInput, 400)

  // R14 branches: checked-out branch ('main' or a branch name), mirrored in
  // the ?branch= query param via shallow history.replaceState (no navigation).
  // URL param is the source of truth on first render; switches set a local
  // override so no effect/extra render pass is needed.
  const urlBranch = searchParams.get('branch')
  const [branchOverride, setBranchOverride] = useState<string | null>(null)
  const branch = branchOverride ?? urlBranch ?? 'main'
  const setBranch = (next: string) => {
    setBranchOverride(next === (urlBranch ?? 'main') ? null : next)
    setSelectedVersion(null)
    setPage(1)
    try {
      const url = new URL(window.location.href)
      if (next === 'main') url.searchParams.delete('branch')
      else url.searchParams.set('branch', next)
      url.searchParams.delete('version')
      window.history.replaceState(null, '', url.toString())
    } catch {
      /* ignore */
    }
  }

  const detailQuery = useQuery<DatasetDetailResponse>({
    queryKey: ['dataset', id, branch],
    queryFn: async () => {
      const qs = branch !== 'main' ? `?branch=${encodeURIComponent(branch)}` : ''
      const res = await fetch(`/api/datasets/${id}${qs}`)
      if (!res.ok) throw new Error('Failed to load dataset')
      return res.json()
    },
  })

  // Effective version: falls back to the branch head (`current`) while nothing
  // is picked — `current` resolves to the checked-out branch's head version.
  const fallbackVersion =
    detailQuery.data?.current?.versionNumber ?? detailQuery.data?.versions[0]?.versionNumber ?? 1
  const version = selectedVersion ?? fallbackVersion

  const rowsQuery = useQuery<RowsResponse>({
    queryKey: ['dataset-rows', id, version, page, searchQuery, branch],
    queryFn: async () => {
      const q = new URLSearchParams({
        version: String(version),
        page: String(page),
        pageSize: String(PAGE_SIZE),
      })
      if (searchQuery.trim()) q.set('query', searchQuery.trim())
      if (branch !== 'main') q.set('branch', branch)
      const res = await fetch(`/api/datasets/${id}/rows?${q.toString()}`)
      if (!res.ok) throw new Error('Failed to load rows')
      return res.json()
    },
    placeholderData: (prev) => prev,
  })

  const lineageQuery = useQuery<LineageGraph>({
    queryKey: ['lineage'],
    queryFn: async () => {
      const res = await fetch('/api/lineage')
      if (!res.ok) throw new Error('Failed to load lineage')
      return res.json()
    },
  })

  // Marking name → color (shared ['markings'] cache with the governance page).
  const markingsQuery = useQuery<MarkingsListResponse>({
    queryKey: ['markings'],
    queryFn: () => apiJson<MarkingsListResponse>('/api/markings'),
  })

  // Role gate for the retention card (M2 prune is editor+).
  const sessionQuery = useQuery<SessionResponse>({
    queryKey: ['session'],
    queryFn: () => apiJson<SessionResponse>('/api/session'),
    staleTime: 30_000,
  })
  const canEdit = sessionQuery.data?.role === 'editor' || sessionQuery.data?.role === 'admin'

  // P4 collaboration: live comment count for the Discussion tab badge. Shares
  // the ['dataset-comments', id] cache with the discussion panel (one fetch).
  const commentCountQuery = useQuery({
    queryKey: ['dataset-comments', id],
    queryFn: () => apiJson<{ comments: unknown[] }>(`/api/datasets/${id}/comments`),
    select: (d) => d.comments.length,
    staleTime: 30_000,
  })
  const markingColorByName = useMemo(() => {
    const map = new Map<string, string>()
    for (const m of markingsQuery.data?.markings ?? []) map.set(m.name, m.color)
    return map
  }, [markingsQuery.data])

  const lineageSummary = useMemo(() => {
    const edges = lineageQuery.data?.edges ?? []
    const upstream = edges.filter((e) => e.to === id).length
    const downstream = edges.filter((e) => e.from === id).length
    return { upstream, downstream, hasAny: upstream + downstream > 0 }
  }, [lineageQuery.data, id])

  const detail = detailQuery.data
  const columns = rowsQuery.data?.columns ?? detail?.current.schema ?? []
  const total = rowsQuery.data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const queryClient = useQueryClient()

  const keepLastN = detail?.dataset.keepLastN
  const retentionValue =
    keepLastN !== undefined && !(RETENTION_CHOICES as readonly number[]).includes(keepLastN)
      ? keepLastN // custom value set outside this UI — shown as an extra option
      : (keepLastN ?? 20)

  const retentionMutation = useMutation({
    mutationFn: async (next: number) => {
      await apiSend(`/api/datasets/${id}`, 'PATCH', { keepLastN: next })
      return next
    },
    onSuccess: (next) => {
      toast.success('Retention updated', {
        description: next === 0 ? 'Keeping all versions (unlimited).' : `Keeping the newest ${next} versions.`,
      })
      queryClient.invalidateQueries({ queryKey: ['dataset', id] })
    },
    onError: (err) => toastApiError(err, 'Could not update retention'),
  })

  const pruneMutation = useMutation({
    mutationFn: () =>
      apiSend<PruneResponse>(`/api/datasets/${id}/prune`, 'POST', {
        ...(keepLastN !== undefined ? { keepLastN } : {}),
      }),
    onSuccess: (res) => {
      toast.success(`Pruned ${res.pruned} old versions · ${res.remaining} remain`, {
        description: 'Older versions beyond keepLastN were removed.',
      })
      queryClient.invalidateQueries({ queryKey: ['dataset', id] })
    },
    onError: (err) => toastApiError(err, 'Prune failed'),
  })

  // Project assignment (M0): ['projects'] cache is shared with /projects + catalog filter.
  const projectsQuery = useQuery<ProjectsListResponse>({ 
    queryKey: ['projects'],
    queryFn: () => apiJson<ProjectsListResponse>('/api/projects'),
  })
  const projectMutation = useMutation({
    mutationFn: (projectId: string | null) =>
      apiSend(`/api/datasets/${id}`, 'PATCH', { projectId }),
    onSuccess: (_res, projectId) => {
      toast.success(projectId ? 'Dataset assigned to project' : 'Dataset unassigned')
      queryClient.invalidateQueries({ queryKey: ['dataset', id] })
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      queryClient.invalidateQueries({ queryKey: ['datasets'] })
    },
    onError: (err) => toastApiError(err, 'Could not assign project'),
  })

  // CSV export (M10): downloads the currently selected version; the session
  // route masks marked columns for the acting role (audited dataset.export).
  const handleExportCsv = () => {
    const url = `/api/datasets/${id}/export${version ? `?version=${version}` : ''}`
    const a = document.createElement('a')
    a.href = url
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
    toast.success('Export started', {
      description: `v${version} CSV — masked columns respect your role.`,
    })
  }

  if (detailQuery.isLoading) {
    return (
      <div className="mx-auto w-full max-w-6xl space-y-4 px-4 py-6 sm:py-8">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-4 w-96" />
        <Skeleton className="h-[420px] w-full" />
      </div>
    )
  }

  if (detailQuery.isError || !detail) {
    return (
      <div className="mx-auto w-full max-w-6xl px-4 py-16 text-center">
        <p className="text-sm text-rose-600 dark:text-rose-400">
          {detailQuery.error instanceof Error ? detailQuery.error.message : 'Dataset not found.'}
        </p>
        <Button asChild variant="outline" className="mt-4">
          <Link href="/datasets">Back to catalog</Link>
        </Button>
      </div>
    )
  }

  const ds = detail.dataset

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:py-8">
      {/* Header (compact Foundry pattern). The action row wraps BELOW the
          title block when the viewport is too narrow for both — never
          squeezing the breadcrumb into stacked text. */}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 flex-[1_1_340px]">
          <div className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
            <Link href="/datasets" className="flex shrink-0 items-center gap-1 hover:text-foreground hover:underline underline-offset-2">
              <Database className="h-3 w-3" aria-hidden />
              Catalog
            </Link>
            <span aria-hidden>/</span>
            <span className="min-w-0 truncate text-foreground" title={ds.name}>{ds.name}</span>
            <span aria-hidden className="shrink-0">/</span>
            <span className="hidden shrink-0 font-mono text-muted-foreground/80 sm:inline">{shortId(ds.id, 12)}</span>
          </div>
          <h1 className="mt-1 truncate text-sm font-medium tracking-tight text-foreground">
            {ds.name}
          </h1>
          {ds.description && (
            <p className="mt-0.5 max-w-2xl truncate text-xs text-muted-foreground">{ds.description}</p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {ds.tags.map((tag) => (
              <Badge
                key={tag}
                variant="outline"
                className="bg-muted px-1.5 py-0 text-[10px] font-normal text-muted-foreground"
              >
                {tag}
              </Badge>
            ))}
            {/* Project assignment chip (M0) — a compact select; viewer sees it read-only. */}
            <Select
              value={ds.projectId ?? 'none'}
              onValueChange={(v) => projectMutation.mutate(v === 'none' ? null : v)}
              disabled={!canEdit || projectMutation.isPending}
            >
              <SelectTrigger
                aria-label="Assign dataset to project"
                title={canEdit ? 'Assign this dataset to a project' : 'Viewing as viewer — assignment is read-only'}
                className="h-6 w-auto gap-1 border-border bg-muted px-1.5 py-0 text-[10px] font-normal text-muted-foreground data-[size=default]:h-6 data-[disabled]:opacity-60"
              >
                <FolderKanban className="h-3 w-3 text-muted-foreground" aria-hidden />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none" className="text-xs text-muted-foreground">
                  Unassigned
                </SelectItem>
                {(projectsQuery.data?.projects ?? []).map((p) => (
                  <SelectItem key={p.id} value={p.id} className="text-xs">
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="ml-1 font-mono text-[11px] text-muted-foreground">
              updated {formatDistanceToNow(parseISO(ds.updatedAt), { addSuffix: true })}
            </span>
          </div>
        </div>

        {/* Branch control + Access + CSV export + version selector (R14/M10) */}
        <div className="flex flex-wrap items-center gap-2 md:ml-auto">
          <DatasetBranchBar datasetId={id} branch={branch} onBranchChange={setBranch} canEdit={canEdit} />
          <DatasetAclButton datasetId={id} canManage={sessionQuery.data?.role === 'admin'} />
          <DatasetWatchButton datasetId={id} />
          <TooltipProvider delayDuration={150}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleExportCsv}
                  className="h-9 text-xs"
                  aria-label={`Export version ${version} as CSV`}
                >
                  <Download className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                  Export CSV
                </Button>
              </TooltipTrigger>
              <TooltipContent className="font-mono text-[11px]">
                Respects column masking for your role
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <Select
            value={String(version)}
            onValueChange={(v) => {
              setSelectedVersion(Number(v))
              setPage(1)
              const url = new URL(window.location.href)
              url.searchParams.set('version', v)
              window.history.replaceState(null, '', url.toString())
            }}
          >
            <SelectTrigger
              aria-label="Select dataset version"
              className="w-[240px] text-sm"
            >
              <SelectValue placeholder="Version" />
            </SelectTrigger>
            <SelectContent>
              {detail.versions.map((v) => (
                <SelectItem key={v.id} value={String(v.versionNumber)} className="font-mono text-xs">
                  v{v.versionNumber} · {v.rowCount.toLocaleString()} rows
                  {v.versionNumber === detail.versions[0]?.versionNumber && (
                    <span className="ml-1.5 text-[10px] text-emerald-600 dark:text-emerald-400">latest</span>
                  )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* P2: publication banner (only when the gate is on and drafts exist) */}
      <div className="mb-4">
        <DatasetPublicationBanner datasetId={id} detail={detail} canEdit={canEdit} />
      </div>

      {/* Lineage strip */}
      <Link
        href={`/lineage?dataset=${ds.id}`}
        className={cn(
          'mb-4 flex items-center justify-between gap-2 rounded-lg border px-3.5 py-2.5 text-xs transition-colors',
          lineageSummary.hasAny
            ? 'border-border bg-card hover:border-foreground/25'
            : 'border-border/60 bg-muted/30',
        )}
      >
        <span className="flex items-center gap-2 text-muted-foreground">
          <GitBranch className="h-3.5 w-3.5" aria-hidden />
          Lineage
        </span>
        {lineageSummary.hasAny ? (
          <span className="font-mono text-foreground">
            ← {lineageSummary.upstream} upstream · {lineageSummary.downstream} downstream →
          </span>
        ) : (
          <span className="text-muted-foreground">
            no edges yet — this dataset is not connected to a pipeline
          </span>
        )}
      </Link>

      {/* Tabs */}
      <Tabs defaultValue="preview">
        {/* P4: five tabs now — keep the list scrollable on narrow screens */}
        <div className="foundry-scroll mb-3 max-w-full overflow-x-auto pb-1">
          <TabsList className="min-w-max">
            <TabsTrigger value="preview" className="gap-1.5 text-xs">
              <Table2 className="h-3.5 w-3.5" aria-hidden />
            Preview
          </TabsTrigger>
          <TabsTrigger value="schema" className="gap-1.5 text-xs">
            <CircleDot className="h-3.5 w-3.5" aria-hidden />
            Schema
          </TabsTrigger>
          <TabsTrigger value="history" className="gap-1.5 text-xs">
            <History className="h-3.5 w-3.5" aria-hidden />
            History
          </TabsTrigger>
          <TabsTrigger value="quality" className="gap-1.5 text-xs">
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
            Quality
          </TabsTrigger>
          <TabsTrigger value="discussion" className="gap-1.5 text-xs">
            <MessageSquare className="h-3.5 w-3.5" aria-hidden />
            Discussion
            {(commentCountQuery.data ?? 0) > 0 && (
              <Badge variant="outline" className="ml-0.5 px-1 py-0 text-[10px] tabular-nums text-muted-foreground">
                {commentCountQuery.data}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>
        </div>

        {/* ── Preview ── */}
        <TabsContent value="preview" className="mt-3">
          <Card>
            <div className="flex flex-col gap-3 border-b border-border p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="relative w-full sm:w-72">
                <Search
                  className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  value={searchInput}
                  onChange={(e) => {
                    setSearchInput(e.target.value)
                    setPage(1)
                  }}
                  placeholder="Search rows…"
                  aria-label="Search rows"
                  className="h-8 pl-8 font-mono text-xs"
                />
              </div>
              <p className="shrink-0 font-mono text-[11px] text-muted-foreground">
                v{version} · {PAGE_SIZE} rows/page
              </p>
            </div>

            {rowsQuery.isLoading ? (
              <div className="space-y-2 p-4">
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <Skeleton key={i} className="h-7 w-full" />
                ))}
              </div>
            ) : rowsQuery.isError ? (
              <div className="p-6 text-center text-sm text-rose-600 dark:text-rose-400">
                {rowsQuery.error instanceof Error ? rowsQuery.error.message : 'Failed to load rows'}
              </div>
            ) : (rowsQuery.data?.rows.length ?? 0) === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground">
                {searchQuery.trim()
                  ? `No rows match “${searchQuery}”.`
                  : 'This version contains no rows.'}
              </div>
            ) : (
              <div className="foundry-scroll max-h-[520px] overflow-auto">
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
                    {rowsQuery.data?.rows.map((row, i) => (
                      <TableRow key={i} className="border-border hover:bg-accent/50">
                        {columns.map((col) => (
                          <TableCell
                            key={col.name}
                            className={cn(
                              'whitespace-nowrap px-3 py-1.5 font-mono text-xs text-foreground',
                              col.type === 'number' && 'text-right tabular-nums',
                            )}
                          >
                            {renderCellValue(row[col.name], col.type)}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            {/* Pagination footer */}
            <div className="flex items-center justify-between gap-2 border-t border-border p-3">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1 || rowsQuery.isFetching}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="h-8 text-xs"
                aria-label="Previous page"
              >
                <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
                Prev
              </Button>
              <p className="font-mono text-[11px] text-muted-foreground">
                page {rowsQuery.data?.page ?? page} of {totalPages} · {total.toLocaleString()} rows
              </p>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages || rowsQuery.isFetching}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className="h-8 text-xs"
                aria-label="Next page"
              >
                Next
                <ChevronRight className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </div>
          </Card>
        </TabsContent>

        {/* ── Schema ── */}
        <TabsContent value="schema" className="mt-3">
          <Card>
            <CardContent className="p-0">
              {columns.length === 0 ? (
                <p className="p-6 text-center text-sm text-muted-foreground">No schema recorded.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {columns.map((col) => (
                    <li key={col.name} className="flex items-center justify-between gap-3 px-4 py-2">
                      <span className="truncate font-mono text-xs text-foreground">{col.name}</span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        {col.markedWith && (
                          <MarkingChip
                            name={col.markedWith}
                            color={markingColorByName.get(col.markedWith)}
                          />
                        )}
                        <Badge
                          variant="outline"
                          className="shrink-0 border-border bg-muted font-mono text-[10px] text-muted-foreground"
                        >
                          {col.type}
                        </Badge>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── History ── */}
        <TabsContent value="history" className="mt-3">
          {/* R14: version compare (schema + row diff) */}
          <div className="mb-4">
            <DatasetDiffPanel
              datasetId={id}
              versions={detail.versions.map((v) => ({ versionNumber: v.versionNumber, rowCount: v.rowCount }))}
            />
          </div>

          {/* Retention (M2): keepLastN select + manual prune */}
          <div className="mb-4 flex flex-col gap-3 rounded-lg border border-border bg-muted/40 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-start gap-2.5">
              <Archive className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0">
                <p className="text-xs font-medium text-foreground">
                  Version retention{' '}
                  <span className="ml-1 font-mono text-[10px] text-muted-foreground">
                    {keepLastN === 0
                      ? 'unlimited'
                      : `keep last ${keepLastN ?? 20} of ${detail.dataset.versionsCount}`}
                  </span>
                </p>
                <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                  Applies automatically on every new version (ingest, pipeline, transform,
                  action). Pruning never touches the current version.
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Select
                value={String(retentionValue)}
                onValueChange={(v) => retentionMutation.mutate(Number(v))}
              >
                <SelectTrigger
                  aria-label="Retention: keep newest N versions"
                  className="h-8 w-[150px] font-mono text-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RETENTION_CHOICES.map((n) => (
                    <SelectItem key={n} value={String(n)} className="font-mono text-xs">
                      {n === 0 ? 'Unlimited' : `Keep last ${n}`}
                    </SelectItem>
                  ))}
                  {typeof retentionValue === 'number' &&
                    !(RETENTION_CHOICES as readonly number[]).includes(retentionValue) && (
                      <SelectItem value={String(retentionValue)} className="font-mono text-xs">
                        Keep last {retentionValue} (custom)
                      </SelectItem>
                    )}
                </SelectContent>
              </Select>
              <GatedButton
                allowed={canEdit}
                reason="requires editor role"
                size="sm"
                variant="outline"
                onClick={() => pruneMutation.mutate()}
                disabled={pruneMutation.isPending || retentionMutation.isPending}
                className="h-8 text-xs"
              >
                {pruneMutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  <Archive className="h-3.5 w-3.5" aria-hidden />
                )}
                Prune now
              </GatedButton>
            </div>
          </div>

          <Card>
            <CardContent className="p-4">
              <ol className="relative ml-3 space-y-4 border-l border-border pl-6">
                {detail.versions.map((v, idx) => {
                  const isLatest = idx === 0
                  const isSelected = v.versionNumber === version
                  return (
                    <li key={v.id} className="relative">
                      <span
                        aria-hidden
                        className={cn(
                          'absolute -left-[31px] top-0.5 h-3 w-3 rounded-full border-2',
                          isLatest
                            ? 'border-emerald-500 bg-emerald-500/40'
                            : 'border-border bg-muted',
                        )}
                      />
                      <div
                        className={cn(
                          'rounded-md border px-3 py-2 transition-colors',
                          isSelected
                            ? 'border-foreground/25 bg-accent/40'
                            : 'border-border bg-background',
                        )}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedVersion(v.versionNumber)
                              setPage(1)
                            }}
                            className="font-mono text-sm font-medium text-foreground hover:underline underline-offset-2"
                            aria-label={`Show version ${v.versionNumber}`}
                          >
                            v{v.versionNumber}
                          </button>
                          <span className="font-mono text-xs text-emerald-600 dark:text-emerald-400">
                            {v.rowCount.toLocaleString()} rows
                          </span>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] text-muted-foreground">
                          <ProvenanceLabel provenance={v.provenance} createdBy={v.createdBy} />
                          <span title={format(parseISO(v.createdAt), 'MMM d, yyyy HH:mm:ss')}>
                            {format(parseISO(v.createdAt), 'MMM d, HH:mm:ss')}
                          </span>
                          {isLatest && (
                            <span className="rounded border border-emerald-500/40 bg-emerald-500/10 px-1 text-[10px] text-emerald-600 dark:text-emerald-400">
                              latest
                            </span>
                          )}
                          {/* P2: publication lifecycle + quality state chips */}
                          {v.lifecycle === 'draft' && (
                            <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1 text-[10px] text-amber-600 dark:text-amber-400">
                              draft
                            </span>
                          )}
                          {v.versionNumber === detail.dataset.publishedVersion && v.lifecycle !== 'draft' && (
                            <span className="rounded border border-border bg-muted px-1 text-[10px] text-foreground/70">
                              published
                            </span>
                          )}
                          {v.qualityState && v.qualityState !== 'not_evaluated' && (
                            <span
                              className={cn(
                                'rounded border px-1 text-[10px]',
                                v.qualityState === 'passed'
                                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                                  : v.qualityState === 'warned'
                                    ? 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'
                                    : 'border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400',
                              )}
                              title={`quality ${v.qualityState}`}
                            >
                              ● {v.qualityState}
                            </span>
                          )}
                          {(v as { branch?: string }).branch && (v as { branch?: string }).branch !== 'main' && (
                            <span className="rounded border border-border bg-muted px-1 text-[10px] text-muted-foreground">
                              ⎇ {(v as { branch?: string }).branch}
                            </span>
                          )}
                          {isSelected && !isLatest && (
                            <span className="rounded border border-border bg-muted px-1 text-[10px] text-muted-foreground">
                              viewing
                            </span>
                          )}
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ol>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Quality (R14) ── */}
        <TabsContent value="quality" className="mt-3">
          <DatasetQualityPanel
            datasetId={id}
            canEdit={canEdit}
            columns={detail.current?.schema ?? []}
            qualityGate={detail.dataset.qualityGate ?? false}
            publishedVersion={detail.dataset.publishedVersion ?? null}
          />
        </TabsContent>

        {/* ── Discussion (P4 collaboration) ── */}
        <TabsContent value="discussion" className="mt-3">
          <DatasetDiscussion
            datasetId={id}
            currentVersion={version}
            versions={detail.versions.map((v) => v.versionNumber)}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
