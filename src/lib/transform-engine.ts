// MiniFoundry — M4 code-transform engine (workbooks).
// Runs a Transform synchronously: loads its input datasets, executes the user
// code (SQL against REAL SQLite tables materialized from dataset versions,
// JavaScript in a node:vm sandbox, or Python in a child process), and publishes
// the result rows as a NEW version of the output dataset via the shared
// dataset-service.
//
// Sandboxing rules (learning-scale, deliberately strict):
// - SQL: single statement only, must start with SELECT or WITH (leading
//   comments are skipped). Inputs are materialized into REAL tables named
//   after the sanitized dataset name ([a-z0-9_], lowercase, collisions get
//   _2/_3 suffixes, Prisma's own tables are protected). Temp tables are ALWAYS
//   dropped in a finally block — they live in the shared db file.
// - JS: the source is the BODY of a function receiving `input`
//   ({ rows, datasets, schemas }) and returning the output row array.
//   Executed via vm.runInNewContext with a 2s timeout; no require/process/
//   console exposed. Result must be an array of plain objects with
//   string|number|boolean|null values.
// - Python: the source is a full module that must define
//   `def transform(input):` and return a list of dicts. Executed as a
//   `python3 -I -B` (or `python -I -B` on Windows) child process: input JSON arrives
//   on stdin, the result is written to a per-run temp file (MF_OUT env), user
//   print() lines come back on stdout as run logs, tracebacks on stderr.
//   The user code is NOT vm-isolated (learning-scale tradeoff: it is plain
//   Python running with the dev-server's privileges); -I keeps it from seeing
//   env vars/user site-packages, and both files live in a mkdtemp dir removed
//   in a finally block. Same row-value rules as JS: str|int|float|bool|None.

import type { NextRequest } from 'next/server'
import type { Transform, TransformRun } from '@prisma/client'
import { db } from '@/lib/db'
import { isDemoMode } from '@/lib/runtime-mode'
import { executeSqlIsolated, executeJsIsolated, executePythonIsolated } from '@/lib/isolated-runner'
import { emitVersionCreated } from '@/lib/version-events'
import {
  parseJsonSafe,
  parseSchema,
  type LogEntry,
} from '@/lib/api-utils'
import {
  MAX_ROWS,
  createDatasetFromRows,
  getDatasetVersion,
  resolveConsumerVersion,
  type Row,
  type SchemaColumn,
} from '@/lib/dataset-service'

// ─── Table-name helpers ───────────────────────────────────────────────

/**
 * Sanitize a dataset name into a SQLite-safe table base name:
 * lowercase, every non [a-z0-9_] char becomes "_"
 * ("Shipments" -> "shipments", "Active Shipments" -> "active_shipments").
 */
function sanitizeTableName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_]/g, '_') || 'table'
}

/**
 * Prisma's own tables live in the SAME SQLite file. SQLite table names are
 * case-insensitive, so a dataset literally named "Dataset" would collide with
 * the platform's own table — protect them (plus sqlite internals) by forcing
 * a _2 suffix for such names.
 */
const PROTECTED_TABLES = new Set(
  [
    'project',
    'connector',
    'ingestion',
    'dataset',
    'datasetversion',
    'pipeline',
    'pipelinerun',
    'schedule',
    'objecttype',
    'property',
    'linktype',
    'actiontype',
    'actionlog',
    'lineageedge',
    'marking',
    'columnmarking',
    'approvalrequest',
    'auditentry',
    'transform',
    'transformrun',
    '_prisma_migrations',
    'sqlite_sequence',
    'sqlite_stat1',
    'sqlite_schema',
    'sqlite_master',
  ].map((t) => t.toLowerCase()),
)

/** Quote a SQLite identifier (" -> "" inside the quotes). */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

// ─── Cell / param sanitization ────────────────────────────────────────

/** Convert a JS cell value into a SQLite bind parameter. */
function toSqlParam(v: unknown): unknown {
  if (v === null || v === undefined) return null
  if (typeof v === 'boolean') return v ? 1 : 0
  return v
}

/** Normalize a raw SQLite result cell into a JSON-serializable value. */
function sanitizeCell(v: unknown): unknown {
  if (typeof v === 'bigint') return Number(v)
  if (v instanceof Date) return v.toISOString()
  // Buffer extends Uint8Array — BLOB columns arrive as Uint8Array
  if (v instanceof Uint8Array) return '(blob)'
  if (v === null || v === undefined) return null
  if (typeof v === 'object') return JSON.stringify(v)
  return v
}

