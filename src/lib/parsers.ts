// MiniFoundry — raw payload parsers for ingestion (JSON / CSV / URL fetch).

import Papa from 'papaparse'
import type { Row } from '@/lib/dataset-service'

export type ParsedSource = { rows: Row[]; format: 'json' | 'csv' }

/**
 * Parse a JSON payload into rows. Accepts a top-level array of objects, or an
 * object containing such an array under a common key (data/rows/items/records/results),
 * or the first array-of-objects property found. Returns null when not parseable as JSON.
 */
export function parseJsonRows(text: string): Row[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }

  let arr: unknown[] | null = null
  if (Array.isArray(parsed)) {
    arr = parsed
  } else if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>
    for (const key of ['data', 'rows', 'items', 'records', 'results']) {
      if (Array.isArray(obj[key])) {
        arr = obj[key]
        break
      }
    }
    if (!arr) {
      for (const value of Object.values(obj)) {
        if (Array.isArray(value)) {
          arr = value
          break
        }
      }
    }
  }
  if (!arr) return null

  const rows = arr.filter(
    (r): r is Row => Boolean(r) && typeof r === 'object' && !Array.isArray(r),
  )
  return rows.length > 0 ? rows : null
}

/** Parse CSV text into row objects (papaparse, headers + empty-line skipping). */
export function parseCsvRows(text: string): Row[] {
  const result = Papa.parse<Record<string, unknown>>(text, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
  })
  return (result.data ?? []).filter(
    (r): r is Row => Boolean(r) && typeof r === 'object' && !Array.isArray(r),
  )
}

/**
 * Parse raw text: try JSON first, fall back to CSV.
 * Throws when neither yields rows.
 */
export function parseRawText(text: string): ParsedSource {
  const jsonRows = parseJsonRows(text)
  if (jsonRows) return { rows: jsonRows, format: 'json' }
  const csvRows = parseCsvRows(text)
  if (csvRows.length === 0) {
    throw new Error('No parseable rows found — payload is neither valid JSON nor CSV')
  }
  return { rows: csvRows, format: 'csv' }
}

/** Fetch a URL and parse the response as JSON or CSV (sniffed from headers/content). */
export async function fetchRowsFromUrl(url: string): Promise<ParsedSource> {
  let res: Response
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      redirect: 'follow',
      headers: { accept: 'application/json, text/csv, text/plain, */*' },
    })
  } catch (err) {
    throw new Error(`URL fetch failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!res.ok) {
    throw new Error(`URL fetch failed with status ${res.status} ${res.statusText}`)
  }
  const text = await res.text()
  const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
  const looksJson = contentType.includes('json') || /^\s*[[{]/.test(text)

  if (looksJson) {
    const rows = parseJsonRows(text)
    if (rows) return { rows, format: 'json' }
    throw new Error('URL returned JSON but no array of objects could be found')
  }
  const rows = parseCsvRows(text)
  if (rows.length === 0) {
    throw new Error('URL response contained no parseable CSV rows')
  }
  return { rows, format: 'csv' }
}
