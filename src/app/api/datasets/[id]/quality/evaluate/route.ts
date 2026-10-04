// POST /api/datasets/[id]/quality/evaluate — run all ENABLED rules against a
// version (default: main head) with trigger 'manual'. Editor+ required.
// Severity 'error' failures raise platform notifications inside the engine.

import { db } from '@/lib/db'
import { jsonError, jsonOk, serverError } from '@/lib/api-utils'
import { audit, requireRole } from '@/lib/governance'
import { QualityError, evaluateRules } from '@/lib/quality'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const denied = requireRole(req, 'editor')
    if (denied) return denied

    const { id } = await params
    const dataset = await db.dataset.findUnique({ where: { id }, select: { id: true, name: true } })
    if (!dataset) return jsonError(404, `Dataset '${id}' not found`)

    // Optional ?version= — otherwise the main head (fallback: newest version).
    const versionParam = new URL(req.url).searchParams.get('version')
    let versionNumber: number | undefined
    if (versionParam !== null && versionParam !== '') {
      const n = Number(versionParam)
      if (!Number.isInteger(n) || n < 1) return jsonError(400, `Invalid 'version' parameter`)
      versionNumber = n
    } else {
      const [mainHead, anyHead] = await Promise.all([
        db.datasetVersion.findFirst({
          where: { datasetId: id, branch: 'main' },
          orderBy: { versionNumber: 'desc' },
          select: { versionNumber: true },
        }),
        db.datasetVersion.findFirst({
          where: { datasetId: id },
          orderBy: { versionNumber: 'desc' },
          select: { versionNumber: true },
        }),
      ])
      versionNumber = (mainHead ?? anyHead)?.versionNumber
    }
    if (versionNumber === undefined) return jsonError(400, 'Dataset has no versions to evaluate')

    try {
      const result = await evaluateRules(id, versionNumber, 'manual')
      audit({
        req,
        action: 'dataset.quality.evaluate',
        resourceType: 'dataset',
        resourceId: id,
        resourceName: dataset.name,
        detail: `v${versionNumber}: ${result.passed} passed / ${result.failed} failed`,
      })
      return jsonOk(result)
    } catch (err) {
      if (err instanceof QualityError) return jsonError(err.status, err.message)
      throw err
    }
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to evaluate quality')
  }
}
