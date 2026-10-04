// MiniFoundry — shared dataset service.
// Row normalization, schema inference and dataset/version creation.
// Used by BOTH /api/ingest and the seeder, and by the pipeline engine (output node).

import { db } from '@/lib/db'
import { parseJsonSafe } from '@/lib/api-utils'
import type { Dataset, DatasetVersion } from '@prisma/client'

export type Row = Record<string, unknown>
export type ColumnType = 'string' | 'number' | 'boolean'

export interface SchemaColumn {
  name: string
  type: ColumnType
}

/** Raw data is capped at this many rows per dataset version. */
export const MAX_ROWS = 5000

// Plain decimal number: "42", "-3.14", "0.5" (no scientific notation, no leading '+')
const NUMERIC_RE = /^-?(?:\d+\.?\d*|\.\d+)$/

/**
 * Normalize a raw cell value:
 * - trim strings
 * - "true"/"false" -> boolean
 * - numeric-looking strings -> number
 */
export function normalizeValue(v: unknown): unknown {
  if (typeof v === 'string') {
    const t = v.trim()
    if (t === '') return ''
    if (t === 'true') return true
    if (t === 'false') return false
    // Keep identifier-like values such as ZIP codes and large integers exact.
    if (NUMERIC_RE.test(t) && !/^-?0\d/.test(t)) {
      const n = Number(t)
      if (Number.isFinite(n) && (!Number.isInteger(n) || Number.isSafeInteger(n))) return n
    }
    return t
  }
  return v
}

/** Trim keys and normalize every cell of every row, preserving column order. */
export function normalizeRows(rows: Row[]): Row[] {
  return rows.map((raw) => {
    const row: Row = {}
    for (const [key, value] of Object.entries(raw)) {
      const k = key.trim() === '' ? key : key.trim()
      row[k] = normalizeValue(value)
    }
    return row
  })
}

/**
 * Infer a column list [{ name, type }] from rows.
 * Column order follows first appearance across rows.
 * A column is "number"/"boolean" only if every non-null value has that type;
 * anything else (including mixed or missing values) falls back to "string".
 */
export function inferSchema(rows: Row[]): SchemaColumn[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key)
        names.push(key)
      }
    }
  }
  return names.map((name) => {
    const values = rows
      .map((r) => r[name])
      .filter((v) => v !== null && v !== undefined)
    let type: ColumnType = 'string'
    if (values.length > 0 && values.every((v) => typeof v === 'number')) type = 'number'
    else if (values.length > 0 && values.every((v) => typeof v === 'boolean')) type = 'boolean'
    return { name, type }
  })
}

export interface CreateDatasetOptions {
  name: string
  description?: string | null
  connectorId?: string | null
  projectId?: string | null
  tags?: string[]
  /** createdBy: ingestion id | pipeline run id | "seed" */
  createdBy?: string | null
  outputJobId?: string | null
  rows: Row[]
}

export interface CreateDatasetResult {
  dataset: Dataset
  version: DatasetVersion
  schema: SchemaColumn[]
  rowCount: number
  truncated: boolean
}

/**
 * Create (or append a new version to) a dataset from raw rows.
 * - If no dataset with the exact name exists: create one (with tags) + version 1.
 * - If one exists: append the next version (max versionNumber + 1) and touch updatedAt.
 * Oversized versions fail explicitly rather than silently discarding rows.
 */