// ─── Input loading ────────────────────────────────────────────────────

interface LoadedInput {
  datasetId: string
  name: string
  versionNumber: number
  rows: Row[]
  schema: SchemaColumn[]
}

export interface TransformManifest {
  transformId: string
  language: string
  sourceCode: string
  outputDatasetName: string
  configuredInputs: string[]
  inputs: { datasetId: string; versionNumber: number }[]
  outputDatasetId: string | null
  outputVersionNumber: number | null
}

export interface TransformRunOptions {
  inputOverrides?: Record<string, number>
  replayOfRunId?: string
}

async function loadInputs(transform: Transform, log: LogFn, options: TransformRunOptions = {}): Promise<LoadedInput[]> {
  const ids = parseJsonSafe<string[]>(transform.inputsJson, [])
  const loaded: LoadedInput[] = []
  if (ids.length === 0) {
    log('warn', 'no input datasets configured')
  }
  for (const id of ids) {
    const pinnedVersion = options.inputOverrides?.[id]
    const dataset = await db.dataset.findUnique({ where: { id }, select: { id: true, name: true } })
    if (!dataset) {
      if (pinnedVersion !== undefined) throw new Error(`Pinned input dataset '${id}' no longer exists`)
      log('warn', `input dataset '${id}' no longer exists — skipped`)
      continue
    }
    const consumer = pinnedVersion === undefined ? await resolveConsumerVersion(id) : null
    const selectedVersion = pinnedVersion ?? consumer?.versionNumber
    const version = selectedVersion == null ? null : await getDatasetVersion(id, selectedVersion)
    if (!version) {
      if (pinnedVersion !== undefined) {
        throw new Error(`Pinned input dataset '${id}' v${pinnedVersion} no longer exists`)
      }
      log('warn', `input "${dataset.name}" has no versions — skipped`)
      continue
    }
    const rows = parseJsonSafe<Row[]>(version.dataJson, [])
    loaded.push({
      datasetId: id,
      name: dataset.name,
      versionNumber: version.versionNumber,
      rows,
      schema: parseSchema(version),
    })
    log('info', `loaded input "${dataset.name}" v${version.versionNumber} (${rows.length} rows)`)
  }
  return loaded
}

// ─── SQL path ─────────────────────────────────────────────────────────

type LogFn = (level: LogEntry['level'], msg: string) => void

/** Strip leading `--` line comments and `/*` block comments (star-slash) so the first keyword is visible. */
function stripLeadingComments(sql: string): string {
  let s = sql.trimStart()
  for (;;) {
    if (s.startsWith('--')) {
      const nl = s.indexOf('\n')
      s = nl === -1 ? '' : s.slice(nl + 1).trimStart()
      continue
    }
    if (s.startsWith('/*')) {
      const end = s.indexOf('*/', 2)
      s = end === -1 ? '' : s.slice(end + 2).trimStart()
      continue
    }
    return s
  }
}

/** True when the SQL contains a statement-terminating ';' outside string literals. */
function hasSemicolonOutsideQuotes(sql: string): boolean {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]
    if (inSingle) {
      if (c === "'") {
        if (sql[i + 1] === "'") i++ // escaped ''
        else inSingle = false
      }
    } else if (inDouble) {
      if (c === '"') inDouble = false
    } else if (c === "'") inSingle = true
    else if (c === '"') inDouble = true
    else if (c === ';') return true
  }
  return false
}

/**
 * Validate user SQL: trim, strip ONE trailing ';', then reject multi-statement
 * SQL and anything that is not a SELECT/WITH query. Returns the cleaned SQL.
 */
function validateSql(raw: string, log: LogFn): string {
  log('info', 'validating SQL (SELECT/WITH only, single statement)')
  let sql = raw.trim()
  if (sql.endsWith(';')) sql = sql.slice(0, -1).trimEnd()
  if (sql.length === 0) throw new Error('SQL is empty')
  if (hasSemicolonOutsideQuotes(sql)) {
    throw new Error('bad SQL: multiple statements are not allowed (found ";" mid-query)')
  }
  const body = stripLeadingComments(sql)
  const firstWord = body.match(/^[A-Za-z]+/)?.[0]?.toLowerCase() ?? ''
  if (firstWord !== 'select' && firstWord !== 'with') {
    throw new Error(`bad SQL: only SELECT or WITH queries are allowed (first word: "${firstWord || '—'}")`)
  }
  return sql
}

