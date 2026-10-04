// POST /api/datasets/[id]/prune — manual M2 retention pruning.
// Body { keepLastN? } defaults to the dataset's stored keepLastN window
// (0 = unlimited -> no pruning). Requires editor+ role; audited.

import { z } from 'zod'
import { db } from '@/lib/db'
import { badRequest, jsonOk, notFound, serverError, zodErrorMessage } from '@/lib/api-utils'
import { pruneDatasetVersions } from '@/lib/dataset-service'
import { audit, requireRole } from '@/lib/governance'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

const pruneSchema = z.object({
  keepLastN: z.number().int().min(0).max(1000).optional(),
})

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const denied = requireRole(req, 'editor')
    if (denied) return denied

    const { id } = await params
    const dataset = await db.dataset.findUnique({ where: { id } })
    if (!dataset) return notFound(`Dataset '${id}' not found`)

    let body: unknown = {}
    try {
      const text = await req.text()
      if (text.trim() !== '') body = JSON.parse(text)
    } catch {
      return badRequest('Request body must be valid JSON')
    }
    const parsed = pruneSchema.safeParse(body)
    if (!parsed.success) return badRequest(zodErrorMessage(parsed))

    const keepLastN = parsed.data.keepLastN ?? dataset.keepLastN
    const pruned = await pruneDatasetVersions(id, keepLastN)
    const remaining = await db.datasetVersion.count({ where: { datasetId: id } })

    audit({
      req,
      action: 'dataset.prune',
      resourceType: 'dataset',
      resourceId: dataset.id,
      resourceName: dataset.name,
      detail: `keepLastN=${keepLastN} pruned=${pruned}`,
    })

    return jsonOk({ pruned, remaining })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to prune dataset versions')
  }
}
