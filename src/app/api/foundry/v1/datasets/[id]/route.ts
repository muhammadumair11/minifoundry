// GET /api/foundry/v1/datasets/[id]?version= — dataset detail for the public
// API. `version` selects a specific version (default = latest); the schema is
// masked via maskSchema (additive markedWith annotation, same as the session
// detail route). 404 for unknown dataset id and unknown version number.

import { db } from '@/lib/db'
import { badRequest, jsonOk, notFound, parseJsonSafe, parseSchema, serverError } from '@/lib/api-utils'
import { getDatasetVersion, resolveConsumerVersion } from '@/lib/dataset-service'
import { maskSchema } from '@/lib/governance'
import { withApiToken } from '@/lib/api-v1'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    return await withApiToken(req, async () => {
      const { id } = await params
      const dataset = await db.dataset.findUnique({ where: { id } })
      if (!dataset) return notFound(`Dataset '${id}' not found`)

      const url = new URL(req.url)
      let versionNumber: number | undefined
      const versionParam = url.searchParams.get('version')
      if (versionParam !== null && versionParam !== '') {
        const n = Number(versionParam)
        if (!Number.isInteger(n) || n < 1) {
          return badRequest(`Invalid 'version' parameter: '${versionParam}'`)
        }
        versionNumber = n
      }
      // P2: the public API is a consumer — gated datasets default to the last
      // published version (an explicit ?version= still wins).
      if (versionNumber === undefined) {
        const consumer = await resolveConsumerVersion(id)
        versionNumber = consumer?.versionNumber ?? undefined
      }
      const version = await getDatasetVersion(id, versionNumber)
      if (!version) {
        return notFound(
          versionNumber !== undefined
            ? `Version ${versionNumber} not found for dataset '${dataset.name}'`
            : `Dataset '${dataset.name}' has no versions`,
        )
      }

      const versions = await db.datasetVersion.findMany({
        where: { datasetId: id },
        orderBy: { versionNumber: 'desc' },
        select: { versionNumber: true, rowCount: true, createdAt: true },
      })

      return jsonOk({
        dataset: {
          id: dataset.id,
          name: dataset.name,
          description: dataset.description,
          tags: parseJsonSafe<string[]>(dataset.tags, []),
          projectId: dataset.projectId,
          keepLastN: dataset.keepLastN,
          version: {
            versionNumber: version.versionNumber,
            schema: await maskSchema(parseSchema(version), id),
            rowCount: version.rowCount,
            createdAt: version.createdAt,
          },
        },
        versions: versions.map((v) => ({
          versionNumber: v.versionNumber,
          rowCount: v.rowCount,
          createdAt: v.createdAt,
        })),
      })
    })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load dataset')
  }
}
