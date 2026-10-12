'use client'

// Application canvas (Workshop-style). View mode renders the widget grid over
// live Ontology data with global filters and an app-wide object selection:
// clicking a map marker or table row opens the detail panel (properties,
// links, write-back actions). Edit mode (editor-gated) keeps a local draft —
// add/edit/reorder/remove widgets, manage filters, rename — committed by ONE
// Save PATCH, consistent with the dashboard builder's "Save button" pattern.

import { useMemo, useState } from 'react'
import Link from '@/components/link'
import { useParams, useRouter } from '@/lib/next-navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ArrowLeft,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Gauge,
  LayoutTemplate,
  Loader2,
  Map as MapIcon,
  PencilLine,
  Plus,
  RefreshCw,
  Save,
  Settings2,
  Table2,
  Trash2,
  X,
  Zap,
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
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { useIsXl } from '@/hooks/use-xl'
import { apiJson, apiSend, toastApiError } from '@/lib/foundry-api'
import { formatRelative } from '@/lib/foundry-types'
import type {
  AppConfig,
  AppFilterDef,
  AppObjectRef,
  AppPage,
  AppWidget,
  ApplicationInfo,
  ApplicationResponse,
  OntologyListResponse,
  SessionResponse,
} from '@/lib/foundry-types'
import { AppMapWidget } from '@/components/foundry/app-builder/app-map-widget'
import { AppTableWidget } from '@/components/foundry/app-builder/app-table-widget'
import { AppStatWidget } from '@/components/foundry/app-builder/app-stat-widget'
import { AppActionWidget } from '@/components/foundry/app-builder/app-action-widget'
import { AppChartWidget } from '@/components/foundry/app-builder/app-chart-widget'
import type { AppExploration } from '@/components/foundry/app-builder/use-app-objects'
import { AppDetailPanel } from '@/components/foundry/app-builder/app-detail-panel'
import { AppFilterBar } from '@/components/foundry/app-builder/app-filter-bar'
import { AppFilterDialog } from '@/components/foundry/app-builder/app-filter-dialog'
import { AppWidgetDialog } from '@/components/foundry/app-builder/app-widget-dialog'

const canEditRole = (role: SessionResponse['role'] | undefined) => role === 'editor' || role === 'admin'

const WIDGET_ICON: Record<AppWidget['type'], typeof MapIcon> = {
  map: MapIcon,
  objectTable: Table2,
  stat: Gauge,
  actionButton: Zap,
  chart: BarChart3,
}

interface Draft {
  name: string
  description: string
  widgets: AppWidget[]
  filters: AppFilterDef[]
  pages: AppPage[]
}

function draftOf(a: ApplicationInfo): Draft {
  return {
    name: a.name,
    description: a.description ?? '',
    widgets: structuredClone(a.config.widgets),
    filters: structuredClone(a.config.filters),
    pages: structuredClone(a.config.pages),
  }
}

function sameDraft(a: Draft, b: Draft): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

const EMPTY_CONFIG: AppConfig = { pages: [{ id: 'overview', title: 'Overview', sections: [{ id: 'main', title: 'Main' }] }], widgets: [], filters: [] }

