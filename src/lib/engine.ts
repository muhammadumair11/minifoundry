// MiniFoundry — pipeline execution engine (M3).
// Executes a pipeline graph synchronously: topologically sorts nodes, streams rows
// between nodes in memory, writes the output dataset version and captures lineage.

import { db } from '@/lib/db'
import { createHash } from 'node:crypto'
import { createDatasetFromRows, compareValues, resolveConsumerVersion, toNumber, type Row } from '@/lib/dataset-service'
import { ensurePipelineVersion } from '@/lib/pipeline-version-service'
import { emitVersionCreated } from '@/lib/version-events'
import type { PipelineRun } from '@prisma/client'
import type { LogEntry } from '@/lib/api-utils'
import { parseJsonSafe } from '@/lib/api-utils'

// ─── Graph types ─────────────────────────────────────────────────────

export interface GraphNode {
  id: string
  type: string
  data: Record<string, unknown>
  position?: { x: number; y: number }
}

export interface GraphEdge {
  id: string
  source: string
  target: string
}

export interface PipelineGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

const KNOWN_NODE_TYPES = [
  'source', 'filter', 'derive', 'select', 'rename', 'join',
  'aggregate', 'sort', 'dedupe', 'union', 'limit', 'output',
] as const

/** Errors with a clean, user-facing message (graph validation / pipeline runtime). */
export class PipelineError extends Error {}

interface ExecContext {
  pipelineId: string
  runId: string
  /** Pipeline display name — used to label version-created events (loop guards). */
  pipelineName: string
  sourceDatasetIds: string[]
  log: (level: LogEntry['level'], msg: string) => void
  /** Mutable holder: the output node reports its write result here. */
  outputResult: { value: ExecuteResult | null }
  // ── Phase 1 (reproducible builds) ──
  /** Replay pin: datasetId → exact versionNumber to read instead of the head. */
  inputOverrides: Record<string, number>
  /** Captured manifest pieces (mutated by source/output node execution). */
  capture: ManifestCapture
}

// ─── Run manifest types (Phase 1: reproducible builds) ──────────────

export interface ManifestInput {
  datasetId: string
  datasetName: string
  /** Exact version this run read (null only when the dataset had no versions). */
  versionNumber: number | null
  rowCount: number
}

export interface ManifestOutput {
  datasetId: string
  datasetName: string
  versionNumber: number
  rowCount: number
}

export interface ManifestNode {
  nodeId: string
  type: string
  label?: string
  /** sha256 of inline code (derive nodes) — confirms the exact logic identity. */
  codeSha256?: string
}

export interface RunManifest {
  graphVersion: { versionNumber: number | null; nodeCount: number }
  inputs: ManifestInput[]
  outputs: ManifestOutput[]
  nodes: ManifestNode[]
}

/** Mutable collector threaded through executeGraph, then written to the run row. */
interface ManifestCapture {
  inputs: ManifestInput[]
  outputs: ManifestOutput[]
  nodes: ManifestNode[]
}

function newManifestCapture(): ManifestCapture {
  return { inputs: [], outputs: [], nodes: [] }
}

interface ExecuteResult {
  outputDatasetId: string
  outputName: string
  outputVersionNumber: number
  outputRowCount: number
}

// ─── Public entry point ──────────────────────────────────────────────

export interface RunPipelineOptions {
  /** Schedule that triggered this run; advances lastRunAt/nextRunAt after the run (success OR failed). Not propagated to cascades. */
  scheduleId?: string | null
  /** Cascade depth: manual runs = 0, cascaded runs = parent + 1. Cascades stop once depth >= CASCADE_MAX_DEPTH. */
  cascadeDepth?: number
  /** M3.1: graph to execute INSTEAD of pipeline.graphJson (a pinned PipelineVersion snapshot). Absent = read pipeline.graphJson (pre-versioning behavior). */
  graphOverride?: string
  /** M3.1: version number written on the created run row (null/absent = pre-versioning run). */
  versionNumber?: number | null
  /** Internal: pipeline ids already visited in the current cascade chain (loop guard). Callers should not set this. */
  _chain?: Set<string>
  /** R14: what caused this run — manual | schedule | upstream | retry (persisted on PipelineRun). */
  trigger?: string
  /** R14: 1-based attempt number (automatic retries increment). */
  attempt?: number
  // ── Phase 1 (reproducible builds) ──
  /** Replay pin: datasetId → exact versionNumber each source node must read (replay of a past run's manifest). */
  inputOverrides?: Record<string, number>
  /** When set, this run replays that earlier run (recorded on the run row for provenance). */
  replayOfRunId?: string | null
}

/** Options for the shared "run the pipeline's latest pinned version" entry point. */
export interface RunPipelineVersionOptions {
  /** Run trigger label persisted on the PipelineRun row. Default 'manual'. */
  trigger?: 'manual' | 'schedule' | 'upstream' | 'retry'
  /** 1-based attempt number. Default 1. */
  attempt?: number
  /** Optional schedule to advance after the run (manual/schedule callers). */
  scheduleId?: string | null
  /** Cascade depth (manual/schedule runs = 0). */
  cascadeDepth?: number
}

