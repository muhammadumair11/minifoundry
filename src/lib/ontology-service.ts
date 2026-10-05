// MiniFoundry — M7 Ontology semantic layer service.
// Shared logic for object types, object rows, links and action write-back.
// Dataset rows live in DatasetVersion.dataJson (JSON array of row objects);
// the latest version is the one with the highest versionNumber.

import { db } from '@/lib/db'
import type { ActionType, Dataset, ObjectType, Prisma } from '@prisma/client'
import {
  compareValues,
  createDatasetFromRows,
  getDatasetVersion,
  inferSchema,
  MAX_ROWS,
  normalizeRows,
  pruneDatasetVersions,
  resolveConsumerVersion,
  toNumber,
  type Row,
  type SchemaColumn,
} from '@/lib/dataset-service'
import { emitVersionCreated, getHeadVersionNumber } from '@/lib/version-events'
import { MASK_LITERAL } from '@/lib/governance'
import { parseJsonSafe } from '@/lib/api-utils'

// ─── Shared shapes ───────────────────────────────────────────────────

/** Minimal object-type shape needed to map dataset rows onto objects. */
export interface ObjectTypeCore {
  id: string
  apiName: string
  displayName: string
  primaryKey: string | null
  sourceDatasetId: string | null
  icon?: string
  color?: string
  properties?: PropertyLike[]
}

export interface PropertyLike {
  apiName: string
  displayName: string
  dataType: string
  isTitle: boolean
  hideInTable: boolean
}

export interface LinkTypeWithType {
  id: string
  apiName: string
  displayName: string
  cardinality: string
  fkProperty: string | null
  linkDatasetId: string | null
  fromTypeId: string
  toTypeId: string
  fromType?: ObjectTypeCore | null
  toType?: ObjectTypeCore | null
}

export interface ObjectRow {
  pk: unknown
  values: Row
  _title: unknown
}

export interface ObjectRowsResult {
  rows: ObjectRow[]
  total: number
  columns: PropertyLike[]
}

export interface LinkTarget {
  pk: unknown
  _title: unknown
}

export interface LinkEntry {
  id: string
  apiName: string
  displayName: string
  /** outgoing = this type -> other type; incoming = other type -> this type */
  direction: 'outgoing' | 'incoming'
  cardinality: string
  toTypeId: string
  toTypeApiName: string
  toTypeDisplayName: string
  toTypeIcon: string
  toTypeColor: string
  /** R14.8: how many related instances exist in total (targets are a sample). */
  total: number
  /** R14.8: fk column (one-to-many) so "view all" can deep-link a filtered list. */
  fkProperty: string | null
  targets: LinkTarget[]
}

/** Parameter definition stored in ActionType.parametersJson. */
export interface ActionParamDef {
  apiName: string
  displayName?: string
  dataType: 'string' | 'number' | 'boolean'
  required?: boolean
  /** Dataset column the parameter writes to. */
  mapsTo: string
  isPk?: boolean
  defaultValue?: unknown
  oneOf?: string[]
}

export interface ApplyActionResult {
  versionNumber: number
  rowCount: number
  objectPk: string | null
  /** R14.6: present when the action wrote back into a target dataset. */
  writeback?: {
    datasetId: string
    datasetName: string
    mode: 'append' | 'upsert'
    /** merged = upsert matched an existing row; appended = new row. */
    outcome: 'appended' | 'merged'
  }
}

export const MAX_LINK_TARGETS = 50
/** R14.8: link entries carry a `total` plus at most this many sample targets. */
export const SAMPLE_LINK_TARGETS = 5

// ─── Type helpers ────────────────────────────────────────────────────

/** ObjectType with everything the list/detail serializers need. */
export type ObjectTypeFull = Prisma.ObjectTypeGetPayload<{ include: typeof OBJECT_TYPE_INCLUDE }>

export const OBJECT_TYPE_INCLUDE = {
  sourceDataset: {
    include: {
      versions: {
        orderBy: { versionNumber: 'desc' as const },
        take: 1,
        select: { rowCount: true },
      },
    },
  },
  properties: { orderBy: { id: 'asc' as const } },
  outgoingLinks: {
    orderBy: { apiName: 'asc' as const },
    include: { toType: { select: { id: true, apiName: true, displayName: true } } },
  },
  incomingLinks: {
    orderBy: { apiName: 'asc' as const },
    include: { fromType: { select: { id: true, apiName: true, displayName: true } } },
  },
  actions: { orderBy: [{ createdAt: 'asc' as const }, { apiName: 'asc' as const }] },
} satisfies Prisma.ObjectTypeInclude