// ─── Main entry ───────────────────────────────────────────────────────

/**
 * Run a transform synchronously: create the TransformRun row first, execute,
 * publish the output dataset version, then finalize the run (status, logs,
 * duration, outputs). Temp SQL tables are ALWAYS dropped — even on failure.
 * Never throws for user-code/validation failures: those are recorded on the
 * run (status failed + error + logs) so callers always get a run back.
 */
export async function runTransform(transform: Transform, _req?: NextRequest, options: TransformRunOptions = {}): Promise<TransformRun> {
  // The isolated runner handles SQL/JS/Python safely. Shared mode is now allowed.
  const run = await db.transformRun.create({
    data: { transformId: transform.id, status: 'running', logsJson: '[]', replayOfRunId: options.replayOfRunId ?? null },
  })
  const logs: LogEntry[] = []
  const log: LogFn = (level, msg) => {
    logs.push({ ts: new Date().toISOString(), level, msg })
  }
  const startedAt = Date.now()
  let status: 'success' | 'failed' = 'failed'
  let error: string | null = null
  let rowCount: number | null = null
  let outputDatasetId: string | null = null
  let outputVersionNumber: number | null = null
  const manifest: TransformManifest = {
    transformId: transform.id,
    language: transform.language,
    sourceCode: transform.sourceCode,
    outputDatasetName: transform.outputDatasetName,
    configuredInputs: parseJsonSafe<string[]>(transform.inputsJson, []),
    inputs: [],
    outputDatasetId: null,
    outputVersionNumber: null,
  }

  try {
    log('info', `run started (language=${transform.language})`)
    const inputs = await loadInputs(transform, log, options)
    manifest.inputs = inputs.map((input) => ({ datasetId: input.datasetId, versionNumber: input.versionNumber }))

    let rows: Row[]
    if (transform.language === 'javascript') {
      const first = inputs[0]
      const input = {
        rows: first ? first.rows : [],
        datasets: Object.fromEntries(inputs.map((i) => [i.name, i.rows])),
        schemas: Object.fromEntries(inputs.map((i) => [i.name, i.schema])),
      }
      log('info', 'executing javascript via isolated worker thread')
      rows = await executeJsIsolated(transform.sourceCode, input, { timeoutMs: 5000, maxRows: MAX_ROWS })
    } else if (transform.language === 'python') {
      const first = inputs[0]
      const input = {
        rows: first ? first.rows : [],
        datasets: Object.fromEntries(inputs.map((i) => [i.name, i.rows])),
        schemas: Object.fromEntries(inputs.map((i) => [i.name, i.schema])),
      }
      log('info', 'executing python via isolated subprocess')
      rows = await executePythonIsolated(transform.sourceCode, input, { timeoutMs: 10000, maxRows: MAX_ROWS })
    } else {
      const sql = validateSql(transform.sourceCode, log)
      log('info', 'executing SQL via isolated ephemeral database')
      const sqlInputs = inputs.map((i) => ({
        name: sanitizeTableName(i.name),
        columns: i.schema.map((c) => c.name),
        rows: i.rows,
      }))
      rows = executeSqlIsolated(sql, sqlInputs, { maxRows: MAX_ROWS })
    }

    if (rows.length > MAX_ROWS) {
      throw new Error(`Transform produced ${rows.length} rows; the current storage limit is ${MAX_ROWS}. No output was written.`)
    }
    rowCount = rows.length

    const published = await createDatasetFromRows({
      name: transform.outputDatasetName,
      rows,
      createdBy: `transform:${run.id}`,
    })
    outputDatasetId = published.dataset.id
    outputVersionNumber = published.version.versionNumber
    manifest.outputDatasetId = outputDatasetId
    manifest.outputVersionNumber = outputVersionNumber
    for (const input of inputs) {
      await db.versionLineageEdge.create({
        data: {
          transformRunId: run.id, transformId: transform.id,
          fromDatasetId: input.datasetId, fromVersionNumber: input.versionNumber,
          toDatasetId: outputDatasetId, toVersionNumber: outputVersionNumber,
        },
      })
      const existingEdge = await db.lineageEdge.findFirst({
        where: { fromDatasetId: input.datasetId, toDatasetId: outputDatasetId, pipelineId: null },
        select: { id: true },
      })
      if (!existingEdge) {
        await db.lineageEdge.create({ data: { fromDatasetId: input.datasetId, toDatasetId: outputDatasetId } })
      }
    }
    log('success', `published output "${transform.outputDatasetName}" v${published.version.versionNumber} (${published.rowCount} rows)`)

    // R14: announce the new version — upstream-triggered pipelines listen here.
    await emitVersionCreated({
      datasetId: published.dataset.id,
      versionNumber: published.version.versionNumber,
      source: `transform:${transform.name}`,
    })

    status = 'success'
  } catch (err) {
    status = 'failed'
    error = err instanceof Error ? err.message : String(err)
    log('error', error)
  } finally {
    // Isolated runner handles its own cleanup (ephemeral DB, temp dirs).
  }

  return db.transformRun.update({
    where: { id: run.id },
    data: {
      status,
      logsJson: JSON.stringify(logs),
      durationMs: Date.now() - startedAt,
      rowCount,
      outputDatasetId,
      outputVersionNumber,
      manifestJson: JSON.stringify(manifest),
      error,
      finishedAt: new Date(),
    },
  })
}

