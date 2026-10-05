// MiniFoundry — isolated code execution runner.
//
// Executes user-written SQL, JavaScript, and Python transforms outside the
// application's trust boundary:
//   • SQL runs against a per-run ephemeral SQLite database containing only the
//     materialized input tables. The app database is never exposed.
//   • JavaScript runs in a worker_thread with no network, no fs, no child_process,
//     and a hard timeout.
//   • Python runs as a subprocess with -I -B flags, a temp directory, and a timeout.

import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import type { Row } from '@/lib/dataset-service'

export interface IsolatedRunOptions {
  timeoutMs?: number
  maxRows?: number
}

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_ROWS = 50_000

// ─── SQL ──────────────────────────────────────────────────────────────

export interface SqlInputTable {
  name: string
  columns: string[]
  rows: Row[]
}

/**
 * Execute a SELECT statement against an ephemeral SQLite database containing
 * only the provided input tables. Returns normalized rows. The database is
 * created in-memory and never touches the app database.
 */
export function executeSqlIsolated(
  sql: string,
  inputs: SqlInputTable[],
  options: IsolatedRunOptions = {},
): Row[] {
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS
  const trimmed = sql.trim().replace(/;+$/, '').trim()
  if (!/^select\b/i.test(trimmed)) {
    throw new Error('Only SELECT statements are allowed in isolated SQL execution')
  }
  if (/;/.test(trimmed)) {
    throw new Error('Multiple statements are not allowed')
  }

  const db = new DatabaseSync(':memory:')
  try {
    for (const input of inputs) {
      if (input.columns.length === 0) continue
      const colDefs = input.columns.map((c) => `"${c.replace(/"/g, '""')}" TEXT`).join(', ')
      db.exec(`CREATE TABLE "${input.name.replace(/"/g, '""')}" (${colDefs})`)
      if (input.rows.length === 0) continue
      const placeholders = input.columns.map(() => '?').join(', ')
      const insertSql = `INSERT INTO "${input.name.replace(/"/g, '""')}" VALUES (${placeholders})`
      for (const row of input.rows) {
        const values = input.columns.map((c) => {
          const v = row[c]
          if (v == null) return null
          if (typeof v === 'string') return v
          return String(v)
        })
        db.prepare(insertSql).run(...values)
      }
    }

    const raw = db.prepare(trimmed).all() as Record<string, unknown>[]
    if (raw.length > maxRows) {
      throw new Error(`SQL result has ${raw.length} rows; limit is ${maxRows}`)
    }
    return raw.map((r) => {
      const out: Row = {}
      for (const [k, v] of Object.entries(r)) {
        out[k] = v == null ? null : typeof v === 'number' || typeof v === 'boolean' ? v : String(v)
      }
      return out
    })
  } finally {
    db.close()
  }
}

// ─── JavaScript ───────────────────────────────────────────────────────

/**
 * Execute a JS transform body in a worker thread with restricted globals.
 */
