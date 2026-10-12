// MiniFoundry — offline geo helpers for Application maps.
//
// Objects land on a map in two ways:
//   1. GEO PROPERTIES — the backing row carries latitude/longitude columns
//      (auto-detected by name, or picked explicitly in the map layer config).
//   2. GEOCODE FALLBACK — rows without coordinates are placed through a
//      built-in, fully offline centroid table: first a city match, then a
//      country match, over the layer's fallback property (or any string
//      property named city/country/location/address).
//
// Deterministic hash jitter spreads multiple objects that resolve to the same
// centroid so they stay individually clickable. No network calls, ever.

export interface GeoPoint {
  lat: number
  lng: number
  /** How the coordinate was resolved — surfaced in map tooltips/legend. */
  source: 'property' | 'city' | 'country'
}

// ─── Centroid tables (offline geocoding) ─────────────────────────────

/** Country centroids keyed by lowercase name; common aliases included. */
export const COUNTRY_CENTROIDS: Record<string, [number, number]> = {
  'united states': [39.8, -98.6], 'usa': [39.8, -98.6], 'us': [39.8, -98.6], 'united states of america': [39.8, -98.6],
  germany: [51.1, 10.4], deutschland: [51.1, 10.4],
  japan: [36.2, 138.2],
  china: [35.0, 105.0],
  'south korea': [36.5, 127.8], 'republic of korea': [36.5, 127.8], korea: [36.5, 127.8],
  malaysia: [4.2, 101.9],
  italy: [41.9, 12.5], italia: [41.9, 12.5],
  mexico: [23.6, -102.5],
  vietnam: [14.1, 108.3],
  netherlands: [52.1, 5.3], holland: [52.1, 5.3],
  poland: [51.9, 19.1], polska: [51.9, 19.1],
  india: [20.6, 79.0],
  singapore: [1.35, 103.82],
  'united kingdom': [55.4, -3.4], uk: [55.4, -3.4], 'great britain': [55.4, -3.4],
  france: [46.2, 2.2],
  spain: [40.5, -3.7], espana: [40.5, -3.7],
  portugal: [39.4, -8.2],
  belgium: [50.5, 4.5],
  switzerland: [46.8, 8.2],
  austria: [47.5, 14.5],
  sweden: [60.1, 18.6],
  norway: [60.5, 8.5],
  denmark: [56.3, 10.6],
  finland: [61.9, 25.7],
  ireland: [53.4, -8.2],
  czechia: [49.8, 15.5], 'czech republic': [49.8, 15.5],
  romania: [45.9, 24.9],
  hungary: [47.2, 19.5],
  greece: [39.1, 21.8],
  turkey: [38.9, 35.2], turkiye: [38.9, 35.2],
  russia: [61.5, 105.3],
  ukraine: [48.4, 31.2],
  brazil: [-14.2, -51.9], brasil: [-14.2, -51.9],
  argentina: [-38.4, -63.6],
  chile: [-35.7, -71.5],
  colombia: [4.6, -74.3],
  peru: [-9.2, -75.0],
  canada: [56.1, -106.3],
  australia: [-25.3, 133.8],
  'new zealand': [-40.9, 174.9],
  indonesia: [-0.8, 113.9],
  thailand: [15.9, 101.1],
  philippines: [12.9, 121.8],
  pakistan: [30.4, 69.3],
  bangladesh: [23.7, 90.4],
  'saudi arabia': [23.9, 45.1],
  'united arab emirates': [23.4, 53.8], uae: [23.4, 53.8],
  israel: [31.0, 34.9],
  egypt: [26.8, 30.8],
  nigeria: [9.1, 8.7],
  'south africa': [-30.6, 22.9],
  kenya: [-0.02, 37.9],
  morocco: [31.8, -7.1],
}