/** Find an object type by id OR apiName (with its properties). */
export async function findObjectType(idOrApiName: string) {
  const withProps = { properties: { orderBy: { id: 'asc' as const } } } satisfies Prisma.ObjectTypeInclude
  return (
    (await db.objectType.findUnique({ where: { id: idOrApiName }, include: withProps })) ??
    (await db.objectType.findUnique({ where: { apiName: idOrApiName }, include: withProps }))
  )
}

/**
 * Serialize an object type (with OBJECT_TYPE_INCLUDE) into the contract shape:
 * objectCount comes from the backing dataset's latest version rowCount
 * (null when there is no dataset / no versions).
 */
export function serializeObjectType(ot: ObjectTypeFull) {
  const latest = ot.sourceDataset?.versions?.[0]
  return {
    id: ot.id,
    apiName: ot.apiName,
    displayName: ot.displayName,
    description: ot.description,
    primaryKey: ot.primaryKey,
    icon: ot.icon,
    color: ot.color,
    sourceDatasetId: ot.sourceDatasetId,
    sourceDatasetName: ot.sourceDataset?.name ?? null,
    objectCount: latest ? latest.rowCount : null,
    properties: ot.properties.map((p) => ({
      apiName: p.apiName,
      displayName: p.displayName,
      dataType: p.dataType,
      isTitle: p.isTitle,
      hideInTable: p.hideInTable,
    })),
    linksOut: ot.outgoingLinks.map((l) => ({
      id: l.id,
      apiName: l.apiName,
      displayName: l.displayName,
      toTypeId: l.toTypeId,
      toTypeApiName: l.toType.apiName,
      toTypeDisplayName: l.toType.displayName,
      cardinality: l.cardinality,
    })),
    linksIn: ot.incomingLinks.map((l) => ({
      id: l.id,
      apiName: l.apiName,
      displayName: l.displayName,
      fromTypeId: l.fromTypeId,
      fromTypeApiName: l.fromType.apiName,
      fromTypeDisplayName: l.fromType.displayName,
      cardinality: l.cardinality,
    })),
    actions: ot.actions.map((a) => ({
      id: a.id,
      apiName: a.apiName,
      displayName: a.displayName,
      operation: a.operation,
      enabled: a.enabled,
    })),
    createdAt: ot.createdAt,
  }
}

// ─── Property derivation ─────────────────────────────────────────────