export async function createDatasetFromRows(opts: CreateDatasetOptions): Promise<CreateDatasetResult> {
  if (opts.rows.length > MAX_ROWS) {
    throw new Error(`Dataset version has ${opts.rows.length} rows; the current storage limit is ${MAX_ROWS}. No rows were written.`)
  }
  const truncated = false
  const normalized = normalizeRows(opts.rows)
  const schema = inferSchema(normalized)
  const dataJson = JSON.stringify(normalized)

  const existing = await db.dataset.findFirst({
    where: { name: opts.name },
    include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1 } },
  })

  if (existing) {
    const nextVersionNumber = (existing.versions[0]?.versionNumber ?? 0) + 1
    const lifecycle = existing.qualityGate ? 'draft' : 'published'
    const [version, dataset] = await db.$transaction([
      db.datasetVersion.create({
        data: {
          datasetId: existing.id,
          versionNumber: nextVersionNumber,
          schemaJson: JSON.stringify(schema),
          rowCount: normalized.length,
          dataJson,
          createdBy: opts.createdBy ?? null,
          outputJobId: opts.outputJobId ?? null,
          lifecycle,
        },
      }),
      db.dataset.update({
        where: { id: existing.id },
        data: {
          updatedAt: new Date(),
          ...(opts.description !== undefined ? { description: opts.description } : {}),
          ...(opts.connectorId ? { sourceConnectorId: opts.connectorId } : {}),
          ...(existing.qualityGate ? {} : { publishedVersion: nextVersionNumber }),
        },
      }),
    ])
    // Write rows to indexed storage for paged reads
    await writeVersionRows(existing.id, nextVersionNumber, normalized)
    await pruneDatasetVersions(existing.id, existing.keepLastN)
    return { dataset, version, schema, rowCount: normalized.length, truncated }
  }

  const dataset = await db.dataset.create({
    data: {
      name: opts.name,
      description: opts.description ?? null,
      projectId: opts.projectId ?? null,
      sourceConnectorId: opts.connectorId ?? null,
      tags: JSON.stringify(opts.tags ?? []),
      publishedVersion: 1,
    },
  })
  const version = await db.datasetVersion.create({
    data: {
      datasetId: dataset.id,
      versionNumber: 1,
      schemaJson: JSON.stringify(schema),
      rowCount: normalized.length,
      dataJson,
      createdBy: opts.createdBy ?? null,
      outputJobId: opts.outputJobId ?? null,
      lifecycle: 'published',
    },
  })
  await writeVersionRows(dataset.id, 1, normalized)
  return { dataset, version, schema, rowCount: normalized.length, truncated }
}

/**
 * Write rows to the indexed DatasetVersionRow table for paged access.
 * Uses batched inserts to stay within SQLite variable limits.
 */
async function writeVersionRows(datasetId: string, versionNumber: number, rows: Row[]): Promise<void> {
  if (rows.length === 0) return
  const BATCH_SIZE = 100
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)
    await db.datasetVersionRow.createMany({
      data: batch.map((row, idx) => ({
        datasetId,
        versionNumber,
        rowIndex: i + idx,
        rowData: JSON.stringify(row),
      })),
    })
  }
}

/**
 * Read rows from the indexed storage with pagination.
 * Falls back to dataJson parsing if no indexed rows exist (legacy versions).
 */
export async function readVersionRowsPaged(
  datasetId: string,
  versionNumber: number,
  page: number,
  pageSize: number,
): Promise<{ rows: Row[]; total: number }> {
  // Check if indexed rows exist
  const count = await db.datasetVersionRow.count({
    where: { datasetId, versionNumber },
  })
  if (count > 0) {
    const skip = (page - 1) * pageSize
    const raw = await db.datasetVersionRow.findMany({
      where: { datasetId, versionNumber },
      orderBy: { rowIndex: 'asc' },
      skip,
      take: pageSize,
      select: { rowData: true },
    })
    return {
      rows: raw.map((r) => parseJsonSafe<Row>(r.rowData, {})),
      total: count,
    }
  }
  // Fallback: parse dataJson from version record
  const version = await db.datasetVersion.findUnique({
    where: { datasetId_versionNumber: { datasetId, versionNumber } },
    select: { dataJson: true, rowCount: true },
  })
  if (!version) return { rows: [], total: 0 }
  const allRows = parseJsonSafe<Row[]>(version.dataJson, [])
  const start = (page - 1) * pageSize
  return {
    rows: allRows.slice(start, start + pageSize),
    total: version.rowCount,
  }
}

/**
 * P2 trust workflow — resolve the version a CONSUMER (pipeline source,
 * dashboard, object layer, public API) should read for a dataset.
 * - explicit versionNumber always wins (replays / studio views).
 * - gate ON  → the last PUBLISHED version (falls back to head while null).
 * - gate OFF → head.
 * Returns null when the dataset has no versions.
 */
