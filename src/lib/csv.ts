// MiniFoundry — M10 CSV export helpers (RFC4180).
// Used by both export routes: the session-authed /api/datasets/[id]/export and
// the token-authed /api/foundry/v1/datasets/[id]/export.

import type { Row, SchemaColumn } from '@/lib/dataset-service'

/**
 * Render one CSV cell per RFC4180: quote when the value contains a comma,
 * double quote, newline or carriage return; double the quotes inside quotes.
 * null/undefined -> empty cell; objects/arrays -> compact JSON.
 */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  let s: string
  if (typeof value === 'object') {
    try {
      s = JSON.stringify(value)
    } catch {
      s = String(value)
    }
  } else {
    s = String(value)
  }
  if (/[",\n\r]/.test(s)) {
    s = `"${s.replace(/"/g, '""')}"`
  }
  return s
}

/**
 * Serialize rows to CSV text (utf-8, '\n' record separator):
 * header row from the schema column names, then one row per record in schema
 * column order (missing keys -> empty cell, extra keys dropped).
 * Empty rows -> header row only. Output always ends with a single newline.
 */
export function rowsToCsv(schema: SchemaColumn[], rows: Row[]): string {
  const lines: string[] = [schema.map((c) => csvCell(c.name)).join(',')]
  for (const row of rows) {
    lines.push(schema.map((c) => csvCell(row[c.name])).join(','))
  }
  return `${lines.join('\n')}\n`
}

/** URL/filesystem-safe slug for export filenames ("Active Shipments" -> "active-shipments"). */
export function slugifyName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'dataset'
}