/** Humanize an apiName: split camelCase/underscores, capitalize each word. */
export function humanizeApiName(apiName: string): string {
  return apiName
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/**
 * Derive Property create data from a dataset schema.
 * displayName = humanized apiName; isTitle marks the title property
 * (defaults to the primary key when titleProperty is not given).
 */
export function deriveProperties(
  schema: SchemaColumn[],
  primaryKey: string,
  titleProperty?: string,
): PropertyLike[] {
  const title = titleProperty ?? primaryKey
  return schema.map((col) => ({
    apiName: col.name,
    displayName: humanizeApiName(col.name),
    dataType: col.type,
    isTitle: col.name === title,
    hideInTable: false,
  }))
}

// ─── Object rows ─────────────────────────────────────────────────────

/**
 * Load the object type's backing dataset latest version and map rows to
 * object instances: { pk, values (full row), _title }.
 * Substring ?query= filters on stringified row values (case-insensitive).
 * `maskColumns` (governance) masks those columns' values BEFORE the query
 * filter and pagination, so search can never leak governed values.
 * R14.8: `filters` (saved object views) apply AFTER masking for the same
 * leak-prevention reason; `sortBy`/`sortDir` order the instance list.
 */
export async function getObjectRows(
  objectType: ObjectTypeCore,
  opts: {
    query?: string | null
    page?: number
    pageSize?: number
    /** Server-side consumers that must aggregate the complete governed set. */
    all?: boolean
    maskColumns?: string[]
    filters?: ObjectViewFilter[]
    sortBy?: string | null
    sortDir?: 'asc' | 'desc'
  } = {},
): Promise<ObjectRowsResult> {
  const page = Math.max(1, Math.floor(opts.page ?? 1) || 1)
  const pageSize = Math.min(200, Math.max(1, Math.floor(opts.pageSize ?? 50) || 50))

  const props: PropertyLike[] = (objectType.properties ?? []).map((p) => ({
    apiName: p.apiName,
    displayName: p.displayName,
    dataType: p.dataType,
    isTitle: p.isTitle,
    hideInTable: p.hideInTable,
  }))
  const empty: ObjectRowsResult = { rows: [], total: 0, columns: props }
  if (!objectType.sourceDatasetId) return empty

  // P2: the object layer is a CONSUMER — gated datasets serve the last
  // published version, never a draft.
  const consumer = await resolveConsumerVersion(objectType.sourceDatasetId)
  if (consumer?.versionNumber == null) return empty
  const version = await getDatasetVersion(
    objectType.sourceDatasetId,
    consumer.versionNumber,
  )
  if (!version) return empty

  const data = parseJsonSafe<Row[]>(version.dataJson, [])
  const pkColumn = objectType.primaryKey
  const titleColumn = props.find((p) => p.isTitle)?.apiName ?? pkColumn

  let rows = data
  if (opts.maskColumns && opts.maskColumns.length > 0) {
    const masked = new Set(opts.maskColumns)
    rows = rows.map((row) => {
      const out: Row = {}
      for (const [key, value] of Object.entries(row)) out[key] = masked.has(key) ? MASK_LITERAL : value
      return out
    })
  }
  const query = opts.query?.trim()
  if (query) {
    const q = query.toLowerCase()
    rows = rows.filter((row) => JSON.stringify(Object.values(row)).toLowerCase().includes(q))
  }

  // Saved-view structured filters (after masking — same leak prevention as search).
  for (const f of opts.filters ?? []) {
    rows = rows.filter((row) => filterMatches(row, f))
  }

  // Sorting (numeric compare when both sides are numeric, else string compare).
  const sortBy = opts.sortBy?.trim()
  if (sortBy) {
    const dir = opts.sortDir === 'desc' ? -1 : 1
    rows = [...rows].sort((a, b) => {
      const av = a[sortBy]
      const bv = b[sortBy]
      if (av === null || av === undefined || av === '') return 1 // nulls last either way
      if (bv === null || bv === undefined || bv === '') return -1
      return compareValues(av, bv) * dir
    })
  }

  const total = rows.length
  const start = (page - 1) * pageSize
  const paged = opts.all ? rows : rows.slice(start, start + pageSize)

  // Fallback when a type somehow has no Property rows: derive from the dataset schema.
  const columns: PropertyLike[] = props.length
    ? props
    : parseJsonSafe<SchemaColumn[]>(version.schemaJson, []).map((col) => ({
        apiName: col.name,
        displayName: humanizeApiName(col.name),
        dataType: col.type,
        isTitle: col.name === pkColumn,
        hideInTable: false,
      }))

  return {
    rows: paged.map((row) => ({
      pk: pkColumn ? (row[pkColumn] ?? null) : null,
      values: row,
      _title: titleColumn ? (row[titleColumn] ?? null) : null,
    })),
    total,
    columns,
  }
}

// ─── Saved-view filters (R14.8) ──────────────────────────────────────

/** One structured filter of a saved object view. */
export interface ObjectViewFilter {
  property: string
  op: 'eq' | 'neq' | 'contains' | 'gt' | 'lt' | 'gte' | 'lte' | 'in'
  value: string
}

export const VIEW_FILTER_OPS = ['eq', 'neq', 'contains', 'gt', 'lt', 'gte', 'lte', 'in'] as const

/** Max structured filters accepted per request (defensive cap). */
export const MAX_VIEW_FILTERS = 12

/** Does `row` satisfy one saved-view filter? (filter value is always a string) */
function filterMatches(row: Row, f: ObjectViewFilter): boolean {
  const cell = row[f.property]
  switch (f.op) {
    case 'eq':
      return looseEqual(cell, f.value)
    case 'neq':
      return !looseEqual(cell, f.value)
    case 'contains':
      return String(cell ?? '').toLowerCase().includes(String(f.value).toLowerCase())
    case 'in': {
      const list = String(f.value)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '')
      return list.some((v) => looseEqual(cell, v))
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (cell === null || cell === undefined || cell === '') return false
      const c = compareValues(cell, f.value)
      if (f.op === 'gt') return c > 0
      if (f.op === 'gte') return c >= 0
      if (f.op === 'lt') return c < 0
      return c <= 0
    }
    default:
      return true
  }
}

// ─── Loose value matching (string/number tolerant) ───────────────────

/** true when a and b are identical, numerically equal, or string-equal. */
export function looseEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || a === undefined || b === null || b === undefined) return false
  const na = toNumber(a)
  const nb = toNumber(b)
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na === nb
  return String(a) === String(b)
}

function findRowIndexByPk(rows: Row[], pkColumn: string, pkValue: unknown): number {
  return rows.findIndex((row) => looseEqual(row[pkColumn], pkValue))
}

// ─── Dataset row helpers ─────────────────────────────────────────────

interface DatasetSnapshot {
  rows: Row[]
  schema: SchemaColumn[]
}

async function loadLatestDataset(datasetId: string): Promise<{ dataset: Dataset; snapshot: DatasetSnapshot } | null> {
  const dataset = await db.dataset.findUnique({ where: { id: datasetId } })
  if (!dataset) return null
  // P2: object/link reads are consumer reads — honor the publication gate.
  const consumer = await resolveConsumerVersion(datasetId)
  if (consumer?.versionNumber == null) return null
  const version = await getDatasetVersion(datasetId, consumer.versionNumber)
  if (!version) return null
  return {
    dataset,
    snapshot: {
      rows: parseJsonSafe<Row[]>(version.dataJson, []),
      schema: parseJsonSafe<SchemaColumn[]>(version.schemaJson, []),
    },
  }
}

