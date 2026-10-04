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
//   `python3 -I -B` child process with a 5s hard timeout: input JSON arrives
//   on stdin, the result is written to a per-run temp file (MF_OUT env), user
//   print() lines come back on stdout as run logs, tracebacks on stderr.
//   The user code is NOT vm-isolated (learning-scale tradeoff: it is plain
//   Python running with the dev-server's privileges); -I keeps it from seeing
//   env vars/user site-packages, and both files live in a mkdtemp dir removed
//   in a finally block. Same row-value rules as JS: str|int|float|bool|None.

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import type { NextRequest } from 'next/server'
import type { Transform, TransformRun } from '@prisma/client'
import { db } from '@/lib/db'
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
  rows: Row[]
  schema: SchemaColumn[]
}

async function loadInputs(transform: Transform, log: LogFn): Promise<LoadedInput[]> {
  const ids = parseJsonSafe<string[]>(transform.inputsJson, [])
  const loaded: LoadedInput[] = []
  if (ids.length === 0) {
    log('warn', 'no input datasets configured')
  }
  for (const id of ids) {
    const dataset = await db.dataset.findUnique({ where: { id }, select: { id: true, name: true } })
    if (!dataset) {
      log('warn', `input dataset '${id}' no longer exists — skipped`)
      continue
    }
    const version = await getDatasetVersion(id)
    if (!version) {
      log('warn', `input "${dataset.name}" has no versions — skipped`)
      continue
    }
    const rows = parseJsonSafe<Row[]>(version.dataJson, [])
    loaded.push({
      datasetId: id,
      name: dataset.name,
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

/**
 * Materialize each input dataset version into a REAL SQLite table named after
 * the sanitized dataset name. Registers every created table for cleanup and
 * drops leftovers of the same name first so the user SQL sees fresh data.
 */
async function materializeInputs(
  inputs: LoadedInput[],
  tempTables: string[],
  log: LogFn,
): Promise<void> {
  const used = new Set<string>() // lowercase names claimed during THIS run
  for (const input of inputs) {
    const base = sanitizeTableName(input.name)
    let table = base
    let n = 2
    while (used.has(table.toLowerCase()) || PROTECTED_TABLES.has(table.toLowerCase())) {
      table = `${base}_${n++}`
    }
    used.add(table.toLowerCase())
    tempTables.push(table)

    await db.$executeRawUnsafe(`DROP TABLE IF EXISTS ${quoteIdent(table)}`)

    // Column set = schema columns first, then any row keys missing from the schema (TEXT).
    const colTypes = new Map<string, string>()
    for (const col of input.schema) {
      colTypes.set(col.name, col.type === 'number' ? 'REAL' : col.type === 'boolean' ? 'INTEGER' : 'TEXT')
    }
    for (const row of input.rows) {
      for (const key of Object.keys(row)) {
        if (!colTypes.has(key)) colTypes.set(key, 'TEXT')
      }
    }
    const cols = [...colTypes.keys()]
    if (cols.length === 0) {
      throw new Error(`input "${input.name}" has no columns`)
    }
    const colDefs = cols.map((c) => `${quoteIdent(c)} ${colTypes.get(c)}`).join(', ')
    await db.$executeRawUnsafe(`CREATE TABLE ${quoteIdent(table)} (${colDefs})`)

    // Chunked parameterized inserts. 200-row chunks, clamped so the bind-param
    // count stays well under SQLite's variable limit even for wide tables.
    const chunkRows = Math.max(1, Math.min(200, Math.floor(800 / cols.length)))
    for (let i = 0; i < input.rows.length; i += chunkRows) {
      const chunk = input.rows.slice(i, i + chunkRows)
      const valuesSql = chunk.map(() => `(${cols.map(() => '?').join(',')})`).join(', ')
      const params = chunk.flatMap((row) => cols.map((c) => toSqlParam(row[c])))
      await db.$executeRawUnsafe(
        `INSERT INTO ${quoteIdent(table)} (${cols.map(quoteIdent).join(', ')}) VALUES ${valuesSql}`,
        ...params,
      )
    }
    log('info', `loaded input "${input.name}" (${input.rows.length} rows) as table "${table}"`)
  }
}

/** Execute the validated SELECT and normalize every cell of the result. */
async function executeSql(sql: string, log: LogFn): Promise<Row[]> {
  log('info', 'executing SQL against materialized input tables')
  const raw = await db.$queryRawUnsafe<Record<string, unknown>[]>(sql)
  const rows: Row[] = raw.map((r) => {
    const out: Row = {}
    // Object.keys of the first row preserves the result column order.
    for (const key of Object.keys(r)) {
      out[key] = sanitizeCell(r[key])
    }
    return out
  })
  log('info', `query returned ${rows.length} rows`)
  return rows
}

// ─── Row validation (shared by the JS and Python paths) ──────────────

/**
 * Validate an arbitrary decoded JSON value as the transform result:
 * an array of plain objects whose values are string|number|boolean|null.
 * Returns typed rows; throws with a precise row/column message otherwise.
 */
function validateRows(raw: unknown): Row[] {
  if (!Array.isArray(raw)) {
    throw new Error(
      `transform must return an array of row objects (got ${raw === null ? 'null' : typeof raw})`,
    )
  }
  return raw.map((el, i) => {
    if (el === null || typeof el !== 'object' || Array.isArray(el)) {
      const got = el === null ? 'null' : Array.isArray(el) ? 'array' : typeof el
      throw new Error(`row ${i}: expected a plain object (got ${got})`)
    }
    const row: Row = {}
    for (const [key, value] of Object.entries(el as Record<string, unknown>)) {
      const ok =
        typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null
      if (!ok) {
        throw new Error(
          `row ${i} column "${key}": value must be string|number|boolean|null (got ${typeof value})`,
        )
      }
      row[key] = value
    }
    return row
  })
}

// ─── JS path ──────────────────────────────────────────────────────────

/** Execute the JS body in a fresh vm context with a 2s timeout; validate the result. */
function executeJavaScript(code: string, input: unknown, log: LogFn): Row[] {
  log('info', 'executing javascript in sandbox (vm, 2s timeout)')
  let result: unknown
  try {
    result = vm.runInNewContext(`(function(input){\n${code}\n})(__input)`, { __input: input }, { timeout: 2000 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/timed out/i.test(msg)) {
      throw new Error('script timed out after 2000ms')
    }
    throw new Error(`script error: ${msg}`)
  }
  return validateRows(result)
}

// ─── Python path ──────────────────────────────────────────────────────

/**
 * Runner prelude executed as `python3 -I -B runner.py`.
 * Contract with the user module (written next to this file as user.py):
 *   def transform(input): -> list[dict]
 * where input = { rows, datasets, schemas } (same shape as the JS path).
 * The result is validated then written as JSON to $MF_OUT; stdout is treated
 * as user logs; anything on stderr + a non-zero exit means failure.
 */
const PYTHON_RUNNER = `import json, math, os, sys

OUT = os.environ["MF_OUT"]


def __mf_fail(msg):
    sys.stderr.write(str(msg) + "\\n")
    sys.exit(1)


try:
    input = json.loads(sys.stdin.buffer.read().decode("utf-8"))
except Exception as exc:
    __mf_fail("bad input json: " + str(exc))

_g = {"__name__": "transform"}
_here = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(_here, "user.py"), "r", encoding="utf-8") as f:
    _src = f.read()
try:
    exec(compile(_src, "transform.py", "exec"), _g)
except SystemExit:
    raise
except Exception:
    import traceback
    traceback.print_exc()
    sys.exit(1)

_fn = _g.get("transform")
if not callable(_fn):
    __mf_fail('define a callable transform(input) that returns a list of row dicts')

try:
    _result = _fn(input)
except Exception:
    import traceback
    traceback.print_exc()
    __mf_fail('transform(input) raised (see traceback above)')

if not isinstance(_result, list):
    __mf_fail('transform(input) must return a list of row dicts (got ' + type(_result).__name__ + ')')

for _i, _row in enumerate(_result):
    if not isinstance(_row, dict):
        __mf_fail('row ' + str(_i) + ': expected a dict (got ' + type(_row).__name__ + ')')
    for _k, _v in _row.items():
        if _v is None or isinstance(_v, (str, bool, int, float)):
            if isinstance(_v, float) and (math.isnan(_v) or math.isinf(_v)):
                __mf_fail('row ' + str(_i) + ' column "' + str(_k) + '": float values must be finite (got ' + str(_v) + ')')
        else:
            __mf_fail('row ' + str(_i) + ' column "' + str(_k) + '": value must be str|int|float|bool|None (got ' + type(_v).__name__ + ')')

with open(OUT, "w", encoding="utf-8") as f:
    json.dump(_result, f, ensure_ascii=False, allow_nan=False)
`

interface PythonSpawnResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

const PY_TIMEOUT_MS = 5_000
const PY_STREAM_CAP = 100_000 // cap captured stdout/stderr per stream (chars)

/** Spawn `python3 -I -B runner.py`, feed stdin, enforce the timeout, collect streams. */
function spawnPython(workDir: string, stdinJson: string): Promise<PythonSpawnResult> {
  return new Promise((resolve) => {
    const child = spawn('python3', ['-I', '-B', path.join(workDir, 'runner.py')], {
      // Phase 0 isolation hardening: a MINIMAL environment — the child gets
      // PATH + the out-file path only, so server secrets (AUTH_SECRET,
      // MF_SERVICE_TOKEN, DATABASE_URL, …) are never inherited by user code.
      // (`-I` already isolates interpreter paths; this closes the env leak.)
      env: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        NODE_ENV: process.env.NODE_ENV,
        MF_OUT: path.join(workDir, 'out.json'),
        HOME: workDir,
        LANG: 'C.UTF-8',
      },
      cwd: workDir,
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, PY_TIMEOUT_MS)

    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    }

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < PY_STREAM_CAP) stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < PY_STREAM_CAP) stderr += chunk.toString('utf8')
    })
    child.on('error', (err) => {
      stderr += `\nspawn error: ${err.message}`
      finish(null)
    })
    child.on('close', (code) => finish(code))

    child.stdin.on('error', () => {
      /* EPIPE if the child exits before reading — the close handler reports */
    })
    child.stdin.end(stdinJson, 'utf8')
  })
}

