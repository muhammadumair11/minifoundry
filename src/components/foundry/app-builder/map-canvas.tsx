'use client'

// MapCanvas — the MapLibre GL surface inside an app map widget. Loaded via
// next/dynamic (ssr:false) by app-map-widget.tsx; keeps all imperative map
// code (sources, layers, popups, selection ring) in one place.
//
// Rendering modes:
//   markers — plain circles (per-feature color/radius, click selects)
//   cluster — MapLibre point clustering with count labels
//   heatmap — density layer weighted by the layer's sizeBy metric
//
// Tiles: OpenStreetMap raster (no API key). Dark theme is a CSS filter on the
// canvas applied by the parent shell (.mf-map-dark), which keeps a single
// style definition for both themes.
//
// React integration: the parent re-creates the `layers` array on every render,
// so rebuilds are driven by PRIMITIVE keys — `dataKey` (config + data version)
// and `selectionKey` — while the latest objects live in refs. This keeps map
// mutations (source/layer churn, flyTo) tied to real changes only.

import { useEffect, useRef } from 'react'
import { LngLatBounds, Map as GlMap, NavigationControl, Popup } from 'maplibre-gl'
import type { ExpressionSpecification, GeoJSONSource, MapMouseEvent, StyleSpecification } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { AppMapMode } from '@/lib/foundry-types'

export interface MapPointProperties {
  _pk: string
  _title: string
  _type: string
  _color: string
  _radius: number
  _heat: number
  _label: string
  [key: string]: unknown
}

export interface MapLayerData {
  id: string
  name: string
  features: GeoJSON.FeatureCollection<GeoJSON.Point, MapPointProperties>
  /** Rows that could not be placed (no coordinates resolvable). */
  unplaced: number
}

export interface MapSelectionRef {
  objectTypeApiName: string
  pk: string
  lat: number
  lng: number
}

export interface MapCanvasApi {
  fitAll: () => void
}

interface MapCanvasProps {
  layers: MapLayerData[]
  /** Primitive signature of layers' config+data — rebuild trigger. */
  dataKey: string
  mode: AppMapMode
  selection: MapSelectionRef | null
  /** Primitive signature of selection (type|pk|lat|lng) — flyTo trigger. */
  selectionKey: string
  onSelect: (ref: { objectTypeApiName: string; pk: string } | null) => void
  apiRef?: React.MutableRefObject<MapCanvasApi | null>
}

const BASE_STYLE: StyleSpecification = {
  version: 8,
  glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
      maxzoom: 19,
    },
  },
  layers: [{ id: 'osm-base', type: 'raster', source: 'osm', paint: { 'raster-saturation': -0.15 } }],
}

// heatmap-color must be an interpolate expression over heatmap-density.
const HEAT_RAMP = [
  'interpolate',
  ['linear'],
  ['heatmap-density'],
  0, 'rgba(59,130,246,0)',
  0.2, '#3b82f6',
  0.4, '#22c55e',
  0.6, '#eab308',
  0.8, '#f97316',
  1, '#ef4444',
] as unknown as ExpressionSpecification

function emptyCollection(): GeoJSON.FeatureCollection<GeoJSON.Point, MapPointProperties> {
  return { type: 'FeatureCollection', features: [] }
}