// ─── Links (both directions) ─────────────────────────────────────────

function titlePropertyOf(type: ObjectTypeCore | null | undefined): string | null {
  if (!type) return null
  return type.properties?.find((p) => p.isTitle)?.apiName ?? type.primaryKey ?? null
}

function toLinkEntry(
  link: LinkTypeWithType,
  other: ObjectTypeCore,
  direction: 'outgoing' | 'incoming',
  targets: LinkTarget[],
  total: number,
): LinkEntry {
  return {
    id: link.id,
    apiName: link.apiName,
    displayName: link.displayName,
    direction,
    cardinality: link.cardinality,
    toTypeId: other.id,
    toTypeApiName: other.apiName,
    toTypeDisplayName: other.displayName,
    toTypeIcon: other.icon ?? 'box',
    toTypeColor: other.color ?? 'emerald',
    total,
    fkProperty: link.cardinality === 'one-to-many' ? link.fkProperty : null,
    targets,
  }
}

/** Fetch other-type rows whose pk is in pks (loose match), capped. */
async function fetchRowsByPkValues(type: ObjectTypeCore, pks: unknown[]): Promise<Row[]> {
  if (!type.sourceDatasetId || pks.length === 0) return []
  const snap = await loadLatestDataset(type.sourceDatasetId)
  if (!snap || !type.primaryKey) return []
  const wanted = new Set(pks.map((v) => String(v)))
  const found: Row[] = []
  for (const row of snap.snapshot.rows) {
    if (wanted.has(String(row[type.primaryKey]))) {
      found.push(row)
      if (found.length >= MAX_LINK_TARGETS) break
    }
  }
  return found
}

async function resolveLinkTargets(
  link: LinkTypeWithType,
  other: ObjectTypeCore,
  direction: 'outgoing' | 'incoming',
  viewedRow: Row | null,
  viewedPk: unknown,
): Promise<{ targets: LinkTarget[]; total: number }> {
  const otherPkColumn = other.primaryKey
  if (!otherPkColumn) return { targets: [], total: 0 }

  // many-to-many: link dataset holds [fromPk, toPk] in its first two columns.
  if (link.cardinality === 'many-to-many') {
    if (!link.linkDatasetId) return { targets: [], total: 0 }
    const snap = await loadLatestDataset(link.linkDatasetId)
    if (!snap) return { targets: [], total: 0 }
    const firstCol = snap.snapshot.schema[0]?.name
    const secondCol = snap.snapshot.schema[1]?.name
    if (!firstCol || !secondCol) return { targets: [], total: 0 }
    // outgoing: this type is the FROM side (firstCol); incoming: secondCol.
    const ownCol = direction === 'outgoing' ? firstCol : secondCol
    const otherCol = direction === 'outgoing' ? secondCol : firstCol
    const otherPks: unknown[] = []
    for (const row of snap.snapshot.rows) {
      if (looseEqual(row[ownCol], viewedPk)) {
        const v = row[otherCol]
        if (v !== null && v !== undefined && !otherPks.some((p) => looseEqual(p, v))) otherPks.push(v)
      }
    }
    // total = every distinct match; rows fetched for the sample only.
    const rows = await fetchRowsByPkValues(other, otherPks.slice(0, SAMPLE_LINK_TARGETS))
    const titleCol = titlePropertyOf(other)
    const targets = rows
      .map((row) => ({ pk: row[otherPkColumn], _title: titleCol ? row[titleCol] : null }))
      .slice(0, SAMPLE_LINK_TARGETS)
    return { targets, total: otherPks.length }
  }

  // one-to-many
  if (direction === 'outgoing') {
    // fk column lives on the TO type's dataset and holds FROM (this) pk values.
    if (!other.sourceDatasetId || !link.fkProperty) return { targets: [], total: 0 }
    const snap = await loadLatestDataset(other.sourceDatasetId)
    if (!snap) return { targets: [], total: 0 }
    const titleCol = titlePropertyOf(other)
    const all: LinkTarget[] = []
    for (const row of snap.snapshot.rows) {
      if (looseEqual(row[link.fkProperty], viewedPk)) {
        all.push({ pk: row[otherPkColumn], _title: titleCol ? (row[titleCol] ?? null) : null })
      }
    }
    return { targets: all.slice(0, SAMPLE_LINK_TARGETS), total: all.length }
  }

  // incoming one-to-many: the fk column lives on THIS type's dataset and holds
  // the OTHER (from) type's pk values — follow this row's fk to the other side.
  if (!viewedRow || !link.fkProperty) return { targets: [], total: 0 }
  const fkValue = viewedRow[link.fkProperty]
  if (fkValue === null || fkValue === undefined || fkValue === '') return { targets: [], total: 0 }
  const rows = await fetchRowsByPkValues(other, [fkValue])
  const titleCol = titlePropertyOf(other)
  const targets = rows.map((row) => ({ pk: row[otherPkColumn], _title: titleCol ? (row[titleCol] ?? null) : null }))
  return { targets, total: targets.length }
}

