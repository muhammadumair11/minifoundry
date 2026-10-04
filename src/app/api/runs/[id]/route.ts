// GET /api/runs/[id] — single run with its PARSED build manifest (Phase 1:
// reproducible builds). The manifest pins the graph version, the exact input
// dataset versions read, the outputs written, and per-node fingerprints
// (sha256 of inline derive code) — the record that explains AND replays the run.
// Governance: viewer+ (read-only).

import { db } from '@/lib/db'
import { jsonOk, notFound, parseJsonSafe, serializeRun, serverError } from '@/lib/api-utils'
import { requireRole } from '@/lib/governance'
import type { RunManifest } from '@/lib/engine'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const denied = requireRole(req, 'viewer')
    if (denied) return denied

    const { id } = await params
    const run = await db.pipelineRun.findUnique({
      where: { id },
      include: { pipeline: { select: { name: true } } },
    })
    if (!run) return notFound(`Run '${id}' not found`)

    // Legacy runs (pre-Phase 1) have no manifestJson → manifest is null and the
    // UI explains that the run cannot be replayed from recorded inputs.
    const manifest = run.manifestJson
      ? parseJsonSafe<RunManifest | null>(run.manifestJson, null)
      : null

    return jsonOk({
      run: {
        ...serializeRun(run),
        pipelineName: run.pipeline.name,
        manifest,
      },
    })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load run')
  }
}
