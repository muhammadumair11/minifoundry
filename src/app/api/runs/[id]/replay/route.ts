// POST /api/runs/[id]/replay — re-execute a PAST run from its recorded build
// manifest (Phase 1: reproducible builds). The replay pins:
//   • the SAME pipeline version graph the original run executed, and
//   • the SAME input dataset versions the original run read (manifest inputs),
// so the run can be explained and reproduced even after newer dataset versions
// exist. Outputs are ALWAYS new immutable versions (never overwritten).
// Governance: editor+ role; audited as pipeline.run with a replay detail.
// Returns 200 with the NEW run even when the replay fails (consistent with the
// manual-run route), so the UI can render the new run's logs/manifest.

import { db } from '@/lib/db'
import {
  badRequest,
  jsonOk,
  notFound,
  parseJsonSafe,
  serializeRun,
  serverError,
} from '@/lib/api-utils'
import { runPipeline } from '@/lib/engine'
import type { RunManifest } from '@/lib/engine'
import { audit, requireRole } from '@/lib/governance'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const denied = requireRole(req, 'editor')
    if (denied) return denied

    const { id } = await params
    const run = await db.pipelineRun.findUnique({
      where: { id },
      select: {
        id: true,
        pipelineId: true,
        versionNumber: true,
        manifestJson: true,
        pipeline: { select: { id: true, name: true } },
      },
    })
    if (!run) return notFound(`Run '${id}' not found`)

    // A replay needs the recorded manifest — legacy (pre-Phase 1) runs do not
    // have one. Fail explicitly: silently replaying "latest of everything"
    // would break the reproducibility contract this route exists to teach.
    if (!run.manifestJson) {
      return badRequest(
        'This run has no recorded build manifest (it predates reproducible builds) — it cannot be replayed from recorded inputs. Run the pipeline normally instead.',
      )
    }
    const manifest = parseJsonSafe<RunManifest | null>(run.manifestJson, null)
    if (!manifest) return badRequest('Run manifest is unreadable — cannot replay')

    // The replay re-executes the SAME graph snapshot the original run used.
    const graphVersion = await db.pipelineVersion.findUnique({
      where: {
        pipelineId_versionNumber: {
          pipelineId: run.pipelineId,
          versionNumber: run.versionNumber ?? 1,
        },
      },
      select: { graphJson: true, versionNumber: true },
    })
    if (!graphVersion) {
      return badRequest(
        `Pinned pipeline version v${run.versionNumber ?? '?'} no longer exists — the recorded graph is gone and the run cannot be replayed faithfully`,
      )
    }

    // Pin every recorded input version. Datasets/versions deleted since the
    // original run produce a clean failed replay run (the engine's source node
    // reports the missing pin) instead of a silent fallback to latest.
    const inputOverrides: Record<string, number> = {}
    for (const input of manifest.inputs) {
      if (input.versionNumber != null) {
        inputOverrides[input.datasetId] = input.versionNumber
      }
    }

    const replayRun = await runPipeline(run.pipelineId, {
      graphOverride: graphVersion.graphJson,
      versionNumber: graphVersion.versionNumber,
      inputOverrides,
      replayOfRunId: run.id,
      trigger: 'replay',
      attempt: 1,
    })

    audit({
      req,
      action: 'pipeline.run',
      resourceType: 'pipeline',
      resourceId: run.pipeline.id,
      resourceName: run.pipeline.name,
      detail: `replay of run ${id} (pinned inputs: ${
        Object.entries(inputOverrides)
          .map(([dsId, v]) => `${dsId.slice(-6)}@v${v}`)
          .join(', ') || 'none'
      })`,
    })

    return jsonOk({ run: serializeRun(replayRun) })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to replay run')
  }
}
