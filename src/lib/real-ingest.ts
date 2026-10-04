// MiniFoundry — R14 REAL HTTP/CSV ingestion (Task 14-b, egress-hardened Phase 0).
//
// Given a connector config { url, format: 'json'|'csv', dataPath? }, fetch the
// payload over HTTP and turn it into Row[] the dataset-service can version:
// - HTTP GET with a 10s timeout (AbortSignal), 2 MB size cap (streamed read),
//   and a 'MiniFoundry/1.0' User-Agent. SSRF egress guard (egress.ts): only
//   public http(s) targets — IP literals and ALL resolved DNS addresses are
//   checked against private/reserved ranges, and redirects are followed
//   manually with a 3-hop cap, re-validating every Location.
// - JSON: root array of objects, or an object resolved via dataPath (dot path
//   like "data.items") or the first array-valued key. Nested objects/arrays
//   inside rows are flattened ONE level (JSON.stringify for the nested value).
// - CSV: papaparse (via parsers.ts) with header row, quoted fields, CRLF;
//   values stay strings but columns that are UNIFORMLY numeric/boolean are
//   coerced so the schema inference sees real types.
// - More than 5000 rows are rejected; ingestion never silently drops rows.
// - Errors are explicit: non-2xx → status included, bad payload → detail,
//   empty row set → 'no rows found'.

import { parseCsvRows } from '@/lib/parsers'
import { assertPublicHttpUrl, egressFetch } from '@/lib/egress'
import type { Row } from '@/lib/dataset-service'

export interface RealIngestConfig {
  url: string
  format: 'json' | 'csv'
  /** Dot path to the row array inside a JSON object, e.g. "data.items". */
  dataPath?: string
}

export interface RealIngestResult {
  rows: Row[]
  format: 'json' | 'csv'
  rowCount: number
  /** Column names of the first row (sample for the test-connection dialog). */
  columns: string[]
}

const TIMEOUT_MS = 10_000
const MAX_BYTES = 2 * 1024 * 1024
const MAX_ROWS = 5000
const NUMERIC_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/
const BOOLEAN_VALUES = new Set(['true', 'false'])

/**
 * Fetch + parse a connector payload into rows. Throws Error with a clean,
 * user-facing message on every failure mode (fetch, status, size, parse,
 * empty rows).
 */
export async function fetchConnectorRows(config: RealIngestConfig): Promise<RealIngestResult> {
  const url = config.url?.trim()
  if (!url) throw new Error('A URL is required')
  // Egress guard runs FIRST (scheme + public-host validation) so private
  // targets fail before any network activity.
  await assertPublicHttpUrl(url)
  const text = await httpGetText(url)
  const rows =
    config.format === 'csv'
      ? csvRowsWithTypes(parseCsvRows(text))
      : jsonToRows(text, config.dataPath)

  if (rows.length === 0) throw new Error('no rows found')
  if (rows.length > MAX_ROWS) throw new Error(`Connector returned ${rows.length} rows; the current storage limit is ${MAX_ROWS}. No rows were written.`)
  return {
    rows,
    format: config.format,
    rowCount: rows.length,
    columns: Object.keys(rows[0] ?? {}),
  }
}

