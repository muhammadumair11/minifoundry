// POST /api/transforms/[id]/run — synchronous transform execution.
// ALWAYS returns 200 (even when the run failed) with the serialized run plus
// the first 20 output rows and the output schema, so the UI can show the log
// stream regardless of the outcome. Requires editor+ role; audited.

import { db } from '@/lib/db'
import { jsonError, jsonOk, notFound, parseSchema, serverError } from '@/lib/api-utils'
import { isDemoMode } from '@/lib/runtime-mode'
import { audit, requireRole } from '@/lib/governance'
import { runTransform, serializeTransformRun } from '@/lib/transform-engine'
import { getDatasetVersion, type Row } from '@/lib/dataset-service'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

const PREVIEW_ROWS = 20

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const denied = requireRole(req, 'editor')
    if (denied) return denied
    if (!isDemoMode()) return jsonError(403, 'Code transforms require an isolated runner and are disabled in shared mode')

    const { id } = await params
    const transform = await db.transform.findUnique({ where: { id } })
    if (!transform) return notFound(`Transform '${id}' not found`)

    const run = await runTransform(transform, req)

    audit({
      req,
      action: 'transform.run',
      resourceType: 'transform',
      resourceId: transform.id,
      resourceName: transform.name,
      detail: `status=${run.status} rows=${run.rowCount ?? 0}`,
    })

    // Output preview + schema from the published version (empty on failure).
    let preview: Row[] = []
    let schema: ReturnType<typeof parseSchema> = []
    if (run.outputDatasetId && run.outputVersionNumber) {
      const version = await getDatasetVersion(run.outputDatasetId, run.outputVersionNumber)
      if (version) {
        try {
          preview = (JSON.parse(version.dataJson) as Row[]).slice(0, PREVIEW_ROWS)
        } catch {
          preview = []
        }
        schema = parseSchema(version)
      }
    }

    return jsonOk({ run: serializeTransformRun(run), preview, schema })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to run transform')
  }
}
