// GET /api/datasets/[id]/diff?from=<n>&to=<m> — R14 version diff.
// Schema diff (added/removed/changed columns by name+type) plus a row diff
// keyed by the FIRST schema column value: addedRows / removedRows /
// changedRows (before/after). Each list capped at 100 (truncated=true).

import { db } from '@/lib/db'
import { badRequest, jsonError, jsonOk, serverError } from '@/lib/api-utils'
import { parseJsonSafe } from '@/lib/api-utils'
import type { Row, SchemaColumn } from '@/lib/dataset-service'
import type { VersionDiffResponse } from '@/lib/foundry-types'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

const CAP = 100

/** Canonical JSON so row objects with equal content but different key order compare equal. */
function canonical(row: Row): string {
  return JSON.stringify(
    Object.keys(row)
      .sort()
      .map((k) => [k, row[k]]),
  )
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const dataset = await db.dataset.findUnique({ where: { id }, select: { id: true } })
    if (!dataset) return jsonError(404, `Dataset '${id}' not found`)

    const url = new URL(req.url)
    const fromNum = Number(url.searchParams.get('from'))
    const toNum = Number(url.searchParams.get('to'))
    if (!Number.isInteger(fromNum) || fromNum < 1 || !Number.isInteger(toNum) || toNum < 1) {
      return badRequest("Query parameters 'from' and 'to' must be version numbers")
    }

    const [fromVersion, toVersion] = await Promise.all([
      db.datasetVersion.findUnique({
        where: { datasetId_versionNumber: { datasetId: id, versionNumber: fromNum } },
        select: { schemaJson: true, dataJson: true, rowCount: true },
      }),
      db.datasetVersion.findUnique({
        where: { datasetId_versionNumber: { datasetId: id, versionNumber: toNum } },
        select: { schemaJson: true, dataJson: true, rowCount: true },
      }),
    ])
    if (!fromVersion) return badRequest(`Version ${fromNum} not found`)
    if (!toVersion) return badRequest(`Version ${toNum} not found`)

    const fromSchema = parseJsonSafe<SchemaColumn[]>(fromVersion.schemaJson, [])
    const toSchema = parseJsonSafe<SchemaColumn[]>(toVersion.schemaJson, [])

    // ── Schema diff (by column name, type changes flagged) ──
    const fromCols = new Map(fromSchema.map((c) => [c.name, c]))
    const toCols = new Map(toSchema.map((c) => [c.name, c]))
    const schema: VersionDiffResponse['schema'] = {
      added: toSchema.filter((c) => !fromCols.has(c.name)).map((c) => ({ name: c.name, type: c.type })),
      removed: fromSchema.filter((c) => !toCols.has(c.name)).map((c) => ({ name: c.name, type: c.type })),
      changed: toSchema
        .filter((c) => {
          const prev = fromCols.get(c.name)
          return prev && prev.type !== c.type
        })
        .map((c) => ({ name: c.name, fromType: String(fromCols.get(c.name)?.type), toType: c.type })),
    }

    // ── Row diff keyed by the FIRST schema column value ──
    const keyColumn = toSchema[0]?.name ?? fromSchema[0]?.name ?? null
    const fromRows = parseJsonSafe<Row[]>(fromVersion.dataJson, [])
    const toRows = parseJsonSafe<Row[]>(toVersion.dataJson, [])

    const addedRows: Row[] = []
    const removedRows: Row[] = []
    const changedRows: VersionDiffResponse['changedRows'] = []
    let truncated = false

    if (keyColumn) {
      const keyOf = (row: Row): string => {
        const v = row[keyColumn]
        return v === null || v === undefined ? '∅null' : String(v)
      }
      const fromMap = new Map<string, Row>()
      for (const row of fromRows) if (!fromMap.has(keyOf(row))) fromMap.set(keyOf(row), row)
      const toMap = new Map<string, Row>()
      for (const row of toRows) if (!toMap.has(keyOf(row))) toMap.set(keyOf(row), row)

      for (const row of toRows) {
        const key = keyOf(row)
        const prev = fromMap.get(key)
        if (!prev) {
          if (addedRows.length < CAP) addedRows.push(row)
          else truncated = true
        } else if (canonical(prev) !== canonical(row)) {
          if (changedRows.length < CAP) changedRows.push({ key, before: prev, after: row })
          else truncated = true
        }
      }
      for (const row of fromRows) {
        const key = keyOf(row)
        if (!toMap.has(key)) {
          if (removedRows.length < CAP) removedRows.push(row)
          else truncated = true
        }
      }
    }

    const diff: VersionDiffResponse = {
      datasetId: id,
      fromVersion: fromNum,
      toVersion: toNum,
      schema,
      rowCount: { from: fromRows.length, to: toRows.length },
      addedRows,
      removedRows,
      changedRows,
      truncated,
    }
    return jsonOk(diff)
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to compute diff')
  }
}