/** City centroids — sample-data cities plus global logistics hubs. */
export const CITY_CENTROIDS: Record<string, [number, number]> = {
  rotterdam: [51.92, 4.48],
  singapore: [1.35, 103.82],
  chicago: [41.88, -87.63],
  hamburg: [53.55, 9.99],
  shenzhen: [22.54, 114.06],
  monterrey: [25.69, -100.32],
  munich: [48.14, 11.58],
  osaka: [34.69, 135.5],
  austin: [30.27, -97.74],
  cheonan: [36.81, 127.11],
  penang: [5.41, 100.34], 'george town': [5.41, 100.34],
  torino: [45.07, 7.69], turin: [45.07, 7.69],
  guadalajara: [20.67, -103.35],
  hanoi: [21.03, 105.85],
  eindhoven: [51.44, 5.48],
  gdansk: [54.35, 18.65],
  chennai: [13.08, 80.27],
  amsterdam: [52.37, 4.9],
  london: [51.51, -0.13],
  paris: [48.86, 2.35],
  berlin: [52.52, 13.4],
  madrid: [40.42, -3.7],
  milan: [45.46, 9.19],
  barcelona: [41.39, 2.17],
  warsaw: [52.23, 21.01],
  istanbul: [41.01, 28.98],
  dubai: [25.2, 55.27],
  mumbai: [19.08, 72.88],
  delhi: [28.61, 77.21],
  'new delhi': [28.61, 77.21],
  bangalore: [12.97, 77.59], bengaluru: [12.97, 77.59],
  shanghai: [31.23, 121.47],
  beijing: [39.9, 116.4],
  tokyo: [35.68, 139.69],
  seoul: [37.57, 126.98],
  'taipei': [25.03, 121.57],
  bangkok: [13.76, 100.5],
  'ho chi minh city': [10.82, 106.63], saigon: [10.82, 106.63],
  jakarta: [-6.21, 106.85],
  manila: [14.6, 120.98],
  sydney: [-33.87, 151.21],
  melbourne: [-37.81, 144.96],
  auckland: [-36.85, 174.76],
  'new york': [40.71, -74.01],
  'new jersey': [40.72, -74.17], newark: [40.74, -74.17],
  'los angeles': [34.05, -118.24],
  'san francisco': [37.77, -122.42],
  seattle: [47.61, -122.33],
  dallas: [32.78, -96.8],
  houston: [29.76, -95.37],
  atlanta: [33.75, -84.39],
  miami: [25.76, -80.19],
  toronto: [43.65, -79.38],
  vancouver: [49.28, -123.12],
  'panama city': [8.98, -79.52],
  santos: [-23.96, -46.33],
  'sao paulo': [-23.55, -46.63],
  'buenos aires': [-34.6, -58.38],
  'cape town': [-33.92, 18.42],
  lagos: [6.52, 3.38],
  nairobi: [-1.29, 36.82],
  cairo: [30.04, 31.24],
  antwerp: [51.26, 4.4],
  'le havre': [49.49, 0.11],
  bremen: [53.08, 8.8],
  genoa: [44.41, 8.93],
  valencia: [39.47, -0.38],
  lisbon: [38.72, -9.14],
}

// ─── Property detection ──────────────────────────────────────────────

const LAT_NAME = /^(lat|latitude|y|geo_?lat)(itude)?$/i
const LNG_NAME = /^(lng|lon|long|longitude|x|geo_?l(n)?g|geo_?lon)(itude)?$/i
const CITY_NAME = /^(city|town|municipality)$/i
const COUNTRY_NAME = /^(country|nation)$/i
const LOCATION_NAME = /^(location|place|address|geo|coordinates?)$/i

export interface PropertyLike {
  apiName: string
  dataType: string
}

/**
 * Auto-detect coordinate columns on an object type: explicit latitude/
 * longitude-named number properties win; returns undefined sides when absent
 * (callers then fall back to centroid geocoding).
 */
export function detectLatLngProperties(
  properties: PropertyLike[],
): { lat?: string; lng?: string } {
  const numeric = properties.filter((p) => p.dataType === 'number')
  return {
    lat: numeric.find((p) => LAT_NAME.test(p.apiName))?.apiName,
    lng: numeric.find((p) => LNG_NAME.test(p.apiName))?.apiName,
  }
}

/** Default fallback property for centroid geocoding: city beats country. */
export function detectFallbackProperty(properties: PropertyLike[]): string | null {
  const strings = properties.filter((p) => p.dataType === 'string').map((p) => p.apiName)
  return (
    strings.find((name) => CITY_NAME.test(name)) ??
    strings.find((name) => COUNTRY_NAME.test(name)) ??
    strings.find((name) => LOCATION_NAME.test(name)) ??
    null
  )
}

// ─── Coordinate resolution ───────────────────────────────────────────

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return null
}