/**
 * Links for an object detail page, from the viewed type's perspective in BOTH
 * directions: outgoing (this type -> other) and incoming (other -> this).
 * One entry per LinkType with direction field; `total` counts ALL matches and
 * `targets` is a sample capped at SAMPLE_LINK_TARGETS.
 */
export async function getLinksFor(
  objectType: ObjectType & {
    outgoingLinks?: (LinkTypeWithType & { toType?: ObjectTypeCore | null })[]
    incomingLinks?: (LinkTypeWithType & { fromType?: ObjectTypeCore | null })[]
  },
  pk: unknown,
): Promise<LinkEntry[]> {
  // Load the viewed row (needed for incoming one-to-many fk traversal).
  let viewedRow: Row | null = null
  if (objectType.sourceDatasetId && objectType.primaryKey) {
    const snap = await loadLatestDataset(objectType.sourceDatasetId)
    if (snap) {
      const idx = findRowIndexByPk(snap.snapshot.rows, objectType.primaryKey, pk)
      if (idx >= 0) viewedRow = snap.snapshot.rows[idx]
    }
  }

  const entries: LinkEntry[] = []

  for (const link of objectType.outgoingLinks ?? []) {
    const other = link.toType
    if (!other) continue
    const { targets, total } = await resolveLinkTargets(link, other, 'outgoing', viewedRow, pk)
    entries.push(toLinkEntry(link, other, 'outgoing', targets, total))
  }

  for (const link of objectType.incomingLinks ?? []) {
    const other = link.fromType
    if (!other) continue
    const { targets, total } = await resolveLinkTargets(link, other, 'incoming', viewedRow, pk)
    entries.push(toLinkEntry(link, other, 'incoming', targets, total))
  }

  return entries
}

// ─── Action write-back ───────────────────────────────────────────────