export async function executeJsIsolated(
  code: string,
  input: unknown,
  options: IsolatedRunOptions = {},
): Promise<Row[]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS

  const workerScript = `
    const { parentPort, workerData } = require('node:worker_threads');
    delete globalThis.process;
    delete globalThis.require;
    delete globalThis.__dirname;
    delete globalThis.__filename;
    try {
      const fn = new Function('input', workerData.code);
      const result = fn(workerData.input);
      parentPort.postMessage({ ok: true, result });
    } catch (err) {
      parentPort.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  `

  return new Promise<Row[]>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      worker.terminate().catch(() => {})
      reject(new Error(`JavaScript execution timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    const worker = new Worker(workerScript, {
      eval: true,
      workerData: { code: `(function(input){\n${code}\n})(input)`, input },
      execArgv: ['--no-warnings'],
      env: {},
    })

    worker.on('message', (msg: { ok: boolean; result?: unknown; error?: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      worker.terminate().catch(() => {})
      if (!msg.ok) {
        reject(new Error(`script error: ${msg.error}`))
        return
      }
      try {
        resolve(validateRunnerRows(msg.result, maxRows))
      } catch (err) {
        reject(err)
      }
    })

    worker.on('error', (err: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`worker error: ${err.message}`))
    })

    worker.on('exit', (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (exitCode !== 0) {
        reject(new Error(`worker exited with code ${exitCode}`))
      }
    })
  })
}

// ─── Python ───────────────────────────────────────────────────────────

const PYTHON_RUNNER = `
import json, sys, importlib.util, os
spec = importlib.util.spec_from_file_location("user", os.path.join(os.path.dirname(__file__), "user.py"))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
data = json.load(sys.stdin)
result = mod.transform(data)
with open(os.path.join(os.path.dirname(__file__), "out.json"), "w") as f:
    json.dump(result, f)
`.trim()

export async function executePythonIsolated(
  code: string,
  input: unknown,
  options: IsolatedRunOptions = {},
): Promise<Row[]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS
  // Windows commonly installs python.exe while python3.exe is only the
  // Microsoft Store app alias. Allow an explicit interpreter override too.
  const python = process.env.MF_PYTHON_BIN?.trim() || (process.platform === 'win32' ? 'python' : 'python3')

  const dir = await mkdtemp(path.join(tmpdir(), 'mf-py-iso-'))
  try {
    await writeFile(path.join(dir, 'runner.py'), PYTHON_RUNNER, 'utf8')
    await writeFile(path.join(dir, 'user.py'), code, 'utf8')

    const result = await new Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }>((resolve) => {
      let stdout = ''
      let stderr = ''
      let timedOut = false
      const proc = spawn(python, ['-I', '-B', 'runner.py'], {
        cwd: dir,
        stdio: 'pipe',
        env: { PATH: process.env.PATH ?? '', HOME: dir } as unknown as NodeJS.ProcessEnv,
        timeout: timeoutMs,
      }) as import('node:child_process').ChildProcessWithoutNullStreams
      proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
      proc.on('error', () => {})
      proc.on('close', (code) => {
        resolve({ stdout, stderr, code, timedOut })
      })
      proc.stdin.write(JSON.stringify(input))
      proc.stdin.end()
    })

    if (result.timedOut) throw new Error(`Python timed out after ${timeoutMs}ms`)
    if (result.code !== 0) {
      const tail = result.stderr.trim().split('\n').filter(Boolean).slice(-5).join('\n')
      throw new Error(tail ? `Python exited with code ${result.code}:\n${tail}` : `Python exited with code ${result.code}`)
    }

    let raw: string
    try {
      raw = await readFile(path.join(dir, 'out.json'), 'utf8')
    } catch {
      throw new Error('Python runner did not produce a result file')
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('Python runner produced invalid JSON output')
    }
    return validateRunnerRows(parsed, maxRows)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

// ─── Validation ───────────────────────────────────────────────────────

function validateRunnerRows(raw: unknown, maxRows: number): Row[] {
  if (!Array.isArray(raw)) {
    throw new Error(`transform must return an array of row objects (got ${raw === null ? 'null' : typeof raw})`)
  }
  if (raw.length > maxRows) {
    throw new Error(`transform returned ${raw.length} rows; limit is ${maxRows}`)
  }
  return raw.map((el, i) => {
    if (el === null || typeof el !== 'object' || Array.isArray(el)) {
      const got = el === null ? 'null' : Array.isArray(el) ? 'array' : typeof el
      throw new Error(`row ${i}: expected a plain object (got ${got})`)
    }
    const row: Row = {}
    for (const [key, value] of Object.entries(el as Record<string, unknown>)) {
      const ok = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null
      if (!ok) throw new Error(`row ${i} column "${key}": value must be string|number|boolean|null (got ${typeof value})`)
      row[key] = value
    }
    return row
  })
}
