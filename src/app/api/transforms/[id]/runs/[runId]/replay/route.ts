// Replay a workbook from its recorded code and exact input versions.
import type { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { badRequest, jsonError, jsonOk, notFound, parseJsonSafe, serverError } from '@/lib/api-utils'
import { isDemoMode } from '@/lib/runtime-mode'
import { audit, requireRole } from '@/lib/governance'
import { runTransform, serializeTransformRun, type TransformManifest } from '@/lib/transform-engine'

export const dynamic = 'force-dynamic'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; runId: string }> },
) {
  try {
    const denied = requireRole(req, 'editor')
    if (denied) return denied
    if (!isDemoMode()) return jsonError(403, 'Code transforms require an isolated runner and are disabled in shared mode')
    const { id, runId } = await params
    const [transform, prior] = await Promise.all([
      db.transform.findUnique({ where: { id } }),
      db.transformRun.findFirst({ where: { id: runId, transformId: id } }),
    ])
    if (!transform || !prior) return notFound('Transform or run not found')
    const manifest = parseJsonSafe<TransformManifest | null>(prior.manifestJson, null)
    if (!manifest || !Array.isArray(manifest.inputs) || !Array.isArray(manifest.configuredInputs)) {
      return badRequest('This run has no complete replay manifest')
    }
    if (manifest.configuredInputs.some((inputId) => !manifest.inputs.some((input) => input.datasetId === inputId))) {
      return badRequest('The original run skipped an input, so a faithful replay is unavailable')
    }
    const snapshot = {
      ...transform,
      language: manifest.language,
      sourceCode: manifest.sourceCode,
      outputDatasetName: manifest.outputDatasetName,
      inputsJson: JSON.stringify(manifest.configuredInputs),
    }
    const inputOverrides = Object.fromEntries(manifest.inputs.map((input) => [input.datasetId, input.versionNumber]))
    const replay = await runTransform(snapshot, req, { inputOverrides, replayOfRunId: prior.id })
    audit({
      req, action: 'transform.replay', resourceType: 'transform', resourceId: id,
      resourceName: transform.name, detail: `replay of ${prior.id}: ${replay.status}`,
    })
    return jsonOk({ run: serializeTransformRun(replay), replayOfRunId: prior.id })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to replay transform')
  }
}