function formatCell(v: unknown): string {
  if (v === undefined) return '(missing)'
  if (v === null) return '(null)'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/**
 * Generate a primary key for a new row: max+1 when existing pks are numeric,
 * PREFIX-0001 increment when they share a "PREFIX-####" pattern, else NEW-xxxx.
 */
export function generatePk(rows: Row[], column: string): string | number {
  const values = rows
    .map((r) => r[column])
    .filter((v) => v !== null && v !== undefined && String(v).trim() !== '')
  if (values.length === 0) return `NEW-${Date.now().toString(36).toUpperCase()}`

  const nums = values.map(toNumber)
  if (nums.every((n) => !Number.isNaN(n))) {
    return Math.max(...(nums as number[])) + 1
  }

  const matches = values.map((v) => /^([A-Za-z][A-Za-z0-9]*?)-(\d+)$/.exec(String(v)))
  if (matches.every(Boolean) && matches[0]) {
    const prefix = matches[0][1]
    if (matches.every((m) => m![1] === prefix)) {
      const width = Math.max(...matches.map((m) => m![2].length))
      const max = Math.max(...matches.map((m) => Number(m![2])))
      return `${prefix}-${String(max + 1).padStart(width, '0')}`
    }
  }

  return `NEW-${Date.now().toString(36).toUpperCase()}`
}

/** Log a failed action attempt and return the Error to throw (route maps to 400). */
async function logFailure(
  actionTypeId: string,
  params: Record<string, unknown>,
  message: string,
): Promise<Error> {
  try {
    await db.actionLog.create({
      data: {
        actionTypeId,
        paramsJson: JSON.stringify(params ?? {}),
        result: 'failed',
        message,
      },
    })
  } catch {
    // logging must never mask the original error
  }
  return new Error(message)
}

/**
 * R14.6 — write `rows` as a NEW DatasetVersion of an EXISTING dataset (by id,
 * unlike createDatasetFromRows which resolves datasets by name — the write-back
 * target is a stable id so a renamed/colliding name can never misroute).
 * Version-shape conventions follow dataset-service: normalized rows, schema
 * carried over from the dataset's current version (write-backs extend a typed
 * dataset rather than re-deriving its schema), next versionNumber = max+1
 * across all branches, branch 'main', keepLastN retention honored.
 */
async function appendDatasetVersion(
  datasetId: string,
  rows: Row[],
  createdBy: string,
): Promise<{ versionNumber: number; rowCount: number }> {
  if (rows.length > MAX_ROWS) throw new Error(`Write-back has ${rows.length} rows; the current storage limit is ${MAX_ROWS}. No version was written.`)
  const normalized = normalizeRows(rows)

  const current = await getDatasetVersion(datasetId)
  const schemaJson = current?.schemaJson ?? JSON.stringify(inferSchema(normalized))

  // P2: respect the publication gate — gated targets hold the new version as
  // a DRAFT and keep serving the last published one.
  const target = await db.dataset.findUnique({
    where: { id: datasetId },
    select: { qualityGate: true },
  })
  const nextVersionNumber = (await getHeadVersionNumber(datasetId)) + 1
  const version = await db.datasetVersion.create({
    data: {
      datasetId,
      versionNumber: nextVersionNumber,
      schemaJson,
      rowCount: normalized.length,
      dataJson: JSON.stringify(normalized),
      createdBy,
      branch: 'main',
      lifecycle: target?.qualityGate ? 'draft' : 'published',
    },
  })

  const dataset = await db.dataset.findUnique({
    where: { id: datasetId },
    select: { keepLastN: true, qualityGate: true },
  })
  if (dataset) await pruneDatasetVersions(datasetId, dataset.keepLastN)
  await db.dataset.update({
    where: { id: datasetId },
    data: {
      updatedAt: new Date(),
      // gate off => the new version is immediately consumable
      ...(dataset?.qualityGate ? {} : { publishedVersion: version.versionNumber }),
    },
  })

  return { versionNumber: version.versionNumber, rowCount: normalized.length }
}

/**
 * Full action-type serializer for the /api/ontology/actions admin routes:
 * parsed parameters + R14.6 write-back config + object type meta.
 */
export function serializeActionFull(
  action: ActionType & {
    objectType: {
      id: string
      apiName: string
      displayName: string
      primaryKey: string | null
      icon: string | null
      color: string | null
      sourceDatasetId: string | null
    }
  },
  targetDatasetName: string | null,
) {
  const targetDatasetId = action.targetDatasetId
  return {
    id: action.id,
    apiName: action.apiName,
    displayName: action.displayName,
    description: action.description,
    operation: action.operation as 'create' | 'update' | 'delete',
    enabled: action.enabled,
    objectTypeId: action.objectTypeId,
    objectType: {
      id: action.objectType.id,
      apiName: action.objectType.apiName,
      displayName: action.objectType.displayName,
      primaryKey: action.objectType.primaryKey,
      icon: action.objectType.icon,
      color: action.objectType.color,
      sourceDatasetId: action.objectType.sourceDatasetId,
    },
    parameters: parseJsonSafe<ActionParamDef[]>(action.parametersJson, []),
    writeback:
      targetDatasetId && action.writeMode
        ? {
            targetDatasetId,
            targetDatasetName,
            writeMode: action.writeMode as 'append' | 'upsert',
            keyProperty: action.keyProperty,
          }
        : null,
    createdAt: action.createdAt,
    updatedAt: action.updatedAt,
  }
}

/**
 * Validate + coerce params against the action's parameter definitions, then
 * write a NEW DatasetVersion (immutable versioning). Two write paths:
 * 1. R14.6 target-dataset write-back (targetDatasetId set) — append or upsert
 *    a row built from the mapped parameters into the TARGET dataset, replacing
 *    the object create/update/delete semantics;
 * 2. legacy object operation — create/update/delete a row on the object type's
 *    backing dataset (via name-based createDatasetFromRows, as before).
 * Both paths emit emitVersionCreated() so triggers/notifications fire.
 */
export async function applyAction(
  actionType: ActionType & { objectType: ObjectType & { sourceDataset: Dataset | null } },
  params: Record<string, unknown>,
): Promise<ApplyActionResult> {
  const defs = parseJsonSafe<ActionParamDef[]>(actionType.parametersJson, [])
  const objectType = actionType.objectType

  if (!actionType.enabled) {
    throw await logFailure(actionType.id, params, `Action '${actionType.apiName}' is disabled`)
  }

  // ── validate + coerce ────────────────────────────────────────────
  const provided: { def: ActionParamDef; value: unknown }[] = []
  for (const def of defs) {
    const raw = params[def.apiName]
    const missing = raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')
    if (missing) {
      if (def.required) {
        throw await logFailure(actionType.id, params, `Parameter '${def.apiName}' is required`)
      }
      continue
    }
    let value: unknown
    if (def.dataType === 'number') {
      const n = typeof raw === 'number' ? raw : Number(typeof raw === 'string' ? raw.trim() : raw)
      if (!Number.isFinite(n)) {
        throw await logFailure(actionType.id, params, `Parameter '${def.apiName}' must be a number (got '${formatCell(raw)}')`)
      }
      value = n
    } else if (def.dataType === 'boolean') {
      if (raw === true || raw === 'true') value = true
      else if (raw === false || raw === 'false') value = false
      else {
        throw await logFailure(actionType.id, params, `Parameter '${def.apiName}' must be a boolean (got '${formatCell(raw)}')`)
      }
    } else {
      value = String(raw)
    }
    if (def.oneOf && def.oneOf.length > 0 && !def.oneOf.some((o) => looseEqual(o, value))) {
      throw await logFailure(
        actionType.id,
        params,
        `Parameter '${def.apiName}' must be one of: ${def.oneOf.join(', ')} (got '${formatCell(value)}')`,
      )
    }
    provided.push({ def, value })
  }

  // ── R14.6: target-dataset write-back replaces the object operation ──
  if (actionType.targetDatasetId && actionType.writeMode) {
    return applyTargetWriteback(actionType, provided, params)
  }

  // ── load backing dataset latest version ──────────────────────────
  if (!objectType.sourceDataset) {
    throw await logFailure(actionType.id, params, `Object type '${objectType.apiName}' has no backing dataset`)
  }
  const dataset = objectType.sourceDataset
  const version = await getDatasetVersion(dataset.id)
  if (!version) {
    throw await logFailure(actionType.id, params, `Dataset '${dataset.name}' has no versions to write back onto`)
  }
  const rows = parseJsonSafe<Row[]>(version.dataJson, [])

  const pkDef = defs.find((d) => d.isPk)
  const pkEntry = pkDef ? provided.find((e) => e.def.apiName === pkDef.apiName) : undefined
  const operation = actionType.operation

  let objectPk: string | null = null
  let messageHead = ''

  if (operation === 'update' || operation === 'delete') {
    if (!pkDef) {
      throw await logFailure(actionType.id, params, `Action '${actionType.apiName}' is misconfigured: no isPk parameter defined`)
    }
    if (!pkEntry) {
      throw await logFailure(actionType.id, params, `Parameter '${pkDef.apiName}' is required`)
    }
    objectPk = String(pkEntry.value)
    const idx = findRowIndexByPk(rows, pkDef.mapsTo, pkEntry.value)
    if (idx === -1) {
      throw await logFailure(
        actionType.id,
        params,
        `${objectType.displayName} '${objectPk}' not found in dataset '${dataset.name}'`,
      )
    }

    if (operation === 'delete') {
      rows.splice(idx, 1)
      messageHead = `deleted ${objectType.displayName} ${objectPk}`
    } else {
      const changes = provided.filter((e) => !e.def.isPk)
      if (changes.length === 0) {
        throw await logFailure(
          actionType.id,
          params,
          `No fields to update: provide at least one non-primary-key parameter`,
        )
      }
      const row = { ...rows[idx] }
      const parts: string[] = []
      for (const { def, value } of changes) {
        const before = row[def.mapsTo]
        row[def.mapsTo] = value
        parts.push(`${def.mapsTo}: ${formatCell(before)} -> ${formatCell(value)}`)
      }
      rows[idx] = row
      messageHead = `updated ${objectType.displayName} ${objectPk}: ${parts.join(', ')}`
    }
  } else if (operation === 'create') {
    const newRow: Row = {}
    for (const { def, value } of provided) {
      newRow[def.mapsTo] = value
    }
    const pkColumn = pkDef?.mapsTo ?? objectType.primaryKey
    if (pkColumn && (newRow[pkColumn] === undefined || newRow[pkColumn] === null || newRow[pkColumn] === '')) {
      newRow[pkColumn] = generatePk(rows, pkColumn)
    }
    objectPk = pkColumn && newRow[pkColumn] !== undefined ? String(newRow[pkColumn]) : null
    rows.push(newRow)
    messageHead = `created ${objectType.displayName}${objectPk ? ` ${objectPk}` : ''}`
  } else {
    throw await logFailure(actionType.id, params, `Action '${actionType.apiName}' has unknown operation '${operation}'`)
  }

  // ── write NEW version on the SAME dataset (immutable versioning) ──
  const result = await createDatasetFromRows({
    name: dataset.name,
    rows,
    createdBy: `action:${actionType.apiName}`,
  })
  const versionNumber = result.version.versionNumber
  const message = `${messageHead} (v${versionNumber})`

  const coerced: Record<string, unknown> = {}
  for (const { def, value } of provided) coerced[def.apiName] = value

  await db.actionLog.create({
    data: {
      actionTypeId: actionType.id,
      paramsJson: JSON.stringify(coerced),
      result: 'success',
      message,
      objectPk,
      versionNumber,
    },
  })

  // R14: notify triggers/listeners about the new version (never throws).
  await emitVersionCreated({
    datasetId: result.dataset.id,
    versionNumber,
    source: `action:${actionType.apiName}`,
  })

  return { versionNumber, rowCount: result.rowCount, objectPk }
}

/**
 * R14.6 — target-dataset write-back. Builds a row from the mapped parameters
 * and appends or upserts it into the TARGET dataset as a new version:
 * - append: new row {column: value} for the mapped params; unmapped schema
 *   columns become null. keyProperty (optional) gets a generated pk when empty.
 * - upsert: the row where row[keyProperty] equals the param mapped to
 *   keyProperty (the isPk param or mapsTo===keyProperty) is merged; when no
 *   row matches the built row is appended instead.
 */
async function applyTargetWriteback(
  actionType: ActionType & { objectType: ObjectType & { sourceDataset: Dataset | null } },
  provided: { def: ActionParamDef; value: unknown }[],
  rawParams: Record<string, unknown>,
): Promise<ApplyActionResult> {
  const fail = (message: string) => logFailure(actionType.id, rawParams, message)

  const target = await db.dataset.findUnique({ where: { id: actionType.targetDatasetId as string } })
  if (!target) {
    throw await fail(`Write-back target dataset '${actionType.targetDatasetId}' not found`)
  }

  const version = await getDatasetVersion(target.id)
  if (!version) {
    throw await fail(`Target dataset '${target.name}' has no versions to write back onto`)
  }
  const rows = parseJsonSafe<Row[]>(version.dataJson, [])
  const schema = parseJsonSafe<SchemaColumn[]>(version.schemaJson, [])

  const mode: 'append' | 'upsert' = actionType.writeMode === 'upsert' ? 'upsert' : 'append'
  const keyProperty = actionType.keyProperty?.trim() || null

  if (mode === 'upsert') {
    if (!keyProperty) {
      throw await fail(
        `Action '${actionType.apiName}' is misconfigured: upsert write-back needs a key property`,
      )
    }
    if (!schema.some((c) => c.name === keyProperty)) {
      throw await fail(
        `Key property '${keyProperty}' is not a column of dataset '${target.name}'`,
      )
    }
  }

  // Row built from the mapped parameters (key column included when mapped).
  const mapped: Row = {}
  for (const { def, value } of provided) mapped[def.mapsTo] = value

  // The parameter that carries the upsert key: isPk param or mapsTo===keyProperty.
  const keyEntry =
    mode === 'upsert'
      ? provided.find((e) => e.def.isPk || (keyProperty && e.def.mapsTo === keyProperty))
      : undefined
  if (mode === 'upsert' && !keyEntry) {
    throw await fail(
      `No parameter maps to the key property '${keyProperty}' — add an isPk parameter mapped to it`,
    )
  }

  let objectPk: string | null = null
  let outcome: 'appended' | 'merged' = 'appended'

  if (mode === 'upsert' && keyEntry) {
    const keyValue = keyEntry.value
    const idx = findRowIndexByPk(rows, keyProperty as string, keyValue)
    objectPk = String(keyValue)
    if (idx >= 0) {
      rows[idx] = { ...rows[idx], ...mapped }
      outcome = 'merged'
    } else {
      const newRow: Row = {}
      for (const col of schema) newRow[col.name] = null // unmapped schema columns
      Object.assign(newRow, mapped)
      if (newRow[keyProperty as string] === undefined || newRow[keyProperty as string] === null || newRow[keyProperty as string] === '') {
        newRow[keyProperty as string] = keyValue
      }
      rows.push(newRow)
    }
  } else {
    // append
    const newRow: Row = {}
    for (const col of schema) newRow[col.name] = null // unmapped schema columns
    Object.assign(newRow, mapped)
    if (keyProperty && (newRow[keyProperty] === undefined || newRow[keyProperty] === null || newRow[keyProperty] === '')) {
      newRow[keyProperty] = generatePk(rows, keyProperty)
    }
    objectPk = keyProperty && newRow[keyProperty] !== undefined ? String(newRow[keyProperty]) : null
    rows.push(newRow)
  }

  const { versionNumber, rowCount } = await appendDatasetVersion(
    target.id,
    rows,
    `action:${actionType.apiName}`,
  )

  const message =
    mode === 'upsert'
      ? `Wrote back to ${target.name} v${versionNumber} (upsert, ${outcome})`
      : `Wrote back to ${target.name} v${versionNumber} (append)`

  const coerced: Record<string, unknown> = {}
  for (const { def, value } of provided) coerced[def.apiName] = value

  await db.actionLog.create({
    data: {
      actionTypeId: actionType.id,
      paramsJson: JSON.stringify(coerced),
      result: 'success',
      message,
      objectPk,
      versionNumber,
    },
  })

  // R14: notify triggers/listeners about the new version (never throws).
  await emitVersionCreated({
    datasetId: target.id,
    versionNumber,
    source: `action:${actionType.apiName}`,
  })

  return {
    versionNumber,
    rowCount,
    objectPk,
    writeback: { datasetId: target.id, datasetName: target.name, mode, outcome },
  }
}
