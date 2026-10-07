'use client'

// AppMapWidget — Ontology objects on a MapLibre map.
//
// Data path: every visible layer is an object type; rows come from
// GET /api/objects (governed + masked like everywhere else) with the app's
// global filters applied. Coordinates resolve per row via src/lib/geo.ts:
// explicit latitude/longitude properties first (auto-detected by name when the
// layer does not pin them), then the offline city/country centroid fallback —
// so seeded demo data maps with or without coordinate columns.
//
// The MapLibre surface lives in map-canvas.tsx (next/dynamic, ssr:false);
// this wrapper owns fetching, feature styling (colorBy/sizeBy), the legend
// with per-layer visibility toggles and the runtime render-mode switch.
// Feature building is plain per-render computation (cheap at demo scale);
// the canvas rebuilds only when the primitive dataKey/selectionKey change.

import { lazy, Suspense, useRef, useState, type ComponentProps } from 'react'
import { useQueries } from '@tanstack/react-query'
import { apiJson } from '@/lib/foundry-api'
import { Crosshair, Eye, EyeOff, Layers, Loader2, MapPinOff, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import {
  OBJECT_COLOR_HEX,
  categoryColors,
  detectFallbackProperty,
  detectLatLngProperties,
  resolveGeoPoint,
} from '@/lib/geo'
import { filtersForType, type AppExploration } from './use-app-objects'
import type { MapLayerData } from './map-canvas'
import type {
  AppFilterDef,
  AppMapMode,
  AppMapWidget as AppMapWidgetConfig,
  AppObjectRef,
  ObjectsListResponse,
  OntologyObjectType,
} from '@/lib/foundry-types'

const MapCanvasLazy = lazy(() => import('./map-canvas'))

function MapCanvas(props: ComponentProps<typeof MapCanvasLazy>) {
  return (
    <Suspense fallback={<Skeleton className="h-full w-full rounded-md" />}>
      <MapCanvasLazy {...props} />
    </Suspense>
  )
}

interface AppMapWidgetProps {
  widget: AppMapWidgetConfig
  objectTypes: OntologyObjectType[]
  filterDefs: AppFilterDef[]
  filterValues: Record<string, string>
  exploration?: AppExploration | null
  selection: AppObjectRef | null
  onSelect: (ref: AppObjectRef | null) => void
}

const MODES: { value: AppMapMode; label: string }[] = [
  { value: 'markers', label: 'Markers' },
  { value: 'cluster', label: 'Cluster' },
  { value: 'heatmap', label: 'Heatmap' },
]

const MAP_PAGE_SIZE = 200 // /api/objects caps pageSize at 200

export function AppMapWidget({
  widget,
  objectTypes,
  filterDefs,
  filterValues,
  exploration,
  selection,
  onSelect,
}: AppMapWidgetProps) {
  const [hiddenLayers, setHiddenLayers] = useState<Set<string>>(new Set())
  const [modeOverride, setModeOverride] = useState<AppMapMode | 'saved'>('saved')
  const apiRef = useRef<{ fitAll: () => void } | null>(null)

  const mode = modeOverride === 'saved' ? widget.mapMode : modeOverride
  const activeLayers = widget.layers.filter((l) => !hiddenLayers.has(l.id))

  // Per-layer object fetches — one query per visible layer, app filters applied.
  const layerQueries = useQueries({
    queries: activeLayers.map((layer) => {
      const objectType = objectTypes.find((t) => t.apiName === layer.objectTypeApiName) ?? null
      const filters = objectType
        ? filtersForType(filterDefs, filterValues, objectType.apiName, objectType.properties, exploration)
        : []
      const filtersJson = JSON.stringify(filters)
      return {
        queryKey: ['objects', 'app-map', layer.objectTypeApiName, filtersJson],
        queryFn: () =>
          apiJson<ObjectsListResponse>(
            `/api/objects?type=${encodeURIComponent(layer.objectTypeApiName)}&page=1&pageSize=${MAP_PAGE_SIZE}&filters=${encodeURIComponent(filtersJson)}`,
          ),
        enabled: !!objectType,
        staleTime: 15_000,
      }
    }),
  })

  // ── build GeoJSON + legend (plain computation; canvas keys off dataKey) ──
  const built: MapLayerData[] = []
  const legend: { id: string; name: string; color: string; count: number; visible: boolean; colorLegend: { value: string; color: string }[] | null }[] = []
  const missingTypes: string[] = []
  let unplacedTotal = 0

  activeLayers.forEach((layer, index) => {
    const objectType = objectTypes.find((t) => t.apiName === layer.objectTypeApiName)
    if (!objectType) {
      missingTypes.push(layer.objectTypeApiName)
      return
    }
    const query = layerQueries[index]
    const rows = query?.data?.rows ?? []
    const baseColor = OBJECT_COLOR_HEX[objectType.color ?? ''] ?? '#6366f1'
    const detected = detectLatLngProperties(objectType.properties)
    const latProp = layer.latProperty ?? detected.lat ?? null
    const lngProp = layer.lngProperty ?? detected.lng ?? null
    const fallbackProp = layer.fallbackProperty ?? detectFallbackProperty(objectType.properties)

    const colorByProp = layer.colorBy && objectType.properties.some((p) => p.apiName === layer.colorBy) ? layer.colorBy : null
    const sizeByProp = layer.sizeBy && objectType.properties.some((p) => p.apiName === layer.sizeBy && p.dataType === 'number') ? layer.sizeBy : null
    const title = query?.data?.objectType?.titleProperty ?? objectType.primaryKey

    const palette = colorByProp
      ? categoryColors(rows.map((r) => String(r.values[colorByProp] ?? '—')))
      : null

    const sizeValues = sizeByProp
      ? rows.map((r) => Number(r.values[sizeByProp])).filter((n) => Number.isFinite(n))
      : []
    const min = sizeValues.length ? Math.min(...sizeValues) : 0
    const max = sizeValues.length ? Math.max(...sizeValues) : 1
    const range = max - min || 1

    const features: MapLayerData['features']['features'] = []
    let unplaced = 0
    for (const row of rows) {
      const point = resolveGeoPoint(row.values, {
        latProperty: latProp,
        lngProperty: lngProp,
        fallbackProperty: fallbackProp,
        pk: row.pk,
      })
      if (!point) {
        unplaced++
        continue
      }
      const colorValue = colorByProp ? String(row.values[colorByProp] ?? '—') : null
      const sizeValue = sizeByProp ? Number(row.values[sizeByProp]) : NaN
      const t = Number.isFinite(sizeValue) ? Math.min(1, Math.max(0, (sizeValue - min) / range)) : null
      const labelParts = [String(row.values[title] ?? row.pk)]
      if (colorByProp) labelParts.push(`${colorByProp}: ${colorValue}`)
      if (sizeByProp && t !== null) labelParts.push(`${sizeByProp}: ${sizeValue.toLocaleString('en-US')}`)
      if (point.source !== 'property') labelParts.push(point.source === 'city' ? 'city centroid' : 'country centroid')
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [point.lng, point.lat] },
        properties: {
          _pk: row.pk,
          _title: String(row.values[title] ?? row.pk),
          _type: objectType.apiName,
          _color: colorValue !== null && palette ? palette[colorValue] : baseColor,
          _radius: t !== null ? Math.round((5 + t * 11) * 10) / 10 : 7.5,
          _heat: t !== null ? 0.2 + t * 0.8 : 0.55,
          _label: labelParts.join(' · '),
        },
      })
    }
    unplacedTotal += unplaced

    built.push({ id: layer.id, name: objectType.displayName, features: { type: 'FeatureCollection', features }, unplaced })
    legend.push({
      id: layer.id,
      name: objectType.displayName,
      color: baseColor,
      count: features.length,
      visible: true,
      colorLegend: palette ? Object.entries(palette).map(([value, color]) => ({ value, color })) : null,
    })
  })

  // Hidden (toggled-off) layers still appear in the legend for re-enabling.
  for (const layer of widget.layers) {
    if (!hiddenLayers.has(layer.id)) continue
    const objectType = objectTypes.find((t) => t.apiName === layer.objectTypeApiName)
    legend.push({
      id: layer.id,
      name: objectType?.displayName ?? layer.objectTypeApiName,
      color: OBJECT_COLOR_HEX[objectType?.color ?? ''] ?? '#6366f1',
      count: 0,
      visible: false,
      colorLegend: null,
    })
  }

  const totalShown = built.reduce((sum, l) => sum + l.features.features.length, 0)

  // Primitive rebuild key: layer config + hidden set + query versions + filters.
  const dataKey = [
    widget.layers
      .map((l) => `${l.id}:${l.objectTypeApiName}:${l.visible}:${l.latProperty ?? ''}:${l.lngProperty ?? ''}:${l.fallbackProperty ?? ''}:${l.colorBy ?? ''}:${l.sizeBy ?? ''}`)
      .join(','),
    [...hiddenLayers].sort().join(','),
    layerQueries.map((q) => `${q.dataUpdatedAt}:${q.isLoading ? 'l' : q.isError ? 'e' : 'd'}`).join(','),
    JSON.stringify(filterValues),
    objectTypes.map((t) => `${t.apiName}:${t.properties.length}`).join(','),
  ].join('|')

  // Selection → map coordinates (only when the selected object is on a layer).
  let mapSelection: { objectTypeApiName: string; pk: string; lat: number; lng: number } | null = null
  if (selection) {
    outer: for (const layer of built) {
      for (const feature of layer.features.features) {
        if (feature.properties._type === selection.objectTypeApiName && String(feature.properties._pk) === selection.pk) {
          mapSelection = {
            objectTypeApiName: selection.objectTypeApiName,
            pk: selection.pk,
            lat: feature.geometry.coordinates[1],
            lng: feature.geometry.coordinates[0],
          }
          break outer
        }
      }
    }
  }
  const selectionKey = mapSelection
    ? `${mapSelection.objectTypeApiName}|${mapSelection.pk}|${mapSelection.lat}|${mapSelection.lng}`
    : ''

  const anyLoading = layerQueries.some((q) => q.isLoading)
  const anyError = layerQueries.find((q) => q.isError)

  const toggleLayer = (id: string) => {
    setHiddenLayers((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (widget.layers.length === 0) {
    return (
      <div className="flex h-[360px] flex-col items-center justify-center gap-2 rounded-md border border-dashed text-center sm:h-[440px]">
        <Layers className="h-7 w-7 text-muted-foreground/60" aria-hidden />
        <p className="text-sm font-medium text-muted-foreground">No map layers yet</p>
        <p className="max-w-xs text-xs text-muted-foreground/80">
          Edit this widget and add object-type layers — warehouses, suppliers, anything with coordinates or a
          city/country property.
        </p>
      </div>
    )
  }

  return (
    <div className="mf-map-shell relative h-[360px] overflow-hidden rounded-md border sm:h-[440px]">
      <MapCanvas
        layers={built}
        dataKey={dataKey}
        mode={mode}
        selection={mapSelection}
        selectionKey={selectionKey}
        onSelect={(ref) => onSelect(ref ? { objectTypeApiName: ref.objectTypeApiName, pk: ref.pk } : null)}
        apiRef={apiRef}
      />

      {/* Legend + layer visibility */}
      <div className="pointer-events-auto absolute left-2 top-2 z-[2] max-w-[62%] rounded-md border border-border/70 bg-background/85 p-2 shadow-sm backdrop-blur-sm">
        <p className="mb-1 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          <Layers className="h-3 w-3" aria-hidden /> Layers
        </p>
        <ul className="space-y-0.5">
          {legend.map((item) => (
            <li key={item.id} className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => toggleLayer(item.id)}
                className="flex items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-accent/60"
                title={item.visible ? `Hide ${item.name}` : `Show ${item.name}`}
                aria-pressed={item.visible}
              >
                {item.visible ? (
                  <Eye className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
                ) : (
                  <EyeOff className="h-3 w-3 shrink-0 text-muted-foreground/50" aria-hidden />
                )}
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: item.visible ? item.color : 'transparent', border: `1.5px solid ${item.color}` }}
                  aria-hidden
                />
                <span className={cn('truncate text-[11px]', item.visible ? 'text-foreground' : 'text-muted-foreground/60 line-through')}>
                  {item.name}
                </span>
                {item.visible && (
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{item.count}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
        {/* colorBy legend of visible layers */}
        {legend
          .filter((l) => l.visible && l.colorLegend)
          .map((l) => (
            <div key={`legend-${l.id}`} className="mt-1.5 border-t border-border/60 pt-1.5">
              <div className="flex flex-wrap gap-x-2 gap-y-0.5">
                {l.colorLegend!.slice(0, 8).map((entry) => (
                  <span key={entry.value} className="flex items-center gap-1 text-[10px] text-muted-foreground">
                    <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: entry.color }} aria-hidden />
                    {entry.value}
                  </span>
                ))}
              </div>
            </div>
          ))}
      </div>

      {/* Render mode switch */}
      <div className="absolute bottom-2 left-2 z-[2] flex items-center gap-0.5 rounded-md border border-border/70 bg-background/85 p-0.5 shadow-sm backdrop-blur-sm">
        {MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            onClick={() => setModeOverride(m.value === widget.mapMode ? 'saved' : m.value)}
            className={cn(
              'rounded px-2 py-1 text-[11px] transition-colors',
              mode === m.value ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground',
            )}
            aria-pressed={mode === m.value}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* Fit-to-data (raised above the attribution line) */}
      <Button
        variant="outline"
        size="icon"
        className="absolute bottom-7 right-2 z-[2] h-7 w-7 bg-background/85 backdrop-blur-sm"
        onClick={() => apiRef.current?.fitAll()}
        title="Zoom to fit all objects"
      >
        <Crosshair className="h-3.5 w-3.5" aria-hidden />
      </Button>

      {/* Status chips */}
      <div className="absolute right-2 top-2 z-[2] flex flex-col items-end gap-1 pr-9">
        {anyLoading && (
          <span className="flex items-center gap-1.5 rounded-md border border-border/70 bg-background/85 px-2 py-1 text-[11px] text-muted-foreground shadow-sm backdrop-blur-sm">
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Loading objects…
          </span>
        )}
        {!anyLoading && totalShown > 0 && (
          <span className="rounded-md border border-border/70 bg-background/85 px-2 py-1 font-mono text-[10px] text-muted-foreground shadow-sm backdrop-blur-sm">
            {totalShown.toLocaleString('en-US')} objects
          </span>
        )}
        {!anyLoading && unplacedTotal > 0 && (
          <span
            className="flex items-center gap-1 rounded-md border border-border/70 bg-background/85 px-2 py-1 text-[10px] text-muted-foreground shadow-sm backdrop-blur-sm"
            title="Rows without resolvable coordinates (no lat/lng and no known city/country). Add a latitude/longitude property or a city/country column to place them."
          >
            <MapPinOff className="h-3 w-3" aria-hidden /> {unplacedTotal} unplaced
          </span>
        )}
        {missingTypes.length > 0 && (
          <span className="flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-50 px-2 py-1 text-[10px] text-amber-700 shadow-sm dark:bg-amber-950/70 dark:text-amber-400">
            <TriangleAlert className="h-3 w-3" aria-hidden /> missing type{missingTypes.length > 1 ? 's' : ''}:{' '}
            {missingTypes.join(', ')}
          </span>
        )}
        {anyError && !anyLoading && (
          <span className="flex items-center gap-1 rounded-md border border-rose-500/40 bg-rose-50 px-2 py-1 text-[10px] text-rose-700 shadow-sm dark:bg-rose-950/70 dark:text-rose-400">
            <TriangleAlert className="h-3 w-3" aria-hidden />{' '}
            {anyError.error instanceof Error ? anyError.error.message : 'Layer failed to load'}
          </span>
        )}
      </div>
    </div>
  )
}
