'use client'

import { Suspense, useEffect, useMemo, useState } from 'react'
import Link from '@/components/link'
import { useParams, useSearchParams } from '@/lib/next-navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ArrowDown,
  ArrowUpDown,
  ArrowUp,
  BookmarkPlus,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Compass,
  Database,
  Link2,
  ListFilter,
  Lock,
  Play,
  Search,
  X,
  Zap,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { apiJson, apiSend } from '@/lib/foundry-api'
import { MASK_LITERAL } from '@/lib/foundry-types'
import type {
  ActionResponse,
  ObjectDetailResponse,
  ObjectsListResponse,
  OntologyObjectType,
  OntologyListResponse,
  ObjectViewInfo,
  SessionResponse,
} from '@/lib/foundry-types'
import { ActionDialog } from '@/components/foundry/ontology/action-dialog'
import { getObjectColorClasses, OntologyIcon } from '@/components/foundry/ontology/icon-map'

const PAGE_SIZE = 50

// ─── R14.8 saved views: local types + filter helpers ────────────────

type FilterOp = 'eq' | 'neq' | 'contains' | 'gt' | 'lt' | 'gte' | 'lte' | 'in'

interface ViewFilter {
  property: string
  op: FilterOp
  value: string
}

const FILTER_OPS: FilterOp[] = ['eq', 'neq', 'contains', 'gt', 'lt', 'gte', 'lte', 'in']

const OP_LABEL: Record<FilterOp, string> = {
  eq: '=',
  neq: '≠',
  contains: 'contains',
  gt: '>',
  lt: '<',
  gte: '≥',
  lte: '≤',
  in: 'in',
}

/** ObjectLink + the additive R14.8 fields from the detail endpoint. */
interface ObjectLinkWithTotal {
  id: string
  apiName: string
  displayName: string
  direction: 'outgoing' | 'incoming'
  cardinality: string
  toTypeId: string
  toTypeApiName: string
  toTypeDisplayName: string
  toTypeIcon: string | null
  toTypeColor: string | null
  total?: number
  fkProperty?: string | null
  targets: { pk: string; _title: string }[]
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(t)
  }, [value, delayMs])
  return debounced
}

/** Name input + submit for the "Save view" popover (R14.8). */
function SaveViewForm({ onSubmit, pending }: { onSubmit: (name: string) => void; pending: boolean }) {
  const [name, setName] = useState('')
  return (
    <form
      className="mt-2 flex items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault()
        const trimmed = name.trim()
        if (trimmed && !pending) onSubmit(trimmed)
      }}
    >
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="View name — e.g. High risk"
        aria-label="View name"
        className="h-8 flex-1 text-xs"
        maxLength={80}
      />
      <Button type="submit" size="sm" className="h-8 px-2.5 text-xs" disabled={pending || name.trim() === ''}>
        {pending ? 'Saving…' : 'Save'}
      </Button>
    </form>
  )
}

/** Compact value renderer for object cells / property rows. */
function renderValue(value: unknown): React.ReactNode {
  if (value === null || value === undefined || value === '') {
    return <span className="text-muted-foreground/70">∅</span>
  }
  if (value === MASK_LITERAL) {
    return <span className="italic text-muted-foreground/80">{MASK_LITERAL}</span>
  }
  if (typeof value === 'boolean') {
    return <span className={value ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}>{String(value)}</span>
  }
  if (typeof value === 'number') {
    return <span className="tabular-nums">{value.toLocaleString()}</span>
  }
  return String(value)
}

// ─── Action dialog host (fetches ActionDetail for the chosen apiName) ─

function ActiveActionDialog({
  actionApiName,
  prefillPk,
  onClose,
}: {
  actionApiName: string
  prefillPk: string | null
  onClose: () => void
}) {
  const actionQuery = useQuery<ActionResponse>({
    queryKey: ['action', actionApiName],
    queryFn: () => apiJson<ActionResponse>(`/api/actions/${encodeURIComponent(actionApiName)}`),
    enabled: actionApiName !== '',
  })

  useEffect(() => {
    if (actionQuery.isError) {
      toast.error('Could not load action', {
        description:
          actionQuery.error instanceof Error ? actionQuery.error.message : 'Unknown error.',
      })
      onClose()
    }
  }, [actionQuery.isError, actionQuery.error, onClose])

  if (!actionQuery.data) return null

  return (
    <ActionDialog
      action={actionQuery.data.action}
      open
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      prefillPk={prefillPk}
    />
  )
}

