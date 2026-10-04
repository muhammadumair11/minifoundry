// MiniFoundry — version provenance resolver.
//
// DatasetVersion.createdBy is an opaque reference to whichever writer produced
// the version: an ingestion id, a pipeline run id, "transform:<runId>",
// "branch-merge:<branch>", "action:<apiName>" or the literal "seed".
//
// resolveProvenance turns that into a human-readable { kind, label, detail,
// href } so the studio History tab can show "Pipeline — Shipment Overview"
// instead of a truncated cuid. Resolution order matters: prefixed forms are
// cheap string checks; bare ids are looked up as a pipeline run FIRST (the
// common case) and then as an ingestion. Unknown ids degrade gracefully.
//
// Dedup: datasets written by schedules often have MANY versions from the same
// run/ingestion, so resolveProvenanceMany resolves unique createdBy values
// once and maps results back.

import { db } from '@/lib/db'
import type { VersionProvenance } from '@/lib/foundry-types'

const TRANSFORM_PREFIX = 'transform:'
const MERGE_PREFIX = 'branch-merge:'
const ACTION_PREFIX = 'action:'

/** Resolve one createdBy reference. Never throws (unknown ids → 'unknown'). */
export async function resolveProvenance(createdBy: string | null): Promise<VersionProvenance> {
  try {
    if (!createdBy) {
      return { kind: 'unknown', label: 'unknown writer', detail: null, href: null }
    }

    if (createdBy === 'seed') {
      return { kind: 'seed', label: 'Sample seed', detail: 'bundled sample pack', href: null }
    }

    if (createdBy.startsWith(TRANSFORM_PREFIX)) {
      const runId = createdBy.slice(TRANSFORM_PREFIX.length)
      const run = await db.transformRun.findUnique({
        where: { id: runId },
        select: { status: true, transform: { select: { id: true, name: true } } },
      })
      if (run) {
        return {
          kind: 'transform',
          label: `Code workbook — ${run.transform.name}`,
          detail: `run ${run.status}`,
          href: `/transforms/${run.transform.id}`,
        }
      }
      return { kind: 'transform', label: 'Code workbook run', detail: null, href: '/transforms' }
    }

    if (createdBy.startsWith(MERGE_PREFIX)) {
      const branch = createdBy.slice(MERGE_PREFIX.length)
      return {
        kind: 'merge',
        label: `Branch merge — ${branch}`,
        detail: 'merged into main',
        href: null,
      }
    }

    if (createdBy.startsWith(ACTION_PREFIX)) {
      const apiName = createdBy.slice(ACTION_PREFIX.length)
      return {
        kind: 'action',
        label: `Action — ${apiName}`,
        detail: 'ontology write-back',
        href: '/ontology',
      }
    }

    // Bare cuid: pipeline run first (most common), then ingestion.
    const run = await db.pipelineRun.findUnique({
      where: { id: createdBy },
      select: { status: true, versionNumber: true, pipeline: { select: { id: true, name: true } } },
    })
    if (run) {
      return {
        kind: 'pipeline',
        label: `Pipeline — ${run.pipeline.name}`,
        detail: `run ${run.status}${run.versionNumber ? ` · v${run.versionNumber} graph` : ''}`,
        href: `/pipelines/${run.pipeline.id}`,
      }
    }

    const ingestion = await db.ingestion.findUnique({
      where: { id: createdBy },
      select: { status: true, rowsIngested: true, connector: { select: { id: true, name: true, type: true } } },
    })
    if (ingestion) {
      return {
        kind: 'ingestion',
        label: `Ingestion — ${ingestion.connector?.name ?? 'external source'}`,
        detail: `${ingestion.status} · ${ingestion.connector?.type ?? 'unknown'} connector`,
        href: ingestion.connector ? '/connectors' : null,
      }
    }

    // Unresolvable id — show it honestly rather than pretending.
    return { kind: 'unknown', label: 'unknown writer', detail: createdBy, href: null }
  } catch {
    return { kind: 'unknown', label: 'unknown writer', detail: createdBy ?? null, href: null }
  }
}

/**
 * Resolve provenance for MANY versions efficiently: unique createdBy values
 * are resolved once (Promise.all) and mapped back positionally.
 */
export async function resolveProvenanceMany(
  createdByList: (string | null)[],
): Promise<VersionProvenance[]> {
  const unique = [...new Set(createdByList.map((c) => c ?? ''))]
  const resolved = await Promise.all(unique.map((c) => resolveProvenance(c || null)))
  const byKey = new Map<string, VersionProvenance>()
  unique.forEach((key, i) => byKey.set(key, resolved[i]))
  return createdByList.map((c) => byKey.get(c ?? '') ?? { kind: 'unknown', label: 'unknown writer', detail: null, href: null })
}