export default function ApplicationCanvasPage() {
  const params = useParams<{ id: string }>()
  const appId = params.id
  const router = useRouter()
  const queryClient = useQueryClient()
  const isXl = useIsXl()

  const sessionQuery = useQuery<SessionResponse>({
    queryKey: ['session'],
    queryFn: () => apiJson<SessionResponse>('/api/session'),
    staleTime: 30_000,
  })
  const canEdit = canEditRole(sessionQuery.data?.role)

  const appQuery = useQuery<ApplicationResponse>({
    queryKey: ['application', appId],
    queryFn: () => apiJson<ApplicationResponse>(`/api/applications/${appId}`),
  })
  const application = appQuery.data?.application ?? null

  const ontologyQuery = useQuery<OntologyListResponse>({
    queryKey: ['ontology'],
    queryFn: () => apiJson<OntologyListResponse>('/api/ontology'),
  })
  const objectTypes = ontologyQuery.data?.objectTypes ?? []

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [spinning, setSpinning] = useState(false)
  const [selection, setSelection] = useState<AppObjectRef | null>(null)
  const [filterValues, setFilterValues] = useState<Record<string, string>>({})
  const [exploration, setExploration] = useState<AppExploration | null>(null)
  const [activePageId, setActivePageId] = useState<string | null>(null)
  const [widgetDialog, setWidgetDialog] = useState<{ mode: 'add' } | { mode: 'edit'; index: number } | null>(null)
  const [filterDialogOpen, setFilterDialogOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)

  const config = editing && draft ? { widgets: draft.widgets, filters: draft.filters, pages: draft.pages } : application?.config ?? EMPTY_CONFIG

  const startEditing = () => {
    if (!application) return
    setDraft(draftOf(application))
    setEditing(true)
  }

  const discard = () => {
    setEditing(false)
    setDraft(null)
  }

  const saveMutation = useMutation({
    mutationFn: (d: Draft) =>
      apiSend<ApplicationResponse>(`/api/applications/${appId}`, 'PATCH', {
        name: d.name.trim() || 'Untitled application',
        description: d.description.trim() === '' ? null : d.description.trim(),
        config: { widgets: d.widgets, filters: d.filters, pages: d.pages },
      }),
    onSuccess: (res) => {
      toast.success('Application saved', {
        description: `${res.application.config.widgets.length} widgets · ${res.application.config.filters.length} filters`,
      })
      queryClient.invalidateQueries({ queryKey: ['application', appId] })
      queryClient.invalidateQueries({ queryKey: ['applications'] })
      setEditing(false)
      setDraft(null)
    },
    onError: (err: Error) => toastApiError(err, 'Could not save application'),
  })

  const deleteMutation = useMutation({
    mutationFn: () => apiSend<{ ok: boolean }>(`/api/applications/${appId}`, 'DELETE'),
    onSuccess: () => {
      toast.success('Application deleted')
      queryClient.invalidateQueries({ queryKey: ['applications'] })
      router.push('/applications')
    },
    onError: (err: Error) => toastApiError(err, 'Could not delete application'),
  })

  const refresh = () => {
    setSpinning(true)
    void queryClient.invalidateQueries({ queryKey: ['objects'] })
    void queryClient.invalidateQueries({ queryKey: ['object'] })
    void queryClient.invalidateQueries({ queryKey: ['application', appId] })
    setTimeout(() => setSpinning(false), 700)
  }

  const dirty = useMemo(
    () => editing && draft != null && application != null && !sameDraft(draft, draftOf(application)),
    [editing, draft, application],
  )
  const layoutValid = !draft || draft.pages.every((page) =>
    page.title.trim() && page.sections.every((section) => section.title.trim()))

  // ── draft mutators (edit mode) ─────────────────────────────────────
  const updateDraft = (fn: (d: Draft) => Draft) => setDraft((prev) => (prev ? fn(prev) : prev))

  const saveWidget = (widget: AppWidget) => {
    if (!editing) return
    if (widgetDialog?.mode === 'edit') {
      const index = widgetDialog.index
      updateDraft((d) => ({ ...d, widgets: d.widgets.map((w, i) => (i === index ? widget : w)) }))
      toast.success('Widget updated', { description: `${widget.title} — press Save to commit` })
    } else {
      updateDraft((d) => ({ ...d, widgets: [...d.widgets, widget] }))
      toast.success('Widget added', { description: `${widget.title} — press Save to commit` })
    }
    setWidgetDialog(null)
  }

  const moveWidget = (index: number, dir: -1 | 1) => {
    updateDraft((d) => {
      const next = [...d.widgets]
      const widget = next[index]
      const page = d.pages.find((p) => p.id === (widget.pageId ?? d.pages[0].id)) ?? d.pages[0]
      const sectionId = widget.sectionId ?? page.sections[0].id
      const indexes = next.flatMap((candidate, i) =>
        (candidate.pageId ?? d.pages[0].id) === page.id &&
        (candidate.sectionId ?? page.sections[0].id) === sectionId ? [i] : [])
      const position = indexes.indexOf(index)
      const j = indexes[position + dir]
      if (j === undefined) return d
      ;[next[index], next[j]] = [next[j], next[index]]
      return { ...d, widgets: next }
    })
  }

  const removeWidget = (index: number) => {
    updateDraft((d) => ({ ...d, widgets: d.widgets.filter((_, i) => i !== index) }))
  }

  const addFilter = (def: AppFilterDef) => {
    updateDraft((d) => ({ ...d, filters: [...d.filters, def] }))
    toast.success('Filter added', { description: 'Press Save to commit' })
  }

  const removeFilter = (id: string) => {
    updateDraft((d) => ({ ...d, filters: d.filters.filter((f) => f.id !== id) }))
    setFilterValues((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  const addPage = () => {
    if (!draft || draft.pages.length >= 12) return
    const id = crypto.randomUUID()
    updateDraft((d) => ({ ...d, pages: [...d.pages, {
      id, title: `Page ${d.pages.length + 1}`, sections: [{ id: crypto.randomUUID(), title: 'Main' }],
    }] }))
    setActivePageId(id)
  }

  const removePage = (id: string) => {
    updateDraft((d) => {
      if (d.pages.length <= 1) return d
      const pages = d.pages.filter((page) => page.id !== id)
      const destination = pages[0]
      return { ...d, pages, widgets: d.widgets.map((widget) =>
        (widget.pageId ?? d.pages[0].id) === id
          ? { ...widget, pageId: destination.id, sectionId: destination.sections[0].id }
          : widget) }
    })
    setActivePageId(null)
  }

  const addSection = (pageId: string) => updateDraft((d) => ({ ...d, pages: d.pages.map((page) =>
    page.id === pageId && page.sections.length < 20
      ? { ...page, sections: [...page.sections, { id: crypto.randomUUID(), title: `Section ${page.sections.length + 1}` }] }
      : page) }))

  const removeSection = (pageId: string, sectionId: string) => updateDraft((d) => {
    const page = d.pages.find((item) => item.id === pageId)
    if (!page || page.sections.length <= 1) return d
    const sections = page.sections.filter((section) => section.id !== sectionId)
    return { ...d,
      pages: d.pages.map((item) => item.id === pageId ? { ...item, sections } : item),
      widgets: d.widgets.map((widget) =>
        (widget.pageId ?? d.pages[0].id) === pageId && (widget.sectionId ?? page.sections[0].id) === sectionId
          ? { ...widget, pageId, sectionId: sections[0].id } : widget),
    }
  })

  // ── loading / error states ─────────────────────────────────────────
  if (appQuery.isLoading) {
    return (
      <div className="mx-auto w-full max-w-[1600px] px-4 py-6 sm:py-8">
        <Skeleton className="mb-4 h-10 w-full" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-64 w-full" />
          ))}
        </div>
      </div>
    )
  }

  if (appQuery.isError || !application) {
    return (
      <div className="mx-auto w-full max-w-[1600px] px-4 py-6 sm:py-8">
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-2 p-8 text-center">
            <p className="text-sm font-medium text-foreground">
              {appQuery.error instanceof Error ? appQuery.error.message : 'Application not found'}
            </p>
            <Button asChild variant="outline" size="sm" className="mt-1 gap-1.5">
              <Link href="/applications">
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
                Back to applications
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  const widgets = config.widgets
  const filterDefs = config.filters
  const pages = config.pages
  const currentPage = pages.find((page) => page.id === activePageId) ?? pages[0]
  const inSection = (widget: AppWidget, sectionId: string) =>
    (widget.pageId ?? pages[0].id) === currentPage.id &&
    (widget.sectionId ?? currentPage.sections[0].id) === sectionId
  const existingWidget = widgetDialog?.mode === 'edit' ? widgets[widgetDialog.index] ?? null : null

  const renderBody = (widget: AppWidget) => {
    switch (widget.type) {
      case 'map':
        return (
          <AppMapWidget
            widget={widget}
            objectTypes={objectTypes}
            filterDefs={filterDefs}
            filterValues={filterValues}
            exploration={exploration}
            selection={selection}
            onSelect={setSelection}
          />
        )
      case 'objectTable':
        return (
          <AppTableWidget
            widget={widget}
            objectTypes={objectTypes}
            filterDefs={filterDefs}
            filterValues={filterValues}
            exploration={exploration}
            selection={selection}
            onSelect={setSelection}
          />
        )
      case 'stat':
        return (
          <AppStatWidget
            widget={widget}
            objectTypes={objectTypes}
            filterDefs={filterDefs}
            filterValues={filterValues}
            exploration={exploration}
          />
        )
      case 'chart':
        return <AppChartWidget widget={widget} objectTypes={objectTypes} filterDefs={filterDefs}
          filterValues={filterValues} exploration={exploration} selection={selection} onExplore={setExploration} />
      case 'actionButton':
        return (
          <AppActionWidget widget={widget} objectTypes={objectTypes} selection={selection} canEdit={canEdit} />
        )
    }
  }

  const spanClass = (span: number) =>
    span >= 3 ? 'md:col-span-2 xl:col-span-3' : span === 2 ? 'md:col-span-2' : ''

  const detailPanel = selection && (
    <AppDetailPanel
      selection={selection}
      objectTypes={objectTypes}
      canEdit={canEdit}
      onSelect={setSelection}
      className="h-full"
    />
  )

  return (
    <div className="mx-auto w-full max-w-[1600px] px-4 py-6 sm:py-8">
      {/* Header */}
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          {editing && draft ? (
            <div className="grid gap-2">
              <div className="flex items-center gap-2">
                <PencilLine className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                <Input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  aria-label="Application name"
                  placeholder="Application name"
                  className="h-8 max-w-md text-sm font-medium"
                />
              </div>
              <Input
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                aria-label="Application description"
                placeholder="Description (optional)"
                className="h-8 max-w-md text-xs text-muted-foreground"
              />
            </div>
          ) : (
            <>
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <LayoutTemplate className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                <h1 className="truncate text-sm font-medium tracking-tight text-foreground">{application.name}</h1>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {widgets.length} {widgets.length === 1 ? 'widget' : 'widgets'}
                  {filterDefs.length > 0 ? ` · ${filterDefs.length} filters` : ''}
                </span>
              </div>
              {application.description && (
                <p className="mt-1 max-w-3xl truncate text-xs text-muted-foreground">{application.description}</p>
              )}
              <p className="mt-1 font-mono text-[11px] text-muted-foreground/80">
                updated {formatRelative(application.updatedAt)}
                {application.createdBy ? ` · by ${application.createdBy}` : ''}
              </p>
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={refresh} aria-label="Refresh app data">
            <RefreshCw className={cn('h-3.5 w-3.5', spinning && 'animate-spin')} aria-hidden />
            Refresh
          </Button>
          {editing && draft ? (
            <>
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setWidgetDialog({ mode: 'add' })}>
                <Plus className="h-3.5 w-3.5" aria-hidden />
                Add widget
              </Button>
              <Button
                size="sm"
                className="gap-1.5"
                disabled={!dirty || !layoutValid || saveMutation.isPending}
                onClick={() => saveMutation.mutate(draft)}
              >
                {saveMutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  <Save className="h-3.5 w-3.5" aria-hidden />
                )}
                Save
              </Button>
              <Button variant="ghost" size="sm" className="gap-1.5" onClick={discard} disabled={saveMutation.isPending}>
                <X className="h-3.5 w-3.5" aria-hidden />
                Discard
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={startEditing}
              disabled={!canEdit}
              title={canEdit ? 'Edit layout, widgets and filters' : 'requires editor role (current: viewer)'}
            >
              <PencilLine className="h-3.5 w-3.5" aria-hidden />
              Edit
            </Button>
          )}
          {canEdit && <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground hover:text-rose-600" onClick={() => setDeleteOpen(true)}>
            <Trash2 className="h-3.5 w-3.5" aria-hidden /> Delete application
          </Button>}
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-1.5 border-b border-border pb-2" aria-label="Application pages">
        {pages.map((page) => (
          <button key={page.id} type="button" aria-current={currentPage.id === page.id ? 'page' : undefined}
            onClick={() => setActivePageId(page.id)}
            className={cn('rounded-md px-3 py-1.5 text-xs transition-colors', currentPage.id === page.id
              ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground')}>
            {page.title}
          </button>
        ))}
        {editing && <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" disabled={pages.length >= 12} onClick={addPage}>
          <Plus className="h-3 w-3" aria-hidden /> Add page
        </Button>}
      </div>

      {editing && draft && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/20 p-2">
          <span className="text-[11px] text-muted-foreground">Page name</span>
          <Input aria-label="Page name" className="h-8 max-w-64 text-xs" value={currentPage.title}
            onChange={(event) => updateDraft((d) => ({ ...d, pages: d.pages.map((page) =>
              page.id === currentPage.id ? { ...page, title: event.target.value } : page) }))} />
          <Button variant="outline" size="sm" className="h-8 gap-1 text-xs" onClick={() => addSection(currentPage.id)}
            disabled={currentPage.sections.length >= 20}><Plus className="h-3 w-3" aria-hidden /> Add section</Button>
          <Button variant="ghost" size="sm" className="h-8 gap-1 text-xs text-muted-foreground hover:text-rose-600"
            disabled={pages.length <= 1} onClick={() => removePage(currentPage.id)}
            title="Move this page's widgets to the first page, then remove it">
            <Trash2 className="h-3 w-3" aria-hidden /> Remove page
          </Button>
        </div>
      )}

      {/* Global filters */}
      <div className="mb-4">
        <AppFilterBar
          defs={filterDefs}
          values={filterValues}
          onChange={(id, value) => setFilterValues((prev) => ({ ...prev, [id]: value }))}
          editing={editing}
          objectTypes={objectTypes}
          onAddFilter={() => setFilterDialogOpen(true)}
          onRemoveFilter={removeFilter}
        />
      </div>

      {exploration && (
        <div className="mb-4 flex items-center gap-2 text-xs text-muted-foreground">
          Chart filter: <span className="rounded-full border border-border bg-accent px-2 py-1 font-medium text-foreground">
            {exploration.objectTypeApiName} · {exploration.property} = {exploration.value}
          </span>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setExploration(null)}>Clear</Button>
        </div>
      )}

      {/* Canvas + detail panel */}
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1 space-y-5">
        {currentPage.sections.map((section) => (
          <section key={section.id} aria-label={section.title}>
            <div className="mb-2 flex items-center gap-2">
              {editing ? <Input aria-label="Section name" className="h-8 max-w-xs text-xs font-medium" value={section.title}
                onChange={(event) => updateDraft((d) => ({ ...d, pages: d.pages.map((page) =>
                  page.id === currentPage.id ? { ...page, sections: page.sections.map((item) =>
                    item.id === section.id ? { ...item, title: event.target.value } : item) } : page) }))} />
                : <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{section.title}</h2>}
              {editing && <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground hover:text-rose-600"
                disabled={currentPage.sections.length <= 1} onClick={() => removeSection(currentPage.id, section.id)}
                title="Move widgets to the first section, then remove this section">
                <Trash2 className="h-3 w-3" aria-hidden />
              </Button>}
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {widgets.map((widget, i) => ({ widget, i })).filter(({ widget }) => inSection(widget, section.id)).map(({ widget, i }) => {
            const Icon = WIDGET_ICON[widget.type]
            return (
              <div key={widget.id} className={cn('min-w-0', spanClass(widget.span))}>
                <Card className="h-full">
                  <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
                    <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <h2 className="min-w-0 truncate text-xs font-medium text-foreground">{widget.title}</h2>
                    {editing && (
                      <div className="ml-auto flex shrink-0 items-center gap-0.5">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={() => moveWidget(i, -1)}
                          disabled={widgets.slice(0, i).every((candidate) => !inSection(candidate, section.id))}
                          title="Move left"
                        >
                          <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={() => moveWidget(i, 1)}
                          disabled={widgets.slice(i + 1).every((candidate) => !inSection(candidate, section.id))}
                          title="Move right"
                        >
                          <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={() => setWidgetDialog({ mode: 'edit', index: i })}
                          title="Edit widget"
                        >
                          <Settings2 className="h-3.5 w-3.5" aria-hidden />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 text-muted-foreground hover:text-rose-600"
                          onClick={() => removeWidget(i)}
                          title="Remove widget"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden />
                        </Button>
                      </div>
                    )}
                  </div>
                  <CardContent className={cn('p-3', widget.type === 'stat' && 'p-2')}>{renderBody(widget)}</CardContent>
                </Card>
              </div>
            )
          })}

          {!widgets.some((widget) => inSection(widget, section.id)) && (
            <div className="flex h-56 flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-center md:col-span-2 xl:col-span-3">
              <LayoutTemplate className="h-7 w-7 text-muted-foreground/70" aria-hidden />
              <p className="text-sm font-medium text-muted-foreground">Empty canvas</p>
              <p className="max-w-md text-xs text-muted-foreground/80">
                {editing
                  ? 'Use “Add widget” to place a map, object table, stat or action button. Widgets bind to Ontology object types and stay governed.'
                  : 'This application has no widgets yet.'}
              </p>
              {!editing && canEdit && (
                <Button size="sm" variant="outline" className="mt-1 gap-1.5" onClick={startEditing}>
                  <PencilLine className="h-3.5 w-3.5" aria-hidden />
                  Start editing
                </Button>
              )}
            </div>
          )}
            </div>
          </section>
        ))}
        </div>

        {/* Detail panel — inline on xl screens */}
        {selection && isXl && (
          <div className="sticky top-4 hidden h-[calc(100vh-6rem)] w-[340px] shrink-0 xl:block">{detailPanel}</div>
        )}
      </div>

      {/* Detail panel — sheet below xl */}
      <Sheet open={!!selection && !isXl} onOpenChange={(open) => !open && setSelection(null)}>
        <SheetContent side="right" className="w-[360px] max-w-[92vw] gap-0 p-0 sm:max-w-[360px]">
          <SheetTitle className="sr-only">Selected object</SheetTitle>
          <div className="h-full">{detailPanel}</div>
        </SheetContent>
      </Sheet>

      {editing && (
        <p className="mt-3 font-mono text-[11px] text-muted-foreground/80">
          edit mode — changes are local until you press Save
        </p>
      )}

      {/* Dialogs */}
      {widgetDialog && (
        <AppWidgetDialog
          open
          onOpenChange={(open) => !open && setWidgetDialog(null)}
          objectTypes={objectTypes}
          pages={pages}
          currentPageId={currentPage.id}
          existing={existingWidget}
          onSave={saveWidget}
        />
      )}
      {filterDialogOpen && editing && (
        <AppFilterDialog
          open
          onOpenChange={setFilterDialogOpen}
          objectTypes={objectTypes}
          onSave={addFilter}
        />
      )}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent className="bg-card sm:max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-foreground">Delete application?</AlertDialogTitle>
            <AlertDialogDescription className="text-muted-foreground">
              <span className="font-medium text-foreground">{application.name}</span> and its widget layout will
              be permanently removed. Ontology objects, datasets and actions are untouched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="text-muted-foreground hover:text-foreground">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                deleteMutation.mutate()
              }}
              disabled={deleteMutation.isPending}
              className="bg-rose-600 text-white hover:bg-rose-500 dark:bg-rose-500 dark:text-zinc-950 dark:hover:bg-rose-400"
            >
              {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