// ─── Serializers (shared with the API routes) ─────────────────────────

export type SerializedTransformRun = {
  id: string
  transformId: string
  status: 'running' | 'success' | 'failed'
  logs: LogEntry[]
  durationMs: number | null
  rowCount: number | null
  outputDatasetId: string | null
  outputVersionNumber: number | null
  error: string | null
  startedAt: Date | string
  finishedAt: Date | string | null
  hasManifest: boolean
  replayOfRunId: string | null
}

export function serializeTransformRun(run: TransformRun): SerializedTransformRun {
  return {
    id: run.id,
    transformId: run.transformId,
    status: run.status as SerializedTransformRun['status'],
    logs: parseJsonSafe<LogEntry[]>(run.logsJson, []),
    durationMs: run.durationMs,
    rowCount: run.rowCount,
    outputDatasetId: run.outputDatasetId,
    outputVersionNumber: run.outputVersionNumber,
    error: run.error,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    hasManifest: Boolean(run.manifestJson),
    replayOfRunId: run.replayOfRunId,
  }
}

export type SerializedTransform = {
  id: string
  name: string
  description: string | null
  language: 'sql' | 'javascript' | 'python'
  sourceCode: string
  inputs: { datasetId: string; datasetName: string | null }[]
  outputDatasetName: string
  createdAt: Date | string
  updatedAt: Date | string
  runsCount: number
  latestRun: {
    id: string
    status: string
    rowCount: number | null
    durationMs: number | null
    finishedAt: Date | string | null
    error: string | null
  } | null
}

/**
 * Serialize a Transform (with optional includes: first run + _count.runs)
 * into the list/detail shape. `inputNames` maps dataset id -> name (resolve
 * once per request with resolveInputNames; missing datasets -> null).
 */
export function serializeTransform(
  transform: Transform & {
    runs?: TransformRun[]
    _count?: { runs: number }
  },
  inputNames: Map<string, string>,
): SerializedTransform {
  const inputIds = parseJsonSafe<string[]>(transform.inputsJson, [])
  return {
    id: transform.id,
    name: transform.name,
    description: transform.description,
    language: transform.language as SerializedTransform['language'],
    sourceCode: transform.sourceCode,
    inputs: inputIds.map((datasetId) => ({ datasetId, datasetName: inputNames.get(datasetId) ?? null })),
    outputDatasetName: transform.outputDatasetName,
    createdAt: transform.createdAt,
    updatedAt: transform.updatedAt,
    runsCount: transform._count?.runs ?? 0,
    latestRun: transform.runs?.[0]
      ? {
          id: transform.runs[0].id,
          status: transform.runs[0].status,
          rowCount: transform.runs[0].rowCount,
          durationMs: transform.runs[0].durationMs,
          finishedAt: transform.runs[0].finishedAt,
          error: transform.runs[0].error,
        }
      : null,
  }
}

/** Resolve dataset names for all input ids referenced by the given transforms. */
export async function resolveInputNames(
  transforms: Array<Pick<Transform, 'inputsJson'>>,
): Promise<Map<string, string>> {
  const ids = [...new Set(transforms.flatMap((t) => parseJsonSafe<string[]>(t.inputsJson, [])))]
  const names = new Map<string, string>()
  if (ids.length === 0) return names
  const datasets = await db.dataset.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
  for (const d of datasets) names.set(d.id, d.name)
  return names
}
