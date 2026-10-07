'use client'

// AppWidgetDialog — add or edit one app widget. Type-specific config:
//   map          → render mode + object-type layers (visibility, colorBy,
//                  sizeBy, centroid-fallback property; lat/lng auto-detected)
//   objectTable  → object type + visible columns
//   stat         → object type + aggregation + value property
//   actionButton → Ontology action + prefill-from-selection
// Config binds by apiName so apps survive workspace re-seeds.

import { useMemo, useState } from 'react'
import { BarChart3, Eye, EyeOff, Gauge, Map as MapIcon, Plus, Table2, Trash2, Zap } from 'lucide-react'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { detectFallbackProperty, detectLatLngProperties } from '@/lib/geo'
import type {
  AppMapLayerConfig,
  AppMapMode,
  AppPage,
  AppWidget,
  AppWidgetSpan,
  OntologyObjectType,
} from '@/lib/foundry-types'

const NONE = '__none__'
const AUTO = '__auto__'

type WidgetKind = AppWidget['type']

const KIND_META: { value: WidgetKind; label: string; icon: typeof MapIcon; blurb: string }[] = [
  { value: 'map', label: 'Map', icon: MapIcon, blurb: 'Object types as geographic layers' },
  { value: 'objectTable', label: 'Object table', icon: Table2, blurb: 'Governed, filterable object list' },
  { value: 'stat', label: 'Stat', icon: Gauge, blurb: 'One aggregate over an object type' },
  { value: 'chart', label: 'Chart', icon: BarChart3, blurb: 'Live grouped Ontology data with clickable categories' },
  { value: 'actionButton', label: 'Action', icon: Zap, blurb: 'Run an Ontology write-back action' },
]

const AGG_OPTIONS = ['count', 'sum', 'avg', 'min', 'max'] as const

const newId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `w-${Date.now()}`

function prettyProperty(apiName: string): string {
  const spaced = apiName.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

interface AppWidgetDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  objectTypes: OntologyObjectType[]
  pages: AppPage[]
  currentPageId: string
  /** null = add mode; otherwise the widget being edited. */
  existing: AppWidget | null
  onSave: (widget: AppWidget) => void
}

/**
 * The host page mounts this dialog only while it is open, so all form state is
 * initialized once from props (same fresh-mount pattern as ActionDialog's
 * keyed form) — no reseed effects.
 */
