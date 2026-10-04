// MiniFoundry — shared API helpers: response shortcuts, zod error formatting,
// and JSON-boundary serializers (JSON fields are stored as strings in SQLite).

import { NextResponse } from 'next/server'
import type {
  Connector,
  Dataset,
  DatasetVersion,
  Ingestion,
  PipelineRun,
  Schedule,
} from '@prisma/client'
import type { SchemaColumn } from '@/lib/dataset-service'

export type LogEntry = { ts: string; level: 'info' | 'warn' | 'error' | 'success'; msg: string }

export function jsonOk<T>(data: T, status = 200) {
  return NextResponse.json(data, { status })
}

export function jsonError(status: number, error: string, detail?: unknown) {
  return NextResponse.json({ error, ...(detail !== undefined ? { detail } : {}) }, { status })
}

export const badRequest = (error: string, detail?: unknown) => jsonError(400, error, detail)
export const notFound = (error: string) => jsonError(404, error)
export const serverError = (error = 'Internal server error') => jsonError(500, error)

/** Human-readable message from a zod SafeParseError. */
export function zodErrorMessage(result: { error: { issues: { path: (string | number | symbol)[]; message: string }[] } }): string {
  return result.error.issues
    .map((i) => `${i.path.length ? i.path.join('.') : 'body'}: ${i.message}`)
    .join('; ')
}

export function parseJsonSafe<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

// ─── Serializers (strip huge dataJson payloads) ──────────────────────

export function parseSchema(version: Pick<DatasetVersion, 'schemaJson'>): SchemaColumn[] {
  return parseJsonSafe<SchemaColumn[]>(version.schemaJson, [])
}

export function serializeVersion(v: DatasetVersion) {
  return {
    id: v.id,
    datasetId: v.datasetId,
    versionNumber: v.versionNumber,
    schema: parseSchema(v),
    rowCount: v.rowCount,
    createdBy: v.createdBy,
    createdAt: v.createdAt,
  }
}

export interface DatasetSummary {
  id: string
  name: string
  description: string | null
  projectId: string | null
  sourceConnectorId: string | null
  tags: string[]
  createdAt: string | Date
  updatedAt: string | Date
  currentVersion: { versionNumber: number; rowCount: number; columnCount: number } | null
  versionsCount: number
}

/** Dataset without versions/data payload; pass versions sorted desc (latest first). */
export function serializeDatasetSummary(
  dataset: Dataset,
  versions?: Array<Pick<DatasetVersion, 'versionNumber' | 'rowCount' | 'schemaJson'>>,
): DatasetSummary {
  const vs = versions ?? []
  const current = vs[0]
  return {
    id: dataset.id,
    name: dataset.name,
    description: dataset.description,
    projectId: dataset.projectId,
    sourceConnectorId: dataset.sourceConnectorId,
    tags: parseJsonSafe<string[]>(dataset.tags, []),
    createdAt: dataset.createdAt,
    updatedAt: dataset.updatedAt,
    currentVersion: current
      ? {
          versionNumber: current.versionNumber,
          rowCount: current.rowCount,
          columnCount: parseSchema(current).length,
        }
      : null,
    versionsCount: vs.length,
  }
}

export function serializeRun(run: PipelineRun) {
  return {
    id: run.id,
    pipelineId: run.pipelineId,
    status: run.status,
    // M3.1: pipeline version this run executed (null for pre-versioning runs).
    versionNumber: run.versionNumber,
    // R14 (additive): what caused the run + 1-based attempt number.
    trigger: run.trigger,
    attempt: run.attempt,
    // Phase 1 (reproducible builds, additive): build-record fields. durationMs
    // prefers the recorded column and falls back to timestamp math for legacy rows.
    durationMs: run.durationMs ?? (run.finishedAt ? run.finishedAt.getTime() - run.startedAt.getTime() : null),
    failureCause: run.failureCause,
    outputDatasetId: run.outputDatasetId,
    outputVersionNumber: run.outputVersionNumber,
    replayedFromRunId: run.replayedFromRunId,
    logs: parseJsonSafe<LogEntry[]>(run.logsJson, []),
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  }
}

/** Schedule with the owning pipeline's name; pass a schedule included with pipeline { name }. */
export function serializeSchedule(
  schedule: Schedule & { pipeline?: { name: string } | null },
) {
  return {
    id: schedule.id,
    pipelineId: schedule.pipelineId,
    pipelineName: schedule.pipeline?.name ?? null,
    name: schedule.name,
    enabled: schedule.enabled,
    intervalMinutes: schedule.intervalMinutes,
    lastRunAt: schedule.lastRunAt,
    nextRunAt: schedule.nextRunAt,
  }
}

export function serializeConnector(connector: Connector, lastIngestion?: Ingestion | null) {
  return {
    id: connector.id,
    name: connector.name,
    type: connector.type,
    config: parseJsonSafe<Record<string, unknown>>(connector.config, {}),
    createdAt: connector.createdAt,
    updatedAt: connector.updatedAt,
    lastIngestion: lastIngestion
      ? {
          id: lastIngestion.id,
          status: lastIngestion.status,
          finishedAt: lastIngestion.finishedAt,
          rowsIngested: lastIngestion.rowsIngested,
        }
      : null,
  }
}