/**
 * R14: run a pipeline's LATEST pinned PipelineVersion with explicit trigger
 * bookkeeping. Both the manual-run API route and the upstream trigger engine
 * go through this function so every run records the same fields (version pin,
 * trigger, attempt) no matter who started it.
 */
export async function runPipelineVersion(
  pipelineId: string,
  opts: RunPipelineVersionOptions = {},
): Promise<PipelineRun> {
  const version = await ensurePipelineVersion(pipelineId)
  return runPipeline(pipelineId, {
    scheduleId: opts.scheduleId ?? null,
    cascadeDepth: opts.cascadeDepth ?? 0,
    graphOverride: version.graphJson,
    versionNumber: version.versionNumber,
    trigger: opts.trigger ?? 'manual',
    attempt: opts.attempt ?? 1,
  })
}

/** Max downstream pipelines triggered per successful run. */
const CASCADE_MAX_CHILDREN = 5
/** Max cascade depth (manual run = 0 → children at 1 → grandchildren at 2 → stop). */
const CASCADE_MAX_DEPTH = 2
/** A 'running' run older than this is considered stale (e.g. crashed dev server) and no longer blocks new runs. */
const RUNNING_STALE_MS = 10 * 60 * 1000

/**
 * Execute a pipeline end-to-end and return the final PipelineRun record.
 * The run is created up-front (status 'running') and updated to success/failed.
 * Throws only if the pipeline itself does not exist (no run record possible).
 *
 * Side effects after a SUCCESSFUL run (cascade): every pipeline whose source
 * nodes reference the output dataset is triggered (max 5, max depth 2, guarded
 * against loops). A failing cascade never fails the parent run.
 * If opts.scheduleId is set, the schedule window is advanced after the run
 * regardless of outcome, so failed schedules retry on the next interval.
 */
export async function runPipeline(
  pipelineId: string,
  opts: RunPipelineOptions = {},
): Promise<PipelineRun> {
  const cascadeDepth = opts.cascadeDepth ?? 0
  const chain = opts._chain ?? new Set<string>()
  chain.add(pipelineId)

  const pipeline = await db.pipeline.findUnique({ where: { id: pipelineId } })
  if (!pipeline) throw new PipelineError(`Pipeline ${pipelineId} not found`)

  // Concurrency guard: only one in-flight run per pipeline (prevents scheduler
  // overlap pile-ups). Simple "is anything still running?" check at learning scale.
  const staleCutoff = new Date(Date.now() - RUNNING_STALE_MS)
  const active = await db.pipelineRun.findFirst({
    where: { pipelineId, status: 'running', startedAt: { gt: staleCutoff } },
    select: { id: true },
  })
  if (active) {
    const now = new Date()
    const skipped = await db.pipelineRun.create({
      data: {
        pipelineId,
        status: 'failed',
        finishedAt: now,
        versionNumber: opts.versionNumber ?? null,
        trigger: opts.trigger ?? 'manual',
        attempt: opts.attempt ?? 1,
        durationMs: 0,
        failureCause: 'Run skipped: another run is already in progress',
        replayedFromRunId: opts.replayOfRunId ?? null,
        manifestJson: JSON.stringify({
          graphVersion: { versionNumber: opts.versionNumber ?? null, nodeCount: 0 },
          inputs: [],
          outputs: [],
          nodes: [],
        } satisfies RunManifest),
        logsJson: JSON.stringify([
          { ts: now.toISOString(), level: 'error', msg: 'Run skipped: another run is already in progress' },
        ] satisfies LogEntry[]),
      },
    })
    // Advance the schedule anyway so a due schedule cannot fire every tick against a busy pipeline.
    await advanceSchedule(opts.scheduleId)
    return skipped
  }

  const run = await db.pipelineRun.create({
    data: {
      pipelineId,
      status: 'running',
      logsJson: '[]',
      versionNumber: opts.versionNumber ?? null,
      trigger: opts.trigger ?? 'manual',
      attempt: opts.attempt ?? 1,
      replayedFromRunId: opts.replayOfRunId ?? null,
    },
  })

  const logs: LogEntry[] = []
  const log = (level: LogEntry['level'], msg: string) => {
    logs.push({ ts: new Date().toISOString(), level, msg })
  }
  /** Flush the current in-memory log buffer to the run row (used for cascade logs after finalization). */
  const persistLogs = () =>
    db.pipelineRun.update({ where: { id: run.id }, data: { logsJson: JSON.stringify(logs) } })

  const startedAtMs = Date.now()
  let result: ExecuteResult | null = null
  let failureMsg: string | null = null
  const capture = newManifestCapture()
  try {
    const graphJson = opts.graphOverride ?? pipeline.graphJson
    result = await executeGraph(pipelineId, run.id, pipeline.name, graphJson, log, capture, opts.inputOverrides ?? {})
    const elapsed = Date.now() - startedAtMs
    log(
      'success',
      `Pipeline '${pipeline.name}' completed in ${elapsed}ms — output dataset '${result.outputName}' (v${result.outputVersionNumber}, ${result.outputRowCount} rows)`,
    )
  } catch (err) {
    failureMsg = err instanceof Error ? err.message : String(err)
    log('error', `Pipeline failed: ${failureMsg}`)
  }
  const durationMs = Date.now() - startedAtMs

  // Phase 1: the run manifest — one build record with the pinned graph version,
  // the exact input versions read, the outputs written, and node fingerprints
  // (incl. sha256 of inline derive code). Written for success AND failed runs
  // (a partial manifest is still the best diagnostic record we can keep).
  const manifest: RunManifest = {
    graphVersion: { versionNumber: opts.versionNumber ?? null, nodeCount: capture.nodes.length },
    inputs: capture.inputs,
    outputs: capture.outputs,
    nodes: capture.nodes,
  }

  // Finalize the run itself (success or failed) before cascade side-effects,
  // so the run never lingers as 'running' while downstream pipelines execute.
  const finalRun = await db.pipelineRun.update({
    where: { id: run.id },
    data: {
      status: result ? 'success' : 'failed',
      finishedAt: new Date(),
      logsJson: JSON.stringify(logs),
      manifestJson: JSON.stringify(manifest),
      durationMs,
      failureCause: failureMsg,
      outputDatasetId: result?.outputDatasetId ?? null,
      outputVersionNumber: result?.outputVersionNumber ?? null,
    },
  })

  // Schedule bookkeeping happens for success AND failed runs (next interval retries).
  await advanceSchedule(opts.scheduleId)

  // Cascade: trigger downstream pipelines that consume this run's output dataset.
  if (result) {
    await triggerCascades({
      parentPipelineId: pipeline.id,
      outputDatasetId: result.outputDatasetId,
      cascadeDepth,
      chain,
      log,
      persistLogs,
    })
  }

  // Re-read so the returned record includes any cascade log lines appended above.
  const fresh = await db.pipelineRun.findUnique({ where: { id: run.id } })
  return fresh ?? finalRun
}