export function AppWidgetDialog({ open, onOpenChange, objectTypes, pages, currentPageId, existing, onSave }: AppWidgetDialogProps) {
  const [kind, setKind] = useState<WidgetKind>(existing?.type ?? 'map')
  const [title, setTitle] = useState(existing?.title ?? '')
  const [titleEdited, setTitleEdited] = useState(!!existing)
  const [span, setSpan] = useState<AppWidgetSpan>(existing?.span ?? 2)
  const [pageId, setPageId] = useState(existing?.pageId ?? currentPageId)
  const [sectionId, setSectionId] = useState(existing?.sectionId ?? pages.find((page) => page.id === (existing?.pageId ?? currentPageId))?.sections[0]?.id ?? 'main')

  // map config
  const [mapMode, setMapMode] = useState<AppMapMode>(existing?.type === 'map' ? existing.mapMode : 'markers')
  const [layers, setLayers] = useState<AppMapLayerConfig[]>(existing?.type === 'map' ? existing.layers : [])

  // table/stat config
  const [objectTypeApiName, setObjectTypeApiName] = useState(
    existing && existing.type !== 'map' && existing.type !== 'actionButton' ? existing.objectTypeApiName : '',
  )
  const [columns, setColumns] = useState<string[]>(existing?.type === 'objectTable' ? existing.columns ?? [] : [])
  const [agg, setAgg] = useState<'count' | 'sum' | 'avg' | 'min' | 'max'>(existing?.type === 'stat' ? existing.agg : 'count')
  const [valueProperty, setValueProperty] = useState(existing?.type === 'stat' ? existing.valueProperty ?? '' : '')
  const [chartType, setChartType] = useState<'bar' | 'line' | 'area' | 'pie'>(existing?.type === 'chart' ? existing.chartType : 'bar')
  const [groupBy, setGroupBy] = useState(existing?.type === 'chart' ? existing.groupBy : '')
  const [chartAgg, setChartAgg] = useState<'count' | 'sum' | 'avg' | 'min' | 'max'>(existing?.type === 'chart' ? existing.agg : 'count')
  const [chartValue, setChartValue] = useState(existing?.type === 'chart' ? existing.valueProperty ?? '' : '')
  const [topN, setTopN] = useState(existing?.type === 'chart' ? existing.topN : 10)

  // action config
  const [actionApiName, setActionApiName] = useState(existing?.type === 'actionButton' ? existing.actionApiName : '')
  const [useSelection, setUseSelection] = useState(existing?.type === 'actionButton' ? existing.useSelection : true)

  const allActions = useMemo(
    () =>
      objectTypes.flatMap((t) =>
        t.actions.filter((a) => a.enabled).map((a) => ({ ...a, objectTypeApiName: t.apiName, objectTypeDisplayName: t.displayName })),
      ),
    [objectTypes],
  )

  const selectedType = objectTypes.find((t) => t.apiName === objectTypeApiName) ?? null
  const numberProps = selectedType?.properties.filter((p) => p.dataType === 'number') ?? []
  const selectedAction = allActions.find((a) => a.apiName === actionApiName) ?? null

  const suggestedTitle = (() => {
    if (kind === 'map') {
      const names = layers
        .map((l) => objectTypes.find((t) => t.apiName === l.objectTypeApiName)?.displayName ?? l.objectTypeApiName)
        .filter(Boolean)
      if (names.length === 0) return 'Object map'
      return `${names.join(' + ')} map`
    }
    if (!selectedType) return ''
    if (kind === 'objectTable') return `${selectedType.displayName} table`
    if (kind === 'chart') return `${selectedType.displayName} by ${prettyProperty(groupBy || 'category')}`
    if (kind === 'stat') {
      if (agg === 'count') return `Total ${selectedType.displayName.toLowerCase()}`
      return `${agg === 'avg' ? 'Average' : agg === 'sum' ? 'Total' : agg.charAt(0).toUpperCase() + agg.slice(1)} of ${valueProperty ? prettyProperty(valueProperty) : selectedType.displayName}`
    }
    return selectedAction?.displayName ?? ''
  })()

  const effectiveTitle = titleEdited ? title.trim() : suggestedTitle

  const blocked =
    (kind === 'map' && layers.length === 0) ||
    ((kind === 'objectTable' || kind === 'stat' || kind === 'chart') && !objectTypeApiName) ||
    (kind === 'stat' && agg !== 'count' && !valueProperty) ||
    (kind === 'chart' && (!groupBy || (chartAgg !== 'count' && !chartValue))) ||
    (kind === 'actionButton' && !actionApiName)

  const updateLayer = (id: string, patch: Partial<AppMapLayerConfig>) => {
    setLayers((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)))
  }

  const addLayer = () => {
    const used = new Set(layers.map((l) => l.objectTypeApiName))
    const next = objectTypes.find((t) => !used.has(t.apiName)) ?? objectTypes[0]
    if (!next) return
    setLayers((prev) => [
      ...prev,
      { id: newId(), objectTypeApiName: next.apiName, visible: true, colorBy: null, sizeBy: null, fallbackProperty: null },
    ])
  }

  const handleSave = () => {
    if (blocked) return
    const base = { id: existing?.id ?? newId(), title: effectiveTitle || suggestedTitle || 'Untitled widget', span, pageId, sectionId }
    let widget: AppWidget
    switch (kind) {
      case 'map':
        widget = { ...base, type: 'map', mapMode, layers }
        break
      case 'objectTable':
        widget = { ...base, type: 'objectTable', objectTypeApiName, columns: columns.length ? columns : null }
        break
      case 'stat':
        widget = { ...base, type: 'stat', objectTypeApiName, agg, valueProperty: agg === 'count' ? null : valueProperty || null }
        break
      case 'chart':
        widget = { ...base, type: 'chart', objectTypeApiName, chartType, groupBy, agg: chartAgg,
          valueProperty: chartAgg === 'count' ? null : chartValue || null, topN }
        break
      case 'actionButton':
        widget = { ...base, type: 'actionButton', actionApiName, useSelection }
        break
    }
    onSave(widget)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-sm">{existing ? 'Edit widget' : 'Add widget'}</DialogTitle>
          <DialogDescription className="text-xs">
            Widgets bind to Ontology object types and actions — data stays governed and live.
          </DialogDescription>
        </DialogHeader>

        <div className="foundry-scroll max-h-[65vh] space-y-4 overflow-y-auto pr-1">
          {/* Type picker (locked when editing) */}
          <div className="grid grid-cols-5 gap-2">
            {KIND_META.map((meta) => {
              const Icon = meta.icon
              const disabled = !!existing && existing.type !== meta.value
              return (
                <button
                  key={meta.value}
                  type="button"
                  disabled={disabled}
                  onClick={() => setKind(meta.value)}
                  className={cn(
                    'flex flex-col items-center gap-1 rounded-md border p-2.5 text-center transition-colors',
                    kind === meta.value
                      ? 'border-foreground/40 bg-accent'
                      : 'border-border hover:border-foreground/25',
                    disabled && 'cursor-not-allowed opacity-40',
                  )}
                  title={meta.blurb}
                  aria-pressed={kind === meta.value}
                >
                  <Icon className="h-4 w-4" aria-hidden />
                  <span className="text-[11px] font-medium">{meta.label}</span>
                </button>
              )
            })}
          </div>

          {/* Title + span */}
          <div className="grid grid-cols-[1fr,120px] gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="aw-title" className="text-xs">Title</Label>
              <Input
                id="aw-title"
                value={effectiveTitle}
                onChange={(e) => {
                  setTitleEdited(true)
                  setTitle(e.target.value)
                }}
                placeholder={suggestedTitle || 'Widget title'}
                className="h-9 text-xs"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="aw-span" className="text-xs">Width</Label>
              <Select value={String(span)} onValueChange={(v) => setSpan(Number(v) as AppWidgetSpan)}>
                <SelectTrigger id="aw-span" className="h-9 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">1 column</SelectItem>
                  <SelectItem value="2">2 columns</SelectItem>
                  <SelectItem value="3">Full width</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* ── MAP config ── */}
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label className="text-xs">Page</Label>
              <Select value={pageId} onValueChange={(value) => {
                setPageId(value)
                setSectionId(pages.find((page) => page.id === value)?.sections[0]?.id ?? 'main')
              }}>
                <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>{pages.map((page) => <SelectItem key={page.id} value={page.id}>{page.title}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label className="text-xs">Section</Label>
              <Select value={sectionId} onValueChange={setSectionId}>
                <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>{pages.find((page) => page.id === pageId)?.sections.map((section) =>
                  <SelectItem key={section.id} value={section.id}>{section.title}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>

          {kind === 'map' && (
            <div className="space-y-3">
              <div className="grid gap-1.5">
                <Label className="text-xs">Default render mode</Label>
                <div className="flex gap-1.5">
                  {(['markers', 'cluster', 'heatmap'] as AppMapMode[]).map((m) => (
                    <Button
                      key={m}
                      type="button"
                      variant={mapMode === m ? 'default' : 'outline'}
                      size="sm"
                      className="h-8 flex-1 text-xs capitalize"
                      onClick={() => setMapMode(m)}
                    >
                      {m}
                    </Button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Object layers</Label>
                  <Button type="button" variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={addLayer} disabled={objectTypes.length === 0}>
                    <Plus className="h-3 w-3" aria-hidden /> Add layer
                  </Button>
                </div>
                {objectTypes.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No object types in the Ontology yet — create one first (Ontology → New object type).
                  </p>
                )}
                {layers.map((layer) => {
                  const type = objectTypes.find((t) => t.apiName === layer.objectTypeApiName)
                  const detected = type ? detectLatLngProperties(type.properties) : {}
                  const fallback = layer.fallbackProperty ?? (type ? detectFallbackProperty(type.properties) : null)
                  const strings = type?.properties.filter((p) => p.dataType === 'string') ?? []
                  const numbers = type?.properties.filter((p) => p.dataType === 'number') ?? []
                  return (
                    <div key={layer.id} className="rounded-md border border-border/70 p-2.5">
                      <div className="grid grid-cols-[1fr,auto,auto] items-center gap-2">
                        <Select
                          value={layer.objectTypeApiName}
                          onValueChange={(v) =>
                            updateLayer(layer.id, { objectTypeApiName: v, colorBy: null, sizeBy: null, fallbackProperty: null })
                          }
                        >
                          <SelectTrigger className="h-8 text-xs">
                            <SelectValue placeholder="Object type…" />
                          </SelectTrigger>
                          <SelectContent>
                            {objectTypes.map((t) => (
                              <SelectItem key={t.apiName} value={t.apiName}>
                                {t.displayName}
                                <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">
                                  {t.objectCount?.toLocaleString('en-US') ?? 0}
                                </span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          title={layer.visible ? 'Hide layer' : 'Show layer'}
                          onClick={() => updateLayer(layer.id, { visible: !layer.visible })}
                        >
                          {layer.visible ? <Eye className="h-3.5 w-3.5" aria-hidden /> : <EyeOff className="h-3.5 w-3.5 text-muted-foreground/50" aria-hidden />}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-rose-600"
                          title="Remove layer"
                          onClick={() => setLayers((prev) => prev.filter((l) => l.id !== layer.id))}
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden />
                        </Button>
                      </div>
                      {type && (
                        <>
                          <div className="mt-2 grid grid-cols-3 gap-2">
                            <div className="grid gap-1">
                              <Label className="text-[10px] text-muted-foreground">Color by</Label>
                              <Select
                                value={layer.colorBy ?? NONE}
                                onValueChange={(v) => updateLayer(layer.id, { colorBy: v === NONE ? null : v })}
                              >
                                <SelectTrigger className="h-7 text-[11px]">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value={NONE}>Type color</SelectItem>
                                  {strings.map((p) => (
                                    <SelectItem key={p.apiName} value={p.apiName}>
                                      {p.displayName || p.apiName}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                            <div className="grid gap-1">
                              <Label className="text-[10px] text-muted-foreground">Size by</Label>
                              <Select
                                value={layer.sizeBy ?? NONE}
                                onValueChange={(v) => updateLayer(layer.id, { sizeBy: v === NONE ? null : v })}
                              >
                                <SelectTrigger className="h-7 text-[11px]">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value={NONE}>Uniform</SelectItem>
                                  {numbers.map((p) => (
                                    <SelectItem key={p.apiName} value={p.apiName}>
                                      {p.displayName || p.apiName}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                            <div className="grid gap-1">
                              <Label className="text-[10px] text-muted-foreground">Geocode fallback</Label>
                              <Select
                                value={layer.fallbackProperty ?? AUTO}
                                onValueChange={(v) => updateLayer(layer.id, { fallbackProperty: v === AUTO ? null : v })}
                              >
                                <SelectTrigger className="h-7 text-[11px]">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value={AUTO}>Auto{fallback ? ` (${fallback})` : ''}</SelectItem>
                                  {strings.map((p) => (
                                    <SelectItem key={p.apiName} value={p.apiName}>
                                      {p.displayName || p.apiName}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                          </div>
                          <p className="mt-1.5 font-mono text-[10px] text-muted-foreground/80">
                            {detected.lat && detected.lng
                              ? `coordinates: ${detected.lat} / ${detected.lng}`
                              : `no coordinate columns → ${fallback ? `${fallback} centroids (offline)` : 'unplaceable rows are counted'}`}
                          </p>
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* ── TABLE / STAT: object type ── */}
          {(kind === 'objectTable' || kind === 'stat' || kind === 'chart') && (
            <div className="grid gap-1.5">
              <Label htmlFor="aw-type" className="text-xs">Object type</Label>
              <Select
                value={objectTypeApiName}
                onValueChange={(v) => {
                  setObjectTypeApiName(v)
                  setColumns([])
                  setValueProperty('')
                  setGroupBy('')
                  setChartValue('')
                }}
              >
                <SelectTrigger id="aw-type" className="h-9 text-xs">
                  <SelectValue placeholder="Pick an object type…" />
                </SelectTrigger>
                <SelectContent>
                  {objectTypes.map((t) => (
                    <SelectItem key={t.apiName} value={t.apiName}>
                      {t.displayName}
                      <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">
                        {t.objectCount?.toLocaleString('en-US') ?? 0} objects
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {objectTypes.length === 0 && (
                <p className="text-xs text-muted-foreground">No object types yet — create one in Ontology.</p>
              )}
            </div>
          )}

          {/* ── TABLE columns ── */}
          {kind === 'objectTable' && selectedType && (
            <div className="grid gap-1.5">
              <Label className="text-xs">
                Columns <span className="text-muted-foreground">(none selected = defaults)</span>
              </Label>
              <div className="flex flex-wrap gap-1.5">
                {selectedType.properties.map((p) => {
                  const active = columns.includes(p.apiName)
                  return (
                    <button
                      key={p.apiName}
                      type="button"
                      onClick={() =>
                        setColumns((prev) =>
                          prev.includes(p.apiName) ? prev.filter((c) => c !== p.apiName) : [...prev, p.apiName],
                        )
                      }
                      className={cn(
                        'rounded-full border px-2.5 py-1 text-[11px] transition-colors',
                        active
                          ? 'border-foreground/40 bg-accent text-foreground'
                          : 'border-border text-muted-foreground hover:border-foreground/25',
                      )}
                      aria-pressed={active}
                    >
                      {p.displayName || p.apiName}
                      {p.isTitle && <span className="ml-1 text-[9px] uppercase tracking-wide opacity-70">title</span>}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* ── STAT config ── */}
          {kind === 'stat' && selectedType && (
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="aw-agg" className="text-xs">Aggregation</Label>
                <Select value={agg} onValueChange={(v) => setAgg(v as typeof agg)}>
                  <SelectTrigger id="aw-agg" className="h-9 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AGG_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>
                        {option}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className={cn('grid gap-1.5', agg === 'count' && 'opacity-40')}>
                <Label htmlFor="aw-value" className="text-xs">Value property</Label>
                <Select
                  value={valueProperty || undefined}
                  onValueChange={setValueProperty}
                  disabled={agg === 'count'}
                >
                  <SelectTrigger id="aw-value" className="h-9 text-xs">
                    <SelectValue placeholder={agg === 'count' ? 'not used' : 'Pick a number property…'} />
                  </SelectTrigger>
                  <SelectContent>
                    {numberProps.map((p) => (
                      <SelectItem key={p.apiName} value={p.apiName}>
                        {p.displayName || p.apiName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          {/* ── ACTION config ── */}
          {kind === 'chart' && selectedType && (
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label className="text-xs">Chart type</Label>
                <Select value={chartType} onValueChange={(value) => setChartType(value as typeof chartType)}>
                  <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>{(['bar', 'line', 'area', 'pie'] as const).map((value) =>
                    <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs">Group by</Label>
                <Select value={groupBy || undefined} onValueChange={setGroupBy}>
                  <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="Choose a property" /></SelectTrigger>
                  <SelectContent>{selectedType.properties.map((property) =>
                    <SelectItem key={property.apiName} value={property.apiName}>{property.displayName || property.apiName}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs">Aggregation</Label>
                <Select value={chartAgg} onValueChange={(value) => setChartAgg(value as typeof chartAgg)}>
                  <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>{AGG_OPTIONS.map((value) =>
                    <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs">Value property</Label>
                <Select value={chartValue || undefined} onValueChange={setChartValue} disabled={chartAgg === 'count'}>
                  <SelectTrigger className="h-9 text-xs"><SelectValue placeholder={chartAgg === 'count' ? 'Not used' : 'Choose a number'} /></SelectTrigger>
                  <SelectContent>{numberProps.map((property) =>
                    <SelectItem key={property.apiName} value={property.apiName}>{property.displayName || property.apiName}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="aw-top-n" className="text-xs">Categories to show</Label>
                <Input id="aw-top-n" type="number" min={1} max={100} value={topN}
                  onChange={(event) => setTopN(Math.min(100, Math.max(1, Number(event.target.value) || 1)))} className="h-9 text-xs" />
              </div>
            </div>
          )}

          {kind === 'actionButton' && (
            <div className="space-y-3">
              <div className="grid gap-1.5">
                <Label htmlFor="aw-action" className="text-xs">Ontology action</Label>
                <Select value={actionApiName || undefined} onValueChange={setActionApiName}>
                  <SelectTrigger id="aw-action" className="h-9 text-xs">
                    <SelectValue placeholder="Pick an action…" />
                  </SelectTrigger>
                  <SelectContent>
                    {allActions.map((a) => (
                      <SelectItem key={a.apiName} value={a.apiName}>
                        <span className="font-medium">{a.displayName}</span>
                        <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">
                          {a.operation} · {a.objectTypeDisplayName}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {allActions.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No enabled actions yet — create one in Ontology → Actions.
                  </p>
                )}
              </div>
              <div className="flex items-center justify-between rounded-md border border-border/70 px-3 py-2">
                <div>
                  <p className="text-xs font-medium">Prefill from selected object</p>
                  <p className="text-[11px] text-muted-foreground">
                    Uses the app-wide selection (map marker / table row) as the action&apos;s object key.
                  </p>
                </div>
                <Switch checked={useSelection} onCheckedChange={setUseSelection} disabled={!selectedAction} />
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={blocked} onClick={handleSave}>
            {existing ? 'Save widget' : 'Add widget'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