/**
 * Execute a Python transform module: write runner.py + user.py into a fresh
 * mkdtemp dir, feed the input JSON on stdin, read the validated result from
 * out.json. User print() lines surface as run logs; stderr tails as the error.
 */
async function executePython(code: string, input: unknown, log: LogFn): Promise<Row[]> {
  log('info', `executing python (python3 -I -B, ${PY_TIMEOUT_MS / 1000}s timeout)`)
  const dir = await mkdtemp(path.join(tmpdir(), 'mf-py-'))
  try {
    await writeFile(path.join(dir, 'runner.py'), PYTHON_RUNNER, 'utf8')
    await writeFile(path.join(dir, 'user.py'), code, 'utf8')
    const res = await spawnPython(dir, JSON.stringify(input))

    for (const line of res.stdout.split('\n')) {
      const trimmed = line.trimEnd()
      if (trimmed.trim() !== '') log('info', `py: ${trimmed}`)
    }

    if (res.timedOut) {
      throw new Error(`python timed out after ${PY_TIMEOUT_MS}ms`)
    }
    if (res.code !== 0) {
      const tail = res.stderr
        .trim()
        .split('\n')
        .filter(Boolean)
        .slice(-8)
        .join('\n')
      throw new Error(
        tail ? `python exited with code ${res.code}:\n${tail}` : `python exited with code ${res.code}`,
      )
    }

    let raw: string
    try {
      raw = await readFile(path.join(dir, 'out.json'), 'utf8')
    } catch {
      throw new Error('python runner did not produce a result file')
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('python runner produced unreadable output (invalid JSON)')
    }
    return validateRows(parsed)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {
      /* cleanup is best-effort; the dir is a fresh mkdtemp under tmpdir */
    })
  }
}