/** Deterministic 32-bit string hash (FNV-1a) → [0, 1). */
function hash01(key: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return ((h >>> 0) % 100000) / 100000
}

/**
 * Deterministic jitter (±0.7° lat, ±0.9° lng scaled by cosine) so multiple
 * objects sharing a centroid stay individually clickable without drifting
 * into a different region.
 */
export function jitterPoint(seed: string, lat: number, lng: number): [number, number] {
  const a = hash01(`${seed}|lat`)
  const b = hash01(`${seed}|lng`)
  const cos = Math.max(0.2, Math.cos((lat * Math.PI) / 180))
  return [
    Math.round((lat + (a - 0.5) * 1.4) * 10000) / 10000,
    Math.round((lng + ((b - 0.5) * 1.8) / cos) * 10000) / 10000,
  ]
}

function lookup(table: Record<string, [number, number]>, raw: unknown): [number, number] | null {
  if (typeof raw !== 'string') return null
  // "Rotterdam, Netherlands" / "Rotterdam 3011" — try progressively shorter heads.
  const cleaned = raw.trim().toLowerCase()
  if (cleaned === '') return null
  if (table[cleaned]) return table[cleaned]
  const head = cleaned.split(/[,;|]/)[0].trim()
  if (head && table[head]) return table[head]
  const words = head.split(/\s+/)
  if (words.length > 1) {
    const first = table[words[0]]
    if (first) return first
  }
  return null
}

export interface ResolveGeoOptions {
  latProperty?: string | null
  lngProperty?: string | null
  /** String property scanned for city/country names (e.g. 'city', 'country'). */
  fallbackProperty?: string | null
  /** Object primary key — jitter seed. */
  pk: string
  /** When true, apply deterministic jitter to centroid-resolved points. */
  jitter?: boolean
}

/**
 * Resolve a row to a map coordinate: explicit lat/lng properties first,
 * then city centroids, then country centroids (fallback property first,
 * then any city/country/location-named string property on the row).
 */
export function resolveGeoPoint(
  values: Record<string, unknown>,
  opts: ResolveGeoOptions,
): GeoPoint | null {
  const lat = opts.latProperty ? toFiniteNumber(values[opts.latProperty]) : null
  const lng = opts.lngProperty ? toFiniteNumber(values[opts.lngProperty]) : null
  if (lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    return { lat, lng, source: 'property' }
  }

  const candidates: unknown[] = []
  if (opts.fallbackProperty) candidates.push(values[opts.fallbackProperty])
  for (const [name, value] of Object.entries(values)) {
    if (name === opts.fallbackProperty) continue
    if (CITY_NAME.test(name) || COUNTRY_NAME.test(name) || LOCATION_NAME.test(name)) {
      candidates.push(value)
    }
  }

  for (const candidate of candidates) {
    const city = lookup(CITY_CENTROIDS, candidate)
    if (city) {
      const [jLat, jLng] = opts.jitter === false ? city : jitterPoint(opts.pk, city[0], city[1])
      return { lat: jLat, lng: jLng, source: 'city' }
    }
  }
  for (const candidate of candidates) {
    const country = lookup(COUNTRY_CENTROIDS, candidate)
    if (country) {
      const [jLat, jLng] = opts.jitter === false ? country : jitterPoint(opts.pk, country[0], country[1])
      return { lat: jLat, lng: jLng, source: 'country' }
    }
  }
  return null
}

// ─── Styling helpers shared by map layers ────────────────────────────

/** Ontology accent key → map marker hex. */
export const OBJECT_COLOR_HEX: Record<string, string> = {
  emerald: '#10b981',
  teal: '#14b8a6',
  amber: '#f59e0b',
  rose: '#f43f5e',
  orange: '#f97316',
  zinc: '#71717a',
}

/** Categorical palette for colorBy legends (Tableau-10-ish, dark-mode safe). */
export const CATEGORY_PALETTE = [
  '#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f',
  '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac',
]

/** Stable category → palette color assignment (sorted keys). */
export function categoryColors(values: Iterable<string>): Record<string, string> {
  const sorted = [...new Set(values)].sort((a, b) => a.localeCompare(b))
  const out: Record<string, string> = {}
  sorted.forEach((value, i) => {
    out[value] = CATEGORY_PALETTE[i % CATEGORY_PALETTE.length]
  })
  return out
}