// ─── Links section: compact rows + inline related samples (R14.8) ───

function LinkRow({ link, pk }: { link: ObjectLinkWithTotal; pk: string }) {
  const [open, setOpen] = useState(false)
  const total = typeof link.total === 'number' ? link.total : link.targets.length
  const shown = link.targets.slice(0, 5)
  const hiddenCount = Math.max(0, total - shown.length)
  const targetColor = getObjectColorClasses(link.toTypeColor)
  // When the linked type holds the FK, filter its list by this object's PK.
  const viewAllHref =
    link.fkProperty
      ? `/objects/${encodeURIComponent(link.toTypeApiName)}?filters=${encodeURIComponent(
          JSON.stringify([{ property: link.fkProperty, op: 'eq', value: pk }]),
        )}`
      : `/objects/${encodeURIComponent(link.toTypeApiName)}`

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/60"
        title={`${link.toTypeDisplayName}: ${total} related (${link.direction}, ${link.cardinality})`}
      >
        <Link2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate text-xs font-medium text-foreground">{link.toTypeDisplayName}</span>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">({total})</span>
        <span className="shrink-0 font-mono text-[9px] uppercase tracking-wide text-muted-foreground/70">
          {link.direction === 'incoming' ? 'in' : 'out'}
        </span>
        <ChevronDown
          className={cn(
            'ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-180',
          )}
          aria-hidden
        />
      </button>
      {open && (
        <div className="border-l border-border/70 pb-1 pl-6 pr-1">
          {shown.length === 0 ? (
            <p className="py-1.5 text-xs text-muted-foreground/80">no linked objects found</p>
          ) : (
            <ul className="space-y-0.5 pt-1">
              {shown.map((target) => (
                <li key={target.pk}>
                  <Link
                    href={`/objects/${encodeURIComponent(link.toTypeApiName)}?pk=${encodeURIComponent(target.pk)}`}
                    className="flex items-center gap-2 rounded-md px-2 py-1 transition-colors hover:bg-accent/60"
                    title={`Open ${link.toTypeDisplayName} ${target.pk}`}
                  >
                    <span
                      className={cn(
                        'flex h-5 w-5 shrink-0 items-center justify-center rounded border',
                        targetColor.border,
                        targetColor.bg,
                      )}
                    >
                      <OntologyIcon name={link.toTypeIcon} className={cn('h-3 w-3', targetColor.text)} />
                    </span>
                    <span className="truncate text-xs text-foreground">{target._title}</span>
                    <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
                      {target.pk}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {hiddenCount > 0 && (
            <Link
              href={viewAllHref}
              className="mt-1 inline-block px-2 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              View all {total} {link.toTypeDisplayName.toLowerCase()}s →
            </Link>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Right panel: selected object detail ─────────────────────────────

function ObjectDetailPanel({
  typeApiName,
  selectedPk,
  columns,
  titleProperty,
  onClear,
}: {
  typeApiName: string
  selectedPk: string
  columns: ObjectsListResponse['columns']
  titleProperty: string | null
  onClear: () => void
}) {
  const detailQuery = useQuery<ObjectDetailResponse>({
    queryKey: ['object', typeApiName, selectedPk],
    queryFn: () =>
      apiJson<ObjectDetailResponse>(
        `/api/objects/${encodeURIComponent(typeApiName)}/${encodeURIComponent(selectedPk)}`,
      ),
  })

  if (detailQuery.isLoading) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-6 w-3/4 " />
        <Skeleton className="h-4 w-1/3 " />
        <div className="space-y-2 pt-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
      </div>
    )
  }

  if (detailQuery.isError || !detailQuery.data) {
    return (
      <div className="flex flex-col items-start gap-3 p-4">
        <p className="text-sm text-rose-600 dark:text-rose-400">
          {detailQuery.error instanceof Error
            ? detailQuery.error.message
            : 'Failed to load object detail.'}
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={onClear}
          className="text-xs"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
          Clear selection
        </Button>
      </div>
    )
  }

  const { object, links } = detailQuery.data
  const detailColumns =
    columns.length > 0
      ? columns
      : Object.keys(object.values).map((k) => ({
          apiName: k,
          displayName: k,
          dataType: 'string',
          isTitle: false,
          hideInTable: false,
        }))

  return (
    <div className="p-4">
      {/* Title + pk */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-lg font-semibold tracking-tight text-foreground">
            {titleProperty ? renderValue(object.values[titleProperty]) : object.pk}
          </p>
          <p className="mt-1 inline-block rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
            {object.pk}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClear}
          className="h-7 w-7 shrink-0 p-0 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Clear selection"
        >
          <X className="h-4 w-4" aria-hidden />
        </Button>
      </div>

      {/* Properties (hideInTable included here) */}
      <div className="mt-4">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80">
          Properties
        </p>
        <ul className="mt-1.5">
          {detailColumns.map((c) => (
            <li
              key={c.apiName}
              className="flex items-baseline justify-between gap-3 border-b border-border/60 py-1.5"
            >
              <span className="shrink-0 text-xs text-muted-foreground">
                {c.displayName}
                {!c.hideInTable ? '' : <span className="ml-1 text-[9px] text-muted-foreground/70">hidden</span>}
              </span>
              <span
                className={cn(
                  'truncate text-right font-mono text-xs',
                  c.isTitle && object.values[c.apiName] !== MASK_LITERAL
                    ? 'font-semibold text-foreground'
                    : 'text-foreground',
                )}
              >
                {renderValue(object.values[c.apiName])}
                {object._masked?.includes(c.apiName) &&
                  object.values[c.apiName] === MASK_LITERAL && (
                    <Lock
                      className="ml-1 inline h-3 w-3 text-muted-foreground"
                      aria-label="masked by a governance marking"
                    />
                  )}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {/* Links — both directions, compact rows with inline samples */}
      <div className="mt-5 border-t border-border pt-4">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80">Links</p>
        {links.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground/80">No linked objects.</p>
        ) : (
          <div className="mt-1">
            {links.map((rawLink) => {
              const link = rawLink as ObjectLinkWithTotal
              return <LinkRow key={link.id} link={link} pk={String(object.pk)} />
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Workshop view ────────────────────────────────────────────────────

function WorkshopView() {
  const routeParams = useParams<{ type: string }>()
  const typeApiName = routeParams?.type ?? ''
  const searchParams = useSearchParams()
  const actionParam = searchParams.get('action')
  const pkParam = searchParams.get('pk')

  const [searchInput, setSearchInput] = useState('')
  const [page, setPage] = useState(1)
  const [selectedPk, setSelectedPk] = useState<string | null>(null)
  const [activeActionApiName, setActiveActionApiName] = useState<string | null>(null)

  // R14.8: structured filters + sort + saved views.
  const [filters, setFilters] = useState<ViewFilter[]>([])
  const [sortBy, setSortBy] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [activeViewId, setActiveViewId] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const sessionQuery = useQuery<SessionResponse>({
    queryKey: ['session'],
    queryFn: () => apiJson<SessionResponse>('/api/session'),
  })
  const isEditor = sessionQuery.data?.role === 'editor' || sessionQuery.data?.role === 'admin'

  const viewsQuery = useQuery<{ views: ObjectViewInfo[] }>({
    queryKey: ['object-views', typeApiName],
    queryFn: () =>
      apiJson<{ views: ObjectViewInfo[] }>(`/api/objects/views?type=${encodeURIComponent(typeApiName)}`),
    enabled: typeApiName !== '',
  })
  const views = useMemo(() => viewsQuery.data?.views ?? [], [viewsQuery.data])

  const applyView = (v: ObjectViewInfo) => {
    setFilters(v.filters.map((f) => ({ property: f.property, op: f.op as FilterOp, value: f.value })))
    setSortBy(v.sortBy)
    setSortDir(v.sortDir)
    setActiveViewId(v.id)
    setPage(1)
  }

  const clearAll = () => {
    setFilters([])
    setSortBy(null)
    setSortDir('asc')
    setActiveViewId(null)
    setPage(1)
  }

  const saveViewMutation = useMutation({
    mutationFn: (name: string) =>
      apiSend<{ view: ObjectViewInfo }>('/api/objects/views', 'POST', {
        type: typeApiName,
        name,
        filters,
        sortBy,
        sortDir,
      }),
    onSuccess: (res) => {
      toast.success('View saved', {
        description: `“${res.view.name}” is available as a chip on this type.`,
      })
      void queryClient.invalidateQueries({ queryKey: ['object-views', typeApiName] })
      setActiveViewId(res.view.id)
    },
    onError: (err: Error) => toast.error('Could not save view', { description: err.message }),
  })

  const deleteViewMutation = useMutation({
    mutationFn: (viewId: string) =>
      apiSend<void>(`/api/objects/views/${encodeURIComponent(viewId)}`, 'DELETE'),
    onSuccess: (_res, viewId) => {
      if (activeViewId === viewId) clearAll()
      void queryClient.invalidateQueries({ queryKey: ['object-views', typeApiName] })
    },
    onError: (err: Error) => toast.error('Could not delete view', { description: err.message }),
  })

  const debouncedSearch = useDebouncedValue(searchInput, 400)

  // ?pk= → preselect (and type change → reset) by syncing during render.
  const [pkSync, setPkSync] = useState('')
  const pkSignal = `${typeApiName}\u0000${pkParam ?? ''}`
  if (pkSync !== pkSignal) {
    setPkSync(pkSignal)
    setSelectedPk(pkParam)
  }

  // ?action= → auto-open the action dialog once per param value (closing it
  // does not re-open while the URL keeps the same ?action=).
  const [consumedActionParam, setConsumedActionParam] = useState<string | null>(null)
  if (actionParam && actionParam !== consumedActionParam) {
    setConsumedActionParam(actionParam)
    setActiveActionApiName(actionParam)
  }

  // Ontology list — type meta + enabled actions.
  const ontologyQuery = useQuery<OntologyListResponse>({
    queryKey: ['ontology'],
    queryFn: () => apiJson<OntologyListResponse>('/api/ontology'),
  })
  const typeInfo = useMemo(
    () => ontologyQuery.data?.objectTypes.find((t) => t.apiName === typeApiName) ?? null,
    [ontologyQuery.data, typeApiName],
  )
  const enabledActions = useMemo(
    () => (typeInfo?.actions ?? []).filter((a) => a.enabled),
    [typeInfo],
  )

  // Object table (filters/sort applied server-side so totals + pagination
  // reflect the saved view, not just the loaded page).
  const filtersJson = useMemo(() => JSON.stringify(filters), [filters])
  const objectsQuery = useQuery<ObjectsListResponse>({
    queryKey: ['objects', typeApiName, debouncedSearch, page, filtersJson, sortBy, sortDir],
    queryFn: () => {
      const qs = new URLSearchParams({
        type: typeApiName,
        query: debouncedSearch,
        page: String(page),
        pageSize: String(PAGE_SIZE),
      })
      if (filters.length > 0) qs.set('filters', filtersJson)
      if (sortBy) {
        qs.set('sortBy', sortBy)
        qs.set('sortDir', sortDir)
      }
      return apiJson<ObjectsListResponse>(`/api/objects?${qs.toString()}`)
    },
    enabled: typeApiName !== '',
    placeholderData: (prev) => prev,
  })
  const rows = objectsQuery.data?.rows ?? []
  const allColumns = objectsQuery.data?.columns ?? []
  const pkColumn = objectsQuery.data?.objectType.primaryKey ?? null
  // The table already renders a dedicated pk column — drop the property that mirrors it.
  const tableColumns = useMemo(
    () => allColumns.filter((c) => !c.hideInTable && c.apiName !== pkColumn),
    [allColumns, pkColumn],
  )
  const total = objectsQuery.data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / (objectsQuery.data?.pageSize ?? PAGE_SIZE)))
  const titleProperty = objectsQuery.data?.objectType.titleProperty ?? null

  const unknownType = !ontologyQuery.isLoading && !!ontologyQuery.data && !typeInfo

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:py-8">
      {/* a) Type header */}
      <header className="mb-5">
        {ontologyQuery.isLoading ? (
          <div className="flex items-center gap-3">
            <Skeleton className="h-10 w-10 " />
            <div className="space-y-1.5">
              <Skeleton className="h-6 w-40 " />
              <Skeleton className="h-3.5 w-56 " />
            </div>
          </div>
        ) : typeInfo ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-start gap-3">
              <TypeIconBadge type={typeInfo} />
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-2">
                  <h1 className="text-sm font-medium tracking-tight text-foreground">
                    {typeInfo.displayName}
                  </h1>
                  <span className="font-mono text-[11px] text-muted-foreground">{typeInfo.apiName}</span>
                </div>
                <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground">
                  <span>
                    {typeInfo.objectCount ?? '—'} <span className="text-muted-foreground/80">objects</span>
                  </span>
                  {typeInfo.sourceDatasetId && (
                    <Link
                      href={`/datasets/${typeInfo.sourceDatasetId}`}
                      className="inline-flex items-center gap-1 text-foreground hover:underline underline-offset-2"
                    >
                      <Database className="h-3 w-3" aria-hidden />
                      {typeInfo.sourceDatasetName ?? 'dataset'}
                    </Link>
                  )}
                </p>
                {typeInfo.description && (
                  <p className="mt-0.5 max-w-2xl truncate text-xs text-muted-foreground">{typeInfo.description}</p>
                )}
              </div>
            </div>
            {/* Actions menu */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 gap-1.5 text-xs"
                  disabled={enabledActions.length === 0}
                  title={enabledActions.length === 0 ? 'No actions defined for this type' : undefined}
                >
                  <Zap className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                  Actions
                  {enabledActions.length > 0 && (
                    <span className="rounded border border-border bg-muted px-1 font-mono text-[10px] text-muted-foreground">
                      {enabledActions.length}
                    </span>
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {enabledActions.map((a) => (
                  <DropdownMenuItem
                    key={a.id}
                    onSelect={() => setActiveActionApiName(a.apiName)}
                    className="text-xs text-foreground"
                  >
                    <Play className="mr-2 h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                    {a.displayName}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Compass className="h-4 w-4 text-muted-foreground" aria-hidden />
            <h1 className="text-sm font-medium tracking-tight text-foreground">
              {ontologyQuery.isError ? 'Ontology unavailable' : 'Unknown object type'}
            </h1>
          </div>
        )}
      </header>

      {unknownType ? (
        <Card className="border-border bg-card">
          <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
            <p className="text-sm text-muted-foreground">
              No object type with apiName{' '}
              <span className="font-mono text-foreground">{typeApiName}</span>.
            </p>
            <Link
              href="/objects"
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              <Compass className="h-4 w-4" aria-hidden />
              Pick another type
            </Link>
          </CardContent>
        </Card>
      ) : ontologyQuery.isError && !objectsQuery.data ? (
        <Card className="border-border bg-card">
          <CardContent className="p-6 text-center text-sm text-rose-600 dark:text-rose-400">
            {ontologyQuery.error instanceof Error
              ? `Could not load the ontology: ${ontologyQuery.error.message}`
              : 'Could not load the ontology.'}
          </CardContent>
        </Card>
      ) : (
        <div className="mt-4 flex flex-col gap-4 lg:flex-row lg:items-start">
          {/* b) LEFT: object table */}
          <Card className="min-w-0 flex-1 border-border bg-card">
            <CardHeader className="gap-3 border-b border-border p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="text-sm font-semibold text-foreground">
                  Objects
                  {!objectsQuery.isLoading && (
                    <span className="ml-2 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] font-normal text-muted-foreground">
                      {total}
                    </span>
                  )}
                </CardTitle>
                <div className="relative w-full sm:w-64">
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
                    placeholder="Search objects…"
                    aria-label="Search objects"
                    className="h-8 pl-8 text-xs"
                  />
                </div>
              </div>

              {/* R14.8: filters + sort + saved views bar */}
              <div className="flex flex-wrap items-center gap-1.5">
                {/* Filter builder */}
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1.5 px-2 text-[11px]"
                      aria-label="Edit filters"
                    >
                      <ListFilter className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                      Filter
                      {filters.length > 0 && (
                        <span className="rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground">
                          {filters.length}
                        </span>
                      )}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-80 bg-card p-3">
                    <p className="text-xs font-semibold text-foreground">Filters</p>
                    <div className="mt-2 space-y-2">
                      {filters.length === 0 && (
                        <p className="text-[11px] text-muted-foreground">
                          No filters yet — add one to narrow the list.
                        </p>
                      )}
                      {filters.map((f, i) => (
                        <div key={i} className="flex items-center gap-1.5">
                          <Select
                            value={f.property || undefined}
                            onValueChange={(v) => {
                              setFilters((prev) =>
                                prev.map((q, qi) => (qi === i ? { ...q, property: v } : q)),
                              )
                              setActiveViewId(null)
                              setPage(1)
                            }}
                          >
                            <SelectTrigger className="h-7 w-[38%] text-[11px]" aria-label={`Filter ${i + 1} property`}>
                              <SelectValue placeholder="column" />
                            </SelectTrigger>
                            <SelectContent>
                              {(allColumns.length > 0
                                ? allColumns
                                : (typeInfo?.properties ?? [])
                              ).map((c) => (
                                <SelectItem key={c.apiName} value={c.apiName} className="text-[11px]">
                                  {c.displayName}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Select
                            value={f.op}
                            onValueChange={(v) => {
                              setFilters((prev) =>
                                prev.map((q, qi) => (qi === i ? { ...q, op: v as FilterOp } : q)),
                              )
                              setActiveViewId(null)
                              setPage(1)
                            }}
                          >
                            <SelectTrigger className="h-7 w-[30%] text-[11px]" aria-label={`Filter ${i + 1} operator`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {FILTER_OPS.map((op) => (
                                <SelectItem key={op} value={op} className="text-[11px]">
                                  {OP_LABEL[op]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Input
                            value={f.value}
                            onChange={(e) => {
                              setFilters((prev) =>
                                prev.map((q, qi) => (qi === i ? { ...q, value: e.target.value } : q)),
                              )
                              setActiveViewId(null)
                              setPage(1)
                            }}
                            placeholder="value"
                            aria-label={`Filter ${i + 1} value`}
                            className="h-7 min-w-0 flex-1 text-[11px]"
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 shrink-0 p-0 text-muted-foreground hover:text-foreground"
                            aria-label={`Remove filter ${i + 1}`}
                            onClick={() => {
                              setFilters((prev) => prev.filter((_, qi) => qi !== i))
                              setActiveViewId(null)
                              setPage(1)
                            }}
                          >
                            <X className="h-3 w-3" aria-hidden />
                          </Button>
                        </div>
                      ))}
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 w-full text-[11px]"
                        disabled={filters.length >= 12}
                        onClick={() => {
                          setFilters((prev) => [
                            ...prev,
                            { property: allColumns[0]?.apiName ?? typeInfo?.properties[0]?.apiName ?? '', op: 'eq', value: '' },
                          ])
                          setActiveViewId(null)
                          setPage(1)
                        }}
                      >
                        + Add filter
                      </Button>
                    </div>
                  </PopoverContent>
                </Popover>

                {/* Sort */}
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1.5 px-2 text-[11px]"
                      aria-label="Edit sort"
                    >
                      <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                      Sort
                      {sortBy && (
                        <span className="max-w-20 truncate rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground">
                          {sortBy} {sortDir === 'desc' ? '↓' : '↑'}
                        </span>
                      )}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-64 bg-card p-3">
                    <p className="text-xs font-semibold text-foreground">Sort</p>
                    <div className="mt-2 flex items-center gap-1.5">
                      <Select
                        value={sortBy ?? 'none'}
                        onValueChange={(v) => {
                          setSortBy(v === 'none' ? null : v)
                          setActiveViewId(null)
                          setPage(1)
                        }}
                      >
                        <SelectTrigger className="h-7 flex-1 text-[11px]" aria-label="Sort by column">
                          <SelectValue placeholder="Column" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none" className="text-[11px]">
                            Default order
                          </SelectItem>
                          {(allColumns.length > 0 ? allColumns : (typeInfo?.properties ?? [])).map((c) => (
                            <SelectItem key={c.apiName} value={c.apiName} className="text-[11px]">
                              {c.displayName}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {sortBy && (
                        <>
                          <Button
                            variant={sortDir === 'asc' ? 'secondary' : 'outline'}
                            size="sm"
                            className="h-7 w-7 p-0"
                            aria-label="Ascending"
                            aria-pressed={sortDir === 'asc'}
                            onClick={() => {
                              setSortDir('asc')
                              setActiveViewId(null)
                              setPage(1)
                            }}
                          >
                            <ArrowUp className="h-3.5 w-3.5" aria-hidden />
                          </Button>
                          <Button
                            variant={sortDir === 'desc' ? 'secondary' : 'outline'}
                            size="sm"
                            className="h-7 w-7 p-0"
                            aria-label="Descending"
                            aria-pressed={sortDir === 'desc'}
                            onClick={() => {
                              setSortDir('desc')
                              setActiveViewId(null)
                              setPage(1)
                            }}
                          >
                            <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                          </Button>
                        </>
                      )}
                    </div>
                  </PopoverContent>
                </Popover>

                {/* Save view */}
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1.5 px-2 text-[11px]"
                      disabled={!isEditor || (filters.length === 0 && !sortBy)}
                      title={
                        !isEditor
                          ? 'Saving views requires the editor role'
                          : filters.length === 0 && !sortBy
                            ? 'Add a filter or sort first'
                            : 'Save the current filters + sort as a view'
                      }
                    >
                      <BookmarkPlus className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                      Save view
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-64 bg-card p-3">
                    <p className="text-xs font-semibold text-foreground">Save current view</p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {filters.length} filter{filters.length === 1 ? '' : 's'}
                      {sortBy ? ` · sort ${sortBy} ${sortDir}` : ''}
                    </p>
                    <SaveViewForm
                      onSubmit={(name) => {
                        saveViewMutation.mutate(name)
                      }}
                      pending={saveViewMutation.isPending}
                    />
                  </PopoverContent>
                </Popover>

                {/* Active filter chips */}
                {filters.map((f, i) => (
                  <span
                    key={`f-${i}`}
                    className="inline-flex max-w-[180px] items-center gap-1 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[11px] text-foreground"
                  >
                    <span className="truncate">
                      <span className="font-mono text-[10px] text-muted-foreground">{f.property}</span>{' '}
                      {OP_LABEL[f.op]}{' '}
                      <span className="font-mono text-[10px] text-muted-foreground">{f.value || '∅'}</span>
                    </span>
                    <button
                      type="button"
                      aria-label={`Remove filter ${f.property}`}
                      className="ml-0.5 shrink-0 text-muted-foreground hover:text-foreground"
                      onClick={() => {
                        setFilters((prev) => prev.filter((_, qi) => qi !== i))
                        setActiveViewId(null)
                        setPage(1)
                      }}
                    >
                      <X className="h-3 w-3" aria-hidden />
                    </button>
                  </span>
                ))}

                {/* Clear */}
                {(filters.length > 0 || sortBy) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                    onClick={clearAll}
                  >
                    <X className="h-3 w-3" aria-hidden />
                    Clear
                  </Button>
                )}
              </div>

              {/* Saved views chip row */}
              <div className="flex flex-wrap items-center gap-1.5">
                {views.length === 0 ? (
                  <span className="text-[11px] text-muted-foreground/70">
                    No saved views yet — configure filters above and press “Save view”.
                  </span>
                ) : (
                  views.map((v) => {
                    const active = activeViewId === v.id
                    return (
                      <span
                        key={v.id}
                        className={cn(
                          'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors',
                          active
                            ? 'border-foreground/30 bg-accent text-foreground'
                            : 'border-border bg-muted/50 text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                        )}
                      >
                        <button
                          type="button"
                          className="max-w-[160px] truncate"
                          onClick={() => applyView(v)}
                          title={active ? 'View applied' : `Apply view “${v.name}”`}
                          aria-pressed={active}
                        >
                          {v.name}
                        </button>
                        {isEditor && (
                          <button
                            type="button"
                            aria-label={`Delete view ${v.name}`}
                            className="shrink-0 text-muted-foreground hover:text-rose-600 dark:hover:text-rose-400"
                            onClick={() => deleteViewMutation.mutate(v.id)}
                          >
                            <X className="h-3 w-3" aria-hidden />
                          </button>
                        )}
                      </span>
                    )
                  })
                )}
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {objectsQuery.isLoading ? (
                <div className="space-y-2 p-4">
                  {[0, 1, 2, 3, 4].map((i) => (
                    <Skeleton key={i} className="h-9 w-full" />
                  ))}
                </div>
              ) : objectsQuery.isError ? (
                <p className="p-6 text-center text-sm text-rose-600 dark:text-rose-400">
                  {objectsQuery.error instanceof Error
                    ? objectsQuery.error.message
                    : 'Failed to load objects.'}
                </p>
              ) : rows.length === 0 ? (
                <div className="flex flex-col items-center gap-2 p-6 text-center text-sm text-muted-foreground">
                  {debouncedSearch || filters.length > 0 ? (
                    <>
                      <p>
                        {debouncedSearch
                          ? `No objects match “${debouncedSearch}”.`
                          : 'No objects match the active filters.'}
                      </p>
                      {(filters.length > 0 || sortBy) && (
                        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={clearAll}>
                          <X className="h-3.5 w-3.5" aria-hidden />
                          Clear filters
                        </Button>
                      )}
                    </>
                  ) : (
                    'No objects in the backing dataset yet.'
                  )}
                </div>
              ) : (
                <div className="foundry-scroll max-h-[520px] overflow-auto">
                  <Table>
                    <TableHeader className="sticky top-0 z-10 bg-card">
                      <TableRow className="border-border hover:bg-transparent">
                        <TableHead className="h-8 px-4 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                          {objectsQuery.data?.objectType.primaryKey ?? 'pk'}
                        </TableHead>
                        {tableColumns.map((c) => (
                          <TableHead
                            key={c.apiName}
                            className="h-8 whitespace-nowrap px-3 font-mono text-[10px] uppercase tracking-wider text-muted-foreground"
                          >
                            {c.displayName}
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((row) => {
                        const selected = row.pk === selectedPk
                        return (
                          <TableRow
                            key={row.pk}
                            aria-selected={selected}
                            onClick={() => setSelectedPk(row.pk)}
                            className={cn(
                              'cursor-pointer border-border',
                              selected
                                ? 'border-l-2 border-l-foreground bg-accent/60'
                                : 'hover:bg-accent/40',
                            )}
                          >
                            <TableCell className="px-4 py-2 font-mono text-xs text-muted-foreground">
                              {row.pk}
                            </TableCell>
                            {tableColumns.map((c) => (
                              <TableCell key={c.apiName} className="max-w-[220px] px-3 py-2">
                                {c.isTitle ? (
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      setSelectedPk(row.pk)
                                    }}
                                    className="max-w-full truncate text-left text-xs font-medium text-foreground hover:underline underline-offset-2"
                                    title={`Select ${row.pk}`}
                                  >
                                    {renderValue(row.values[c.apiName])}
                                  </button>
                                ) : (
                                  <span className="block max-w-[220px] truncate font-mono text-xs text-foreground">
                                    {renderValue(row.values[c.apiName])}
                                  </span>
                                )}
                              </TableCell>
                            ))}
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}

              {/* Pagination footer */}
              {!objectsQuery.isLoading && rows.length > 0 && (
                <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-2.5">
                  <p className="font-mono text-[11px] text-muted-foreground">
                    {total} objects · page {page} / {totalPages}
                  </p>
                  <div className="flex items-center gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2"
                      disabled={page <= 1}
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      aria-label="Previous page"
                    >
                      <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2"
                      disabled={page >= totalPages}
                      onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                      aria-label="Next page"
                    >
                      <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* c) RIGHT: detail panel */}
          <div className="w-full shrink-0 lg:sticky lg:top-[72px] lg:w-96">
            <Card className="border-border bg-card">
              {selectedPk ? (
                <ObjectDetailPanel
                  typeApiName={typeApiName}
                  selectedPk={selectedPk}
                  columns={allColumns}
                  titleProperty={titleProperty}
                  onClear={() => setSelectedPk(null)}
                />
              ) : (
                <CardContent className="flex flex-col items-center gap-2 p-8 text-center">
                  <Compass className="h-7 w-7 text-muted-foreground" aria-hidden />
                  <p className="text-sm font-medium text-muted-foreground">No object selected</p>
                  <p className="text-xs text-muted-foreground/80">
                    Click a row to inspect its properties and links.
                  </p>
                </CardContent>
              )}
            </Card>
          </div>
        </div>
      )}

      {/* d) Action dialog (dropdown picks + ?action= deep link) */}
      {activeActionApiName && (
        <ActiveActionDialog
          actionApiName={activeActionApiName}
          prefillPk={selectedPk}
          onClose={() => setActiveActionApiName(null)}
        />
      )}
    </div>
  )
}

function TypeIconBadge({ type }: { type: OntologyObjectType }) {
  const color = getObjectColorClasses(type.color)
  return (
    <span
      className={cn(
        'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border',
        color.border,
        color.bg,
      )}
    >
      <OntologyIcon name={type.icon} className={cn('h-5 w-5', color.text)} />
    </span>
  )
}

export default function ObjectTypePage() {
  return (
    <Suspense fallback={null}>
      <WorkshopView />
    </Suspense>
  )
}