// ─── Main entry ───────────────────────────────────────────────────────

/**
 * Run a transform synchronously: create the TransformRun row first, execute,
 * publish the output dataset version, then finalize the run (status, logs,
 * duration, outputs). Temp SQL tables are ALWAYS dropped — even on failure.
 * Never throws for user-code/validation failures: those are recorded on the
 * run (status failed + error + logs) so callers always get a run back.
 */
export async function runTransform(transform: Transform, _req?: NextRequest): Promise<TransformRun> {
  const run = await db.transformRun.create({
    data: { transformId: transform.id, status: 'running', logsJson: '[]' },
  })
  const logs: LogEntry[] = []
  const log: LogFn = (level, msg) => {
    logs.push({ ts: new Date().toISOString(), level, msg })
  }
  const startedAt = Date.now()
  const tempTables: string[] = []
  let status: 'success' | 'failed' = 'failed'
  let error: string | null = null
  let rowCount: number | null = null
  let outputDatasetId: string | null = null
  let outputVersionNumber: number | null = null

  try {
    log('info', `run started (language=${transform.language})`)
    const inputs = await loadInputs(transform, log)

    let rows: Row[]
    if (transform.language === 'javascript') {
      const first = inputs[0]
      const input = {
        rows: first ? first.rows : [],
        datasets: Object.fromEntries(inputs.map((i) => [i.name, i.rows])),
        schemas: Object.fromEntries(inputs.map((i) => [i.name, i.schema])),
      }
      rows = executeJavaScript(transform.sourceCode, input, log)
    } else if (transform.language === 'python') {
      const first = inputs[0]
      const input = {
        rows: first ? first.rows : [],
        datasets: Object.fromEntries(inputs.map((i) => [i.name, i.rows])),
        schemas: Object.fromEntries(inputs.map((i) => [i.name, i.schema])),
      }
      rows = await executePython(transform.sourceCode, input, log)
    } else {
      const sql = validateSql(transform.sourceCode, log)
      await materializeInputs(inputs, tempTables, log)
      rows = await executeSql(sql, log)
    }

    if (rows.length > MAX_ROWS) {
      log('warn', `result truncated from ${rows.length} to ${MAX_ROWS} rows (MAX_ROWS)`)
      rows = rows.slice(0, MAX_ROWS)
    }
    rowCount = rows.length

    const published = await createDatasetFromRows({
      name: transform.outputDatasetName,
      rows,
      createdBy: `transform:${run.id}`,
    })
    outputDatasetId = published.dataset.id
    outputVersionNumber = published.version.versionNumber
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
    // Temp tables are REAL tables in the shared db file — ALWAYS drop them,
    // even when the run failed mid-way. Individual failures are swallowed so
    // the run row can still be finalized.
    for (const table of tempTables) {
      try {
        await db.$executeRawUnsafe(`DROP TABLE IF EXISTS ${quoteIdent(table)}`)
      } catch {
        // cleanup is best-effort; table is prefixed-free but scoped to this run
      }
    }
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