// ─── Cascade orchestration (M5) ──────────────────────────────────────

interface CascadeArgs {
  parentPipelineId: string
  outputDatasetId: string
  cascadeDepth: number
  chain: Set<string>
  log: (level: LogEntry['level'], msg: string) => void
  persistLogs: () => Promise<unknown>
}

/**
 * After a successful run wrote output dataset D, find pipelines whose graph's
 * source nodes reference D (parsed safely, self excluded) and trigger up to 5
 * of them at cascadeDepth + 1. scheduleId is intentionally NOT propagated —
 * cascades are pipeline-triggered, not schedule-triggered. Every trigger and
 * outcome is logged on the PARENT run; a failing cascade never fails the parent.
 */
async function triggerCascades(args: CascadeArgs): Promise<void> {
  if (args.cascadeDepth >= CASCADE_MAX_DEPTH) return

  let candidates: Array<{ id: string; name: string }>
  try {
    const pipelines = await db.pipeline.findMany({
      where: { id: { not: args.parentPipelineId } },
      select: { id: true, name: true, graphJson: true },
      orderBy: { createdAt: 'asc' },
    })
    candidates = pipelines
      .filter((p) => graphSourcesIncludeDataset(p.graphJson, args.outputDatasetId))
      .slice(0, CASCADE_MAX_CHILDREN)
      .map((p) => ({ id: p.id, name: p.name }))
  } catch (err) {
    args.log(
      'warn',
      `cascade: failed to look up downstream pipelines — ${err instanceof Error ? err.message : String(err)}`,
    )
    await args.persistLogs()
    return
  }

  for (const child of candidates) {
    if (args.chain.has(child.id)) {
      args.log('info', `cascade: skipped '${child.name}' (already in chain)`)
      await args.persistLogs()
      continue
    }
    args.log('info', `cascade: triggered '${child.name}' (depth ${args.cascadeDepth + 1})`)
    await args.persistLogs()
    args.chain.add(child.id)
    try {
      // M3.1: cascade runs pin the child's latest version too (cheap after first call).
      const childVersion = await ensurePipelineVersion(child.id)
      const childRun = await runPipeline(child.id, {
        cascadeDepth: args.cascadeDepth + 1,
        _chain: args.chain,
        graphOverride: childVersion.graphJson,
        versionNumber: childVersion.versionNumber,
      })
      args.log('info', `cascade: '${child.name}' finished with status ${childRun.status}`)
    } catch (err) {
      // A failing cascade must never fail the parent run.
      args.log(
        'error',
        `cascade: '${child.name}' failed to start — ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    await args.persistLogs()
  }
}

/** True when any source node in a pipeline's graph references the given dataset id. */
function graphSourcesIncludeDataset(graphJson: string, datasetId: string): boolean {
  const graph = parseJsonSafe<Partial<PipelineGraph> | null>(graphJson, null)
  if (!graph || !Array.isArray(graph.nodes)) return false
  return graph.nodes.some(
    (n) =>
      n?.type === 'source' &&
      n?.data &&
      typeof n.data === 'object' &&
      (n.data as Record<string, unknown>).datasetId === datasetId,
  )
}

/**
 * Advance a schedule window after its triggered run completes (success OR failed):
 * lastRunAt = now, nextRunAt = now + intervalMinutes. Silently ignores unknown
 * schedule ids / update failures — the run outcome must not depend on this.
 */
async function advanceSchedule(scheduleId?: string | null): Promise<void> {
  if (!scheduleId) return
  try {
    const schedule = await db.schedule.findUnique({ where: { id: scheduleId } })
    if (!schedule) return
    const now = new Date()
    await db.schedule.update({
      where: { id: schedule.id },
      data: {
        lastRunAt: now,
        nextRunAt: new Date(now.getTime() + schedule.intervalMinutes * 60_000),
      },
    })
  } catch (err) {
    console.error(`[engine] failed to advance schedule '${scheduleId}':`, err)
  }
}

// ─── Graph orchestration ─────────────────────────────────────────────

async function executeGraph(
  pipelineId: string,
  runId: string,
  pipelineName: string,
  graphJson: string,
  log: (level: LogEntry['level'], msg: string) => void,
  capture: ManifestCapture = newManifestCapture(),
  inputOverrides: Record<string, number> = {},
): Promise<ExecuteResult> {
  const graph = parseGraph(graphJson)
  log('info', `Pipeline '${pipelineName}' run started (graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges)`)

  validateGraph(graph)
  const order = topoSort(graph)

  const ctx: ExecContext = {
    pipelineId,
    runId,
    pipelineName,
    sourceDatasetIds: [
      ...new Set(
        graph.nodes
          .filter((n) => n.type === 'source' && typeof n.data.datasetId === 'string')
          .map((n) => n.data.datasetId as string),
      ),
    ],
    log,
    outputResult: { value: null },
    inputOverrides,
    capture,
  }

  const outputs = new Map<string, Row[]>() // nodeId -> rows produced
  let result: ExecuteResult | null = null

  for (const node of order) {
    // Phase 1: fingerprint every executed node — type, display label, and the
    // sha256 of any inline logic (derive stores it in `expression`; future
    // code-carrying node types can use `code`). The graph itself is already
    // pinned by the run's pipeline version; the hash makes identity explicit.
    const label = typeof node.data.name === 'string' ? node.data.name : typeof node.data.label === 'string' ? node.data.label : undefined
    const inlineCode = typeof node.data.code === 'string' ? node.data.code : typeof node.data.expression === 'string' ? node.data.expression : undefined
    capture.nodes.push({
      nodeId: node.id,
      type: node.type,
      ...(label ? { label } : {}),
      ...(inlineCode ? { codeSha256: createHash('sha256').update(inlineCode).digest('hex') } : {}),
    })

    const inputs = graph.edges
      .filter((e) => e.target === node.id)
      .map((e) => {
        const rows = outputs.get(e.source)
        if (!rows) {
          throw new PipelineError(`Internal error: input from node '${e.source}' was not computed before '${node.id}'`)
        }
        return rows
      })

    const inCount = inputs.reduce((n, rows) => n + rows.length, 0)
    const out = await execNode(node, inputs, ctx)
    outputs.set(node.id, out)
    log('info', `node ${node.type} (${node.id}): ${inCount} rows in -> ${out.length} rows out`)
    if (node.type === 'output') {
      if (!ctx.outputResult.value) throw new PipelineError('output node did not produce a result')
      result = ctx.outputResult.value
    }
  }

  if (!result) throw new PipelineError('Pipeline did not produce an output dataset')
  return result
}

function parseGraph(graphJson: string): PipelineGraph {
  const parsed = parseJsonSafe<Partial<PipelineGraph> | null>(graphJson, null)
  if (!parsed || typeof parsed !== 'object') {
    throw new PipelineError('Pipeline graph is not valid JSON')
  }
  if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
    throw new PipelineError('Pipeline graph must contain "nodes" and "edges" arrays')
  }
  const nodes: GraphNode[] = parsed.nodes.map((n, i) => ({
    id: typeof n?.id === 'string' ? n.id : `node-${i}`,
    type: typeof n?.type === 'string' ? n.type : String(n?.type ?? ''),
    data: (n?.data && typeof n.data === 'object' && !Array.isArray(n.data)
      ? n.data
      : {}) as Record<string, unknown>,
    position:
      n?.position && typeof n.position === 'object'
        ? (n.position as { x: number; y: number })
        : undefined,
  }))
  const edges: GraphEdge[] = parsed.edges
    .filter((e) => e && typeof e.source === 'string' && typeof e.target === 'string')
    .map((e, i) => ({
      id: typeof e.id === 'string' ? e.id : `edge-${i}`,
      source: e.source,
      target: e.target,
    }))
  return { nodes, edges }
}

function validateGraph(graph: PipelineGraph): void {
  if (graph.nodes.length === 0) throw new PipelineError('Pipeline graph has no nodes')

  const ids = new Set<string>()
  for (const node of graph.nodes) {
    if (!node.id) throw new PipelineError('A node is missing an id')
    if (ids.has(node.id)) throw new PipelineError(`Duplicate node id '${node.id}'`)
    ids.add(node.id)
    if (!KNOWN_NODE_TYPES.includes(node.type as (typeof KNOWN_NODE_TYPES)[number])) {
      throw new PipelineError(`Unknown node type '${node.type}' (node '${node.id}')`)
    }
  }
  for (const edge of graph.edges) {
    if (!ids.has(edge.source)) {
      throw new PipelineError(`Edge '${edge.id}' references unknown source node '${edge.source}'`)
    }
    if (!ids.has(edge.target)) {
      throw new PipelineError(`Edge '${edge.id}' references unknown target node '${edge.target}'`)
    }
  }

  const outputNodes = graph.nodes.filter((n) => n.type === 'output')
  if (outputNodes.length !== 1) {
    throw new PipelineError(`Pipeline must have exactly one output node (found ${outputNodes.length})`)
  }

  const inDegree = new Map<string, number>()
  for (const node of graph.nodes) inDegree.set(node.id, 0)
  for (const edge of graph.edges) inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1)

  for (const node of graph.nodes) {
    const n = inDegree.get(node.id) ?? 0
    if (node.type === 'source') {
      if (n > 0) throw new PipelineError(`source node '${node.id}' must not have incoming edges`)
    } else if (node.type === 'join' || node.type === 'union') {
      if (n !== 2) throw new PipelineError(`${node.type} node '${node.id}' requires exactly 2 inputs (found ${n})`)
    } else if (n !== 1) {
      throw new PipelineError(`${node.type} node '${node.id}' requires exactly 1 input (found ${n})`)
    }
  }
}

/** Kahn's algorithm; throws on cycles. Returns nodes in execution order. */
function topoSort(graph: PipelineGraph): GraphNode[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const inDegree = new Map<string, number>()
  const adjacency = new Map<string, string[]>()
  for (const node of graph.nodes) {
    inDegree.set(node.id, 0)
    adjacency.set(node.id, [])
  }
  for (const edge of graph.edges) {
    adjacency.get(edge.source)!.push(edge.target)
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1)
  }

  const queue = graph.nodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0).map((n) => n.id)
  const order: string[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    order.push(id)
    for (const target of adjacency.get(id)!) {
      const next = (inDegree.get(target) ?? 0) - 1
      inDegree.set(target, next)
      if (next === 0) queue.push(target)
    }
  }
  if (order.length !== graph.nodes.length) {
    const cyclic = graph.nodes.filter((n) => !order.includes(n.id)).map((n) => n.id)
    throw new PipelineError(`Pipeline graph contains a cycle involving nodes: ${cyclic.join(', ')}`)
  }
  return order.map((id) => byId.get(id)!)
}

// ─── Node dispatch ───────────────────────────────────────────────────

async function execNode(node: GraphNode, inputs: Row[][], ctx: ExecContext): Promise<Row[]> {
  switch (node.type) {
    case 'source': return execSource(node, ctx)
    case 'filter': return execFilter(node, singleInput(node, inputs))
    case 'derive': return execDerive(node, singleInput(node, inputs), ctx)
    case 'select': return execSelect(node, singleInput(node, inputs))
    case 'rename': return execRename(node, singleInput(node, inputs))
    case 'join': return execJoin(node, inputs)
    case 'aggregate': return execAggregate(node, singleInput(node, inputs))
    case 'sort': return execSort(node, singleInput(node, inputs))
    case 'dedupe': return execDedupe(node, singleInput(node, inputs))
    case 'union': return execUnion(node, inputs)
    case 'limit': return execLimit(node, singleInput(node, inputs))
    case 'output': return execOutput(node, singleInput(node, inputs), ctx)
    default:
      throw new PipelineError(`Unknown node type '${node.type}' (node '${node.id}')`)
  }
}

function singleInput(node: GraphNode, inputs: Row[][]): Row[] {
  if (inputs.length !== 1) {
    throw new PipelineError(`${node.type} node '${node.id}' requires exactly 1 input (found ${inputs.length})`)
  }
  return inputs[0]
}

// ─── Value helpers ───────────────────────────────────────────────────

/** Canonical join/group key so that 10, "10" and 10.0 match. */
function keyOf(v: unknown): string {
  const n = toNumber(v)
  return Number.isNaN(n) ? String(v) : String(n)
}

function numericEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true
  const x = toNumber(a)
  const y = toNumber(b)
  if (!Number.isNaN(x) && !Number.isNaN(y)) return x === y
  return false
}

function requireString(node: GraphNode, field: string): string {
  const v = node.data[field]
  if (typeof v !== 'string' || v.trim() === '') {
    throw new PipelineError(`${node.type} node '${node.id}' requires a string '${field}'`)
  }
  return v
}

// ─── Node implementations ────────────────────────────────────────────

async function execSource(node: GraphNode, ctx: ExecContext): Promise<Row[]> {
  const datasetId = requireString(node, 'datasetId')
  const dataset = await db.dataset.findUnique({
    where: { id: datasetId },
    select: { id: true, name: true },
  })
  if (!dataset) throw new PipelineError(`Source dataset '${datasetId}' not found`)

  // Phase 1: a replay pins the EXACT version this node must read. P2: a normal
  // run on a GATED dataset reads the last PUBLISHED version (consumers never
  // see drafts); ungated datasets read the head.
  const override = ctx.inputOverrides[datasetId]
  let consumer: Awaited<ReturnType<typeof resolveConsumerVersion>> | null = null
  if (override == null) {
    consumer = await resolveConsumerVersion(datasetId)
  }
  const version = await db.datasetVersion.findFirst({
    where: {
      datasetId,
      ...(override != null
        ? { versionNumber: override }
        : consumer?.versionNumber != null
          ? { versionNumber: consumer.versionNumber }
          : {}),
    },
    orderBy: { versionNumber: 'desc' },
  })
  if (!version) {
    if (override != null) {
      throw new PipelineError(
        `Replay pinned dataset '${dataset.name}' at v${override}, but that version no longer exists (removed by retention or workspace reset)`,
      )
    }
    ctx.capture.inputs.push({ datasetId, datasetName: dataset.name, versionNumber: null, rowCount: 0 })
    ctx.log('warn', `source (${node.id}): dataset '${dataset.name}' has no versions — 0 rows loaded`)
    return []
  }
  const rows = parseJsonSafe<Row[]>(version.dataJson, [])
  ctx.capture.inputs.push({
    datasetId,
    datasetName: dataset.name,
    versionNumber: version.versionNumber,
    rowCount: rows.length,
  })
  const readingPublished = consumer?.gated === true && override == null
  ctx.log(
    'info',
    `source (${node.id}): loaded dataset '${dataset.name}' v${version.versionNumber}${
      override != null ? ' (pinned by replay)' : readingPublished ? ' (last published)' : ''
    } (${rows.length} rows)`,
  )
  return rows
}

function execFilter(node: GraphNode, rows: Row[]): Row[] {
  const column = requireString(node, 'column')
  const operator = requireString(node, 'operator')
  const value = node.data.value
  return rows.filter((row) => matchFilter(row[column], operator, value))
}

function matchFilter(cell: unknown, operator: string, value: unknown): boolean {
  switch (operator) {
    case 'eq': return numericEquals(cell, value)
    case 'neq': return !numericEquals(cell, value)
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const x = toNumber(cell)
      const y = toNumber(value)
      const cmp = !Number.isNaN(x) && !Number.isNaN(y)
        ? x < y ? -1 : x > y ? 1 : 0
        : compareValues(cell, value)
      switch (operator) {
        case 'gt': return cmp > 0
        case 'gte': return cmp >= 0
        case 'lt': return cmp < 0
        case 'lte': return cmp <= 0
        default: return false
      }
    }
    case 'contains':
      return String(cell ?? '').toLowerCase().includes(String(value ?? '').toLowerCase())
    default:
      throw new PipelineError(
        `Unknown filter operator '${operator}' (supported: eq, neq, gt, gte, lt, lte, contains)`,
      )
  }
}

function execDerive(node: GraphNode, rows: Row[], ctx: ExecContext): Row[] {
  const newColumn = requireString(node, 'newColumn')
  const expression = requireString(node, 'expression')

  let evaluate: (row: Row) => unknown
  try {
    // Columns are also exposed as bare identifiers via `with` (e.g. `quantity * unitPrice`),
    // while `row.<col>` always works too.
    evaluate = new Function(
      'row',
      `with(Object.assign({}, row)) { return (${expression}) }`,
    ) as (row: Row) => unknown
  } catch (err) {
    throw new PipelineError(
      `derive node '${node.id}': invalid expression — ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  let failed = 0
  const out = rows.map((row) => {
    try {
      const value = evaluate(row)
      return { ...row, [newColumn]: value === undefined ? null : value }
    } catch {
      failed += 1
      return { ...row, [newColumn]: null }
    }
  })
  if (failed > 0) {
    ctx.log('warn', `derive (${node.id}): ${failed} row(s) failed to evaluate '${expression}' — set to null`)
  }
  return out
}

function execSelect(node: GraphNode, rows: Row[]): Row[] {
  const columns = node.data.columns
  if (!Array.isArray(columns) || columns.length === 0 || columns.some((c) => typeof c !== 'string')) {
    throw new PipelineError(`select node '${node.id}' requires a non-empty string array 'columns'`)
  }
  const cols = columns as string[]
  return rows.map((row) => {
    const out: Row = {}
    for (const c of cols) if (c in row) out[c] = row[c]
    return out
  })
}

function execRename(node: GraphNode, rows: Row[]): Row[] {
  const mapping = node.data.mapping
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    throw new PipelineError(`rename node '${node.id}' requires a 'mapping' object of { oldName: newName }`)
  }
  const renames = Object.entries(mapping as Record<string, unknown>).filter(
    ([, v]) => typeof v === 'string' && v !== '',
  ) as [string, string][]
  return rows.map((row) => {
    const out: Row = {}
    for (const [key, value] of Object.entries(row)) {
      const target = renames.find(([old]) => old === key)
      out[target ? target[1] : key] = value
    }
    return out
  })
}

function execJoin(node: GraphNode, inputs: Row[][]): Row[] {
  if (inputs.length !== 2) {
    throw new PipelineError(`join node '${node.id}' requires exactly 2 inputs (found ${inputs.length})`)
  }
  const [left, right] = inputs
  const how = node.data.how ?? 'inner'
  if (how !== 'inner' && how !== 'left') {
    throw new PipelineError(`join node '${node.id}': 'how' must be 'inner' or 'left' (got '${String(how)}')`)
  }
  const leftKey = requireString(node, 'leftKey')
  const rightKey = requireString(node, 'rightKey')

  // Column names of the right side (order-preserving union across right rows)
  const rightCols: string[] = []
  const seenRight = new Set<string>()
  for (const r of right) {
    for (const k of Object.keys(r)) {
      if (!seenRight.has(k)) {
        seenRight.add(k)
        rightCols.push(k)
      }
    }
  }
  const mergedKey = (k: string, leftRow: Row) => (k in leftRow ? `right_${k}` : k)

  const index = new Map<string, Row[]>()
  for (const r of right) {
    const key = keyOf(r[rightKey])
    const bucket = index.get(key)
    if (bucket) bucket.push(r)
    else index.set(key, [r])
  }

  const out: Row[] = []
  for (const l of left) {
    const matches = index.get(keyOf(l[leftKey])) ?? []
    if (matches.length === 0) {
      if (how === 'left') {
        const row: Row = { ...l }
        for (const k of rightCols) row[mergedKey(k, l)] = null
        out.push(row)
      }
      continue
    }
    for (const r of matches) {
      const row: Row = { ...l }
      for (const k of rightCols) row[mergedKey(k, l)] = r[k] ?? null
      out.push(row)
    }
  }
  return out
}

function execAggregate(node: GraphNode, rows: Row[]): Row[] {
  const rawGroupBy = node.data.groupBy
  if (rawGroupBy !== undefined && !Array.isArray(rawGroupBy)) {
    throw new PipelineError(`aggregate node '${node.id}': 'groupBy' must be an array of column names`)
  }
  const groupBy = (rawGroupBy ?? []) as string[]
  const ops = node.data.ops
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new PipelineError(`aggregate node '${node.id}' requires a non-empty 'ops' array`)
  }

  const groups = new Map<string, { first: Row; rows: Row[] }>()
  if (groupBy.length === 0) {
    groups.set('__all__', { first: rows[0] ?? {}, rows })
  } else {
    for (const row of rows) {
      const key = groupBy.map((c) => keyOf(row[c])).join('\u241F')
      const bucket = groups.get(key)
      if (bucket) bucket.rows.push(row)
      else groups.set(key, { first: row, rows: [row] })
    }
  }

  const out: Row[] = []
  for (const { first, rows: groupRows } of groups.values()) {
    const row: Row = {}
    for (const c of groupBy) row[c] = first[c] ?? null
    for (const opSpec of ops) {
      const spec = opSpec as { op?: unknown; column?: unknown; alias?: unknown }
      const kind = typeof spec.op === 'string' ? spec.op : ''
      if (!['sum', 'avg', 'min', 'max', 'count'].includes(kind)) {
        throw new PipelineError(
          `aggregate node '${node.id}': unknown op '${String(spec.op)}' (supported: sum, avg, min, max, count)`,
        )
      }
      const column = typeof spec.column === 'string' ? spec.column : null
      if (kind !== 'count' && !column) {
        throw new PipelineError(`aggregate node '${node.id}': op '${kind}' requires a 'column'`)
      }
      const alias =
        typeof spec.alias === 'string' && spec.alias !== ''
          ? spec.alias
          : kind === 'count'
            ? 'count'
            : `${kind}_${column}`

      if (kind === 'count') {
        row[alias] = column
          ? groupRows.filter((r) => r[column] !== null && r[column] !== undefined).length
          : groupRows.length
        continue
      }

      const nums = groupRows
        .map((r) => toNumber(r[column!]))
        .filter((n) => !Number.isNaN(n))
      if (nums.length === 0) {
        row[alias] = null
      } else {
        switch (kind) {
          case 'sum': row[alias] = roundSmart(nums.reduce((a, b) => a + b, 0)); break
          case 'avg': row[alias] = roundSmart(nums.reduce((a, b) => a + b, 0) / nums.length); break
          case 'min': row[alias] = Math.min(...nums); break
          case 'max': row[alias] = Math.max(...nums); break
        }
      }
    }
    out.push(row)
  }
  return out
}

/** Keep float noise (0.1+0.2 style) out of aggregates. */
function roundSmart(n: number): number {
  if (!Number.isFinite(n)) return n
  return Math.round(n * 1e9) / 1e9
}

function execSort(node: GraphNode, rows: Row[]): Row[] {
  const by = node.data.by
  if (!Array.isArray(by) || by.length === 0) {
    throw new PipelineError(`sort node '${node.id}' requires a non-empty 'by' array of { column, dir }`)
  }
  const keys = by.map((k) => {
    const spec = k as { column?: unknown; dir?: unknown }
    if (typeof spec.column !== 'string') {
      throw new PipelineError(`sort node '${node.id}': each by entry needs a string 'column'`)
    }
    return { column: spec.column, dir: spec.dir === 'desc' ? 'desc' : 'asc' }
  })
  return [...rows].sort((a, b) => {
    for (const { column, dir } of keys) {
      const cmp = compareValues(a[column], b[column])
      if (cmp !== 0) return dir === 'desc' ? -cmp : cmp
    }
    return 0
  })
}

function stableRowKey(row: Row): string {
  const sortedKeys = Object.keys(row).sort()
  const normalized: Row = {}
  for (const k of sortedKeys) normalized[k] = row[k]
  return JSON.stringify(normalized)
}

function execDedupe(node: GraphNode, rows: Row[]): Row[] {
  const rawKeys = node.data.keys
  if (rawKeys !== undefined && !Array.isArray(rawKeys)) {
    throw new PipelineError(`dedupe node '${node.id}': 'keys' must be an array of column names`)
  }
  const keys = (rawKeys ?? []) as string[]
  const seen = new Set<string>()
  const out: Row[] = []
  for (const row of rows) {
    const key =
      keys.length > 0 ? keys.map((k) => keyOf(row[k])).join('\u241F') : stableRowKey(row)
    if (!seen.has(key)) {
      seen.add(key)
      out.push(row)
    }
  }
  return out
}

function execUnion(node: GraphNode, inputs: Row[][]): Row[] {
  if (inputs.length !== 2) {
    throw new PipelineError(`union node '${node.id}' requires exactly 2 inputs (found ${inputs.length})`)
  }
  const [a, b] = inputs
  const columns: string[] = []
  const seen = new Set<string>()
  for (const row of [...a, ...b]) {
    for (const k of Object.keys(row)) {
      if (!seen.has(k)) {
        seen.add(k)
        columns.push(k)
      }
    }
  }
  return [...a, ...b].map((row) => {
    const out: Row = {}
    for (const c of columns) out[c] = c in row ? row[c] : null
    return out
  })
}

function execLimit(node: GraphNode, rows: Row[]): Row[] {
  const n = node.data.n
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
    throw new PipelineError(`limit node '${node.id}' requires a non-negative integer 'n'`)
  }
  return rows.slice(0, n)
}

