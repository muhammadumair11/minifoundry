// MiniFoundry — M3.1 pipeline versioning service.
// Every graph save snapshots an immutable PipelineVersion; every run pins the
// version it executed. Pruning mirrors the dataset-service keepLastN pattern.

import { z } from 'zod'
import { db } from '@/lib/db'
import { zodErrorMessage } from '@/lib/api-utils'
import type { PipelineVersion } from '@prisma/client'

/** Pipeline versions retained per pipeline (versions beyond this are pruned, newest kept). */
export const KEEP_LAST_N = 20

// Same shape the pipeline save routes zod-validate today (graph { nodes, edges }).
const versionGraphSchema = z.object({
  nodes: z.array(z.record(z.string(), z.unknown())),
  edges: z.array(z.record(z.string(), z.unknown())),
})

export interface SnapshotOptions {
  note?: string | null
  createdBy?: string | null
}

/**
 * Validate graphJson parses as { nodes, edges } (same zod shape the save route
 * enforces) and return its node count. Throws a user-facing Error otherwise —
 * snapshots must never store an unrunnable graph.
 */
export function assertValidGraphJson(graphJson: string): number {
  let parsed: unknown
  try {
    parsed = JSON.parse(graphJson)
  } catch {
    throw new Error('Pipeline graph is not valid JSON')
  }
  const result = versionGraphSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(`Pipeline graph invalid — ${zodErrorMessage(result)}`)
  }
  return result.data.nodes.length
}

/** Newest version of a pipeline, or null when none exist yet. */
async function latestVersion(pipelineId: string): Promise<PipelineVersion | null> {
  return db.pipelineVersion.findFirst({
    where: { pipelineId },
    orderBy: { versionNumber: 'desc' },
  })
}

/** Version number of the newest version, or null when the pipeline has none. */
export async function latestVersionNumber(pipelineId: string): Promise<number | null> {
  const v = await db.pipelineVersion.findFirst({
    where: { pipelineId },
    orderBy: { versionNumber: 'desc' },
    select: { versionNumber: true },
  })
  return v?.versionNumber ?? null
}

/**
 * Lazily backfill: when the pipeline has zero versions, snapshot its CURRENT
 * graphJson as v1 (createdBy 'backfill') so the pre-versioning graph enters the
 * history before any new save/run. Cheap after the first call (single findFirst).
 * Returns the LATEST version. Throws when the pipeline does not exist.
 */
export async function ensurePipelineVersion(pipelineId: string): Promise<PipelineVersion> {
  const latest = await latestVersion(pipelineId)
  if (latest) return latest

  const pipeline = await db.pipeline.findUnique({
    where: { id: pipelineId },
    select: { graphJson: true },
  })
  if (!pipeline) throw new Error(`Pipeline '${pipelineId}' not found`)
  return snapshotPipelineVersion(pipelineId, pipeline.graphJson, { createdBy: 'backfill' })
}

/**
 * Snapshot a graph as the next version (max versionNumber + 1), then prune to
 * KEEP_LAST_N (deleteMany of the oldest versions, mirroring pruneDatasetVersions).
 * Throws when graphJson is not a valid { nodes, edges } graph.
 */
export async function snapshotPipelineVersion(
  pipelineId: string,
  graphJson: string,
  opts: SnapshotOptions = {},
): Promise<PipelineVersion> {
  const nodeCount = assertValidGraphJson(graphJson)
  const prev = await latestVersion(pipelineId)
  const version = await db.pipelineVersion.create({
    data: {
      pipelineId,
      versionNumber: (prev?.versionNumber ?? 0) + 1,
      graphJson,
      nodeCount,
      note: opts.note ?? null,
      createdBy: opts.createdBy ?? null,
    },
  })
  await prunePipelineVersions(pipelineId, KEEP_LAST_N)
  return version
}

/** One specific snapshot, or null when the pipeline/version combination is unknown. */
export async function getPipelineVersion(
  pipelineId: string,
  versionNumber: number,
): Promise<PipelineVersion | null> {
  return db.pipelineVersion.findUnique({
    where: { pipelineId_versionNumber: { pipelineId, versionNumber } },
  })
}

/**
 * M3.1 retention: keep only the newest `keepLastN` versions of a pipeline.
 * keepLastN <= 0 means unlimited (no pruning). Excess versions are the ones
 * with the LOWEST versionNumbers. Returns the number of deleted versions.
 */
export async function prunePipelineVersions(
  pipelineId: string,
  keepLastN: number = KEEP_LAST_N,
): Promise<number> {
  if (keepLastN <= 0) return 0
  const versions = await db.pipelineVersion.findMany({
    where: { pipelineId },
    orderBy: { versionNumber: 'desc' },
    select: { id: true },
  })
  if (versions.length <= keepLastN) return 0
  const excessIds = versions.slice(keepLastN).map((v) => v.id)
  const result = await db.pipelineVersion.deleteMany({ where: { id: { in: excessIds } } })
  return result.count
}