/** GET with SSRF egress controls, timeout + streamed 2MB cap; returns the body text. */
async function httpGetText(url: string): Promise<string> {
  let res: Response
  try {
    res = await egressFetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'User-Agent': 'MiniFoundry/1.0',
        accept: 'application/json, text/csv, text/plain, */*',
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Fetch failed: ${msg}`)
  }
  if (!res.ok) throw new Error(`Request failed with status ${res.status} ${res.statusText}`)

  // Stream the body with a hard size cap (never buffer more than MAX_BYTES+1).
  const reader = res.body?.getReader()
  if (!reader) {
    const text = await res.text()
    if (text.length > MAX_BYTES) throw new Error('Response exceeds the 2 MB size cap')
    return text
  }
  const decoder = new TextDecoder('utf-8')
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_BYTES) {
      try {
        await reader.cancel()
      } catch {
        // cancel is best-effort
      }
      throw new Error('Response exceeds the 2 MB size cap')
    }
    chunks.push(value)
  }
  const parts: string[] = []
  for (const chunk of chunks) parts.push(decoder.decode(chunk, { stream: true }))
  parts.push(decoder.decode())
  return parts.join('')
}

/**
 * JSON → rows. Accepts a root array of objects; when the root is an object the
 * row array is resolved via dataPath (dot path), falling back to the first
 * array-valued key (common keys first). Each row is flattened ONE level.
 */
function jsonToRows(text: string, dataPath?: string): Row[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new Error(`Invalid JSON: ${err instanceof Error ? err.message : 'parse error'}`)
  }

  let arr: unknown
  if (Array.isArray(parsed)) {
    arr = parsed
  } else if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>
    if (dataPath) {
      let cursor: unknown = obj
      for (const segment of dataPath.split('.').map((s) => s.trim()).filter(Boolean)) {
        if (cursor && typeof cursor === 'object' && segment in (cursor as Record<string, unknown>)) {
          cursor = (cursor as Record<string, unknown>)[segment]
        } else {
          throw new Error(`dataPath '${dataPath}' not found in the JSON payload`)
        }
      }
      arr = cursor
    } else {
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
  }

  if (!Array.isArray(arr)) {
    throw new Error(
      dataPath
        ? `dataPath '${dataPath}' does not point to an array`
        : 'JSON payload contains no array of objects',
    )
  }

  const rows = arr
    .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === 'object' && !Array.isArray(r))
    .map((r) => flattenOneLevel(r))
  if (rows.length === 0) throw new Error('no rows found')
  return rows
}

/** One-level flatten: nested objects/arrays become compact JSON strings. */
function flattenOneLevel(row: Record<string, unknown>): Row {
  const out: Row = {}
  for (const [key, value] of Object.entries(row)) {
    if (value !== null && typeof value === 'object') {
      try {
        out[key] = JSON.stringify(value)
      } catch {
        out[key] = String(value)
      }
    } else {
      out[key] = value
    }
  }
  return out
}

/**
 * CSV rows (papaparse, all values strings) → typed rows: a column whose
 * non-empty values are ALL numeric becomes number, all true/false becomes
 * boolean; anything else stays string. Header/quoted/CRLF handling lives in
 * the papaparse parser (parsers.ts).
 */
function csvRowsWithTypes(rows: Row[]): Row[] {
  if (rows.length === 0) return []
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter(
    (c) => c !== '' && !c.startsWith('__parsed_extra'),
  )
  const kinds = new Map<string, 'number' | 'boolean' | 'string'>()
  for (const column of columns) {
    let sawValue = false
    let numeric = true
    let boolean = true
    for (const row of rows) {
      const raw = row[column]
      if (raw === undefined || raw === null) continue
      const s = String(raw).trim()
      if (s === '') continue
      sawValue = true
      if (numeric && (!NUMERIC_RE.test(s) || /^[-+]?0\d/.test(s) ||
          !Number.isFinite(Number(s)) ||
          (Number.isInteger(Number(s)) && !Number.isSafeInteger(Number(s))))) numeric = false
      if (boolean && !BOOLEAN_VALUES.has(s.toLowerCase())) boolean = false
      if (!numeric && !boolean) break
    }
    kinds.set(column, !sawValue ? 'string' : numeric ? 'number' : boolean ? 'boolean' : 'string')
  }
  return rows.map((row) => {
    const out: Row = {}
    for (const column of columns) {
      const raw = row[column]
      const s = raw === undefined || raw === null ? '' : String(raw).trim()
      const kind = kinds.get(column) ?? 'string'
      if (s === '') {
        out[column] = null
      } else if (kind === 'number') {
        const n = Number(s)
        out[column] = Number.isNaN(n) ? s : n
      } else if (kind === 'boolean') {
        out[column] = s.toLowerCase() === 'true'
      } else {
        out[column] = raw
      }
    }
    return out
  })
}