export default function MapCanvas({ layers, dataKey, mode, selection, selectionKey, onSelect, apiRef }: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<GlMap | null>(null)
  const popupRef = useRef<Popup | null>(null)
  const managedRef = useRef<{ sourceIds: string[]; layerIds: string[] }>({ sourceIds: [], layerIds: [] })
  const fittedRef = useRef(false)
  // Latest props kept in refs so effects keyed by primitives read fresh
  // values. The sync effect is declared FIRST, so on any render where a
  // keyed effect below fires, the refs already hold this render's props.
  const layersRef = useRef(layers)
  const selectionRef = useRef(selection)
  const onSelectRef = useRef(onSelect)
  useEffect(() => {
    layersRef.current = layers
    selectionRef.current = selection
    onSelectRef.current = onSelect
  })

  // ── map init (once) ────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    const map = new GlMap({
      container: containerRef.current,
      style: BASE_STYLE,
      center: [15, 25],
      zoom: 1.4,
      attributionControl: { compact: true },
    })
    map.addControl(new NavigationControl({ visualizePitch: false }), 'top-right')
    mapRef.current = map

    const observer = new ResizeObserver(() => map.resize())
    observer.observe(containerRef.current)

    map.on('click', (e: MapMouseEvent) => {
      // Click on empty space clears the selection; cluster clicks (which zoom)
      // must not clear it.
      const rendered = map.queryRenderedFeatures(e.point)
      if (rendered.some((f) => f.properties?.point_count)) return
      const hits = rendered.filter((f) => f.properties?._pk)
      if (hits.length === 0) onSelectRef.current(null)
    })

    return () => {
      observer.disconnect()
      popupRef.current?.remove()
      popupRef.current = null
      map.remove()
      mapRef.current = null
      fittedRef.current = false
    }
  }, [])

  // ── fit-to-data api for the parent overlay ─────────────────────────
  useEffect(() => {
    if (!apiRef) return
    apiRef.current = {
      fitAll: () => {
        const map = mapRef.current
        if (!map) return
        const bounds = new LngLatBounds()
        let found = false
        for (const layer of layersRef.current) {
          for (const f of layer.features.features) {
            bounds.extend(f.geometry.coordinates as [number, number])
            found = true
          }
        }
        if (found) map.fitBounds(bounds, { padding: 56, maxZoom: 11, duration: 700 })
      },
    }
  }, [apiRef])

  // ── rebuild sources + layers when data/mode changes ────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    const rebuild = () => {
      const currentLayers = layersRef.current
      // tear down previous managed layers/sources
      for (const id of managedRef.current.layerIds) {
        if (map.getLayer(id)) map.removeLayer(id)
      }
      for (const id of managedRef.current.sourceIds) {
        if (map.getSource(id)) map.removeSource(id)
      }
      const layerIds: string[] = []
      const sourceIds: string[] = []
      const pointLayerIds: string[] = []
      const clusterLayerIds: string[] = []

      for (const layer of currentLayers) {
        const sourceId = `app-${layer.id}`
        const clustering = mode === 'cluster'
        map.addSource(sourceId, {
          type: 'geojson',
          data: layer.features.features.length ? layer.features : emptyCollection(),
          ...(clustering ? { cluster: true, clusterMaxZoom: 13, clusterRadius: 46 } : {}),
        })
        sourceIds.push(sourceId)

        if (mode === 'heatmap') {
          const heatId = `${sourceId}-heat`
          map.addLayer({
            id: heatId,
            type: 'heatmap',
            source: sourceId,
            paint: {
              'heatmap-weight': ['interpolate', ['linear'], ['get', '_heat'], 0, 0.25, 1, 1],
              'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 0, 0.8, 12, 2.4],
              'heatmap-color': HEAT_RAMP,
              'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 0, 8, 10, 34],
              'heatmap-opacity': 0.72,
            },
          })
          layerIds.push(heatId)
          continue
        }

        if (clustering) {
          const clustersId = `${sourceId}-clusters`
          const countsId = `${sourceId}-counts`
          const pointsId = `${sourceId}-points`
          map.addLayer({
            id: clustersId,
            type: 'circle',
            source: sourceId,
            filter: ['has', 'point_count'],
            paint: {
              'circle-color': ['step', ['get', 'point_count'], '#6366f1', 20, '#8b5cf6', 60, '#a855f7'],
              'circle-radius': ['step', ['get', 'point_count'], 13, 20, 17, 60, 21],
              'circle-opacity': 0.85,
              'circle-stroke-color': 'rgba(255,255,255,0.75)',
              'circle-stroke-width': 1.5,
            },
          })
          map.addLayer({
            id: countsId,
            type: 'symbol',
            source: sourceId,
            filter: ['has', 'point_count'],
            layout: {
              'text-field': ['get', 'point_count_abbreviated'],
              'text-font': ['Open Sans Semibold'],
              'text-size': 11,
            },
            paint: { 'text-color': '#ffffff' },
          })
          map.addLayer({
            id: pointsId,
            type: 'circle',
            source: sourceId,
            filter: ['!', ['has', 'point_count']],
            paint: {
              'circle-radius': ['get', '_radius'],
              'circle-color': ['get', '_color'],
              'circle-opacity': 0.92,
              'circle-stroke-color': 'rgba(15,15,20,0.55)',
              'circle-stroke-width': 1,
            },
          })
          layerIds.push(clustersId, countsId, pointsId)
          pointLayerIds.push(pointsId)
          clusterLayerIds.push(clustersId)
        } else {
          const circlesId = `${sourceId}-circles`
          map.addLayer({
            id: circlesId,
            type: 'circle',
            source: sourceId,
            paint: {
              'circle-radius': ['get', '_radius'],
              'circle-color': ['get', '_color'],
              'circle-opacity': 0.92,
              'circle-stroke-color': 'rgba(15,15,20,0.55)',
              'circle-stroke-width': 1,
            },
          })
          layerIds.push(circlesId)
          pointLayerIds.push(circlesId)
        }
      }

      // ── selection ring on top (restore current selection) ──────────
      const sel = selectionRef.current
      map.addSource('app-selection', {
        type: 'geojson',
        data: sel
          ? ({
              type: 'FeatureCollection',
              features: [
                { type: 'Feature', geometry: { type: 'Point', coordinates: [sel.lng, sel.lat] }, properties: {} },
              ],
            } as GeoJSON.FeatureCollection)
          : emptyCollection(),
      })
      sourceIds.push('app-selection')
      map.addLayer({
        id: 'app-selection-ring',
        type: 'circle',
        source: 'app-selection',
        paint: {
          'circle-radius': 15,
          'circle-color': 'rgba(99,102,241,0.18)',
          'circle-stroke-color': '#6366f1',
          'circle-stroke-width': 2.5,
        },
      })
      layerIds.push('app-selection-ring')

      managedRef.current = { sourceIds, layerIds }

      // ── interactions ───────────────────────────────────────────────
      for (const id of pointLayerIds) {
        map.on('click', id, (e) => {
          const props = e.features?.[0]?.properties as unknown as MapPointProperties | undefined
          if (props?._pk && props?._type) {
            onSelectRef.current({ objectTypeApiName: props._type, pk: String(props._pk) })
          }
        })
        map.on('mouseenter', id, () => {
          map.getCanvas().style.cursor = 'pointer'
        })
        map.on('mouseleave', id, () => {
          map.getCanvas().style.cursor = ''
          popupRef.current?.remove()
          popupRef.current = null
        })
        map.on('mousemove', id, (e) => {
          const feature = e.features?.[0]
          const props = feature?.properties as unknown as MapPointProperties | undefined
          if (!feature || !props?._label) return
          let popup = popupRef.current
          if (!popup) {
            popup = new Popup({
              closeButton: false,
              closeOnClick: false,
              offset: 12,
              className: 'mf-map-popup',
              maxWidth: '260px',
            })
            popupRef.current = popup
          }
          const geometry = feature.geometry as GeoJSON.Point
          popup
            .setLngLat(geometry.coordinates as [number, number])
            .setHTML(`<span>${props._label.replace(/</g, '&lt;')}</span>`)
            .addTo(map)
        })
      }
      for (const id of clusterLayerIds) {
        map.on('click', id, (e) => {
          const features = map.queryRenderedFeatures(e.point, { layers: [id] })
          const props = features[0]?.properties as { cluster_id?: number } | undefined
          if (props?.cluster_id == null) return
          const source = map.getSource(id.replace('-clusters', '')) as GeoJSONSource | undefined
          const center = (features[0]?.geometry as GeoJSON.Point | undefined)?.coordinates as [number, number] | undefined
          if (!source || !center) return
          void source.getClusterExpansionZoom(props.cluster_id).then((zoom) => {
            map.easeTo({ center, zoom })
          })
        })
        map.on('mouseenter', id, () => {
          map.getCanvas().style.cursor = 'pointer'
        })
        map.on('mouseleave', id, () => {
          map.getCanvas().style.cursor = ''
        })
      }

      // First data arrival → fit the view once per mount.
      if (!fittedRef.current) {
        const hasPoints = currentLayers.some((l) => l.features.features.length > 0)
        if (hasPoints) {
          fittedRef.current = true
          const bounds = new LngLatBounds()
          for (const layer of currentLayers) {
            for (const f of layer.features.features) bounds.extend(f.geometry.coordinates as [number, number])
          }
          map.fitBounds(bounds, { padding: 56, maxZoom: 11, duration: 0 })
        }
      }
    }

    if (map.isStyleLoaded()) rebuild()
    else map.once('load', rebuild)
  }, [dataKey, mode])

  // ── selection ring + fly-to ────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const apply = () => {
      const source = map.getSource('app-selection') as GeoJSONSource | undefined
      const sel = selectionRef.current
      if (!source) return
      source.setData(
        sel
          ? ({
              type: 'FeatureCollection',
              features: [
                { type: 'Feature', geometry: { type: 'Point', coordinates: [sel.lng, sel.lat] }, properties: {} },
              ],
            } as GeoJSON.FeatureCollection)
          : emptyCollection(),
      )
      if (sel) {
        map.flyTo({ center: [sel.lng, sel.lat], zoom: Math.max(map.getZoom(), 4.5), duration: 800 })
      }
    }
    if (map.isStyleLoaded()) apply()
    else map.once('load', apply)
  }, [selectionKey])

  return <div ref={containerRef} className="h-full w-full" aria-label="Object map" role="application" />
}