export async function resolveConsumerVersion(datasetId: string): Promise<{
  versionNumber: number | null
  gated: boolean
  publishedVersion: number | null
} | null> {
  const dataset = await db.dataset.findUnique({
    where: { id: datasetId },
    select: { qualityGate: true, publishedVersion: true },
  })
  if (!dataset) return null
  const head = await db.datasetVersion.findFirst({
    where: { datasetId, branch: 'main' },
    orderBy: { versionNumber: 'desc' },
    select: { versionNumber: true },
  })
  if (!head) return { versionNumber: null, gated: dataset.qualityGate, publishedVersion: dataset.publishedVersion }
  const versionNumber = dataset.qualityGate ? dataset.publishedVersion : head.versionNumber
  return { versionNumber, gated: dataset.qualityGate, publishedVersion: dataset.publishedVersion }
}

/** Fetch the latest version of a dataset (or a specific version number). */
export async function getDatasetVersion(datasetId: string, versionNumber?: number) {
  if (versionNumber !== undefined) {
    return db.datasetVersion.findUnique({
      where: { datasetId_versionNumber: { datasetId, versionNumber } },
    })
  }
  return db.datasetVersion.findFirst({
    where: { datasetId, branch: 'main' },
    orderBy: { versionNumber: 'desc' },
  })
}

/**
 * M2 retention: keep only the newest `keepLastN` versions of a dataset.
 * keepLastN <= 0 means unlimited (no pruning). Excess versions are the ones
 * with the LOWEST versionNumbers. Returns the number of deleted versions.
 *
 * R14 branch safety: only `branch='main'` versions are prune candidates and
 * the 2 newest main versions are always kept. Any version referenced as a
 * branch headVersion or baseVersion is never pruned either — branch pointers
 * must stay resolvable.
 */
export async function pruneDatasetVersions(datasetId: string, keepLastN: number): Promise<number> {
  if (keepLastN <= 0) return 0
  const versions = await db.datasetVersion.findMany({
    where: { datasetId, branch: 'main' },
    orderBy: { versionNumber: 'desc' },
    select: { id: true, versionNumber: true, outputJobId: true },
  })
  // Never touch the newest 2 main versions (merge parents / active lineage).
  const keepCount = Math.max(keepLastN, 2)
  if (versions.length <= keepCount) return 0
  const branchRefs = await db.datasetBranch.findMany({
    where: { datasetId },
    select: { headVersion: true, baseVersion: true },
  })
  const protectedNums = new Set<number>()
  const consumer = await db.dataset.findUnique({
    where: { id: datasetId }, select: { publishedVersion: true },
  })
  if (consumer?.publishedVersion != null) protectedNums.add(consumer.publishedVersion)
  const approvals = await db.approvalRequest.findMany({
    where: { kind: 'publish_dataset', targetId: datasetId, status: 'pending' },
    select: { versionNumber: true },
  })
  for (const approval of approvals) {
    if (approval.versionNumber != null) protectedNums.add(approval.versionNumber)
  }
  for (const b of branchRefs) {
    protectedNums.add(b.headVersion)
    protectedNums.add(b.baseVersion)
  }
  const activeOutputJobs = versions.flatMap((version) => version.outputJobId ? [version.outputJobId] : [])
  if (activeOutputJobs.length > 0) {
    const activeJobs = await db.executionJob.findMany({
      where: { id: { in: activeOutputJobs }, status: { in: ['queued', 'running'] } },
      select: { id: true },
    })
    const activeIds = new Set(activeJobs.map((job) => job.id))
    for (const version of versions) {
      if (version.outputJobId && activeIds.has(version.outputJobId)) protectedNums.add(version.versionNumber)
    }
  }
  const excessIds = versions
    .slice(keepCount)
    .filter((v) => !protectedNums.has(v.versionNumber))
    .map((v) => v.id)
  if (excessIds.length === 0) return 0
  const result = await db.datasetVersion.deleteMany({ where: { id: { in: excessIds } } })
  return result.count
}

// ─── Shared value comparison helpers (engine + row queries) ─────────

/** Coerce a value to a number; NaN when not numeric. */
export function toNumber(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return NaN
}

/** Numeric compare when both sides are numeric, otherwise string compare. */
export function compareValues(a: unknown, b: unknown): number {
  const x = toNumber(a)
  const y = toNumber(b)
  if (!Number.isNaN(x) && !Number.isNaN(y)) return x < y ? -1 : x > y ? 1 : 0
  const sa = String(a ?? '')
  const sb = String(b ?? '')
  return sa < sb ? -1 : sa > sb ? 1 : 0
}