async function execOutput(node: GraphNode, rows: Row[], ctx: ExecContext): Promise<Row[]> {
  const name = requireString(node, 'name')
  const { dataset, version, truncated } = await createDatasetFromRows({
    name,
    rows,
    createdBy: ctx.runId,
    tags: ['derived'],
  })

  // Capture lineage: every distinct dataset referenced by a source node (which
  // includes the upstream datasets of any join/union second input) -> output.
  for (const fromDatasetId of ctx.sourceDatasetIds) {
    await db.lineageEdge.upsert({
      where: {
        fromDatasetId_toDatasetId_pipelineId: {
          fromDatasetId,
          toDatasetId: dataset.id,
          pipelineId: ctx.pipelineId,
        },
      },
      update: {},
      create: { fromDatasetId, toDatasetId: dataset.id, pipelineId: ctx.pipelineId },
    })
  }
  if (ctx.sourceDatasetIds.length > 0) {
    ctx.log('info', `lineage: captured ${ctx.sourceDatasetIds.length} edge(s) into dataset '${name}'`)
  }

  // P2 trust workflow: version-level lineage — WHICH input versions produced
  // this output version. Deduped per input dataset (a dataset read by two
  // source nodes contributes one edge with the version it was read at).
  if (ctx.capture.inputs.length > 0) {
    const seenInputs = new Set<string>()
    const versionEdges = ctx.capture.inputs.filter((i) => {
      if (i.versionNumber == null || seenInputs.has(i.datasetId)) return false
      seenInputs.add(i.datasetId)
      return true
    })
    if (versionEdges.length > 0) {
      await db.versionLineageEdge
        .createMany({
          data: versionEdges.map((i) => ({
            runId: ctx.runId,
            pipelineId: ctx.pipelineId,
            fromDatasetId: i.datasetId,
            fromVersionNumber: i.versionNumber as number,
            toDatasetId: dataset.id,
            toVersionNumber: version.versionNumber,
          })),
        })
        .catch(() => undefined) // lineage is additive telemetry — never fail the run
      ctx.log('info', `lineage: recorded ${versionEdges.length} version-level edge(s) feeding '${name}' v${version.versionNumber}`)
    }
  }
  if (truncated) {
    ctx.log('warn', `output (${node.id}): result truncated to 5000 rows`)
  }
  ctx.log('info', `output (${node.id}): wrote ${version.rowCount} rows to dataset '${name}' v${version.versionNumber}`)

  // R14: announce the new output version — upstream-triggered pipelines listen
  // here (trigger-engine guards against a pipeline re-triggering itself).
  await emitVersionCreated({
    datasetId: dataset.id,
    versionNumber: version.versionNumber,
    source: `pipeline:${ctx.pipelineName}`,
  })

  ctx.outputResult.value = {
    outputDatasetId: dataset.id,
    outputName: name,
    outputVersionNumber: version.versionNumber,
    outputRowCount: version.rowCount,
  }
  // Phase 1: record the written output version in the run manifest.
  ctx.capture.outputs.push({
    datasetId: dataset.id,
    datasetName: name,
    versionNumber: version.versionNumber,
    rowCount: version.rowCount,
  })
  return rows
}
