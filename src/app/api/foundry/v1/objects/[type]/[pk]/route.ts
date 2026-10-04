// GET /api/foundry/v1/objects/[type]/[pk] — single object instance over the
// public API. The row is located by pk on the RAW data (loose string/number
// match, same as the session route) and masked for the VIEWER role afterwards,
// so a marked pk can be resolved but its value never leaves unmasked.

import { badRequest, jsonOk, notFound, parseJsonSafe, serverError } from '@/lib/api-utils'
import { getDatasetVersion, resolveConsumerVersion, type Row } from '@/lib/dataset-service'
import { findObjectType, looseEqual } from '@/lib/ontology-service'
import { applyMasking } from '@/lib/governance'
import { withApiToken } from '@/lib/api-v1'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ type: string; pk: string }> },
) {
  try {
    return await withApiToken(req, async () => {
      const { type, pk } = await params

      const objectType = await findObjectType(type)
      if (!objectType) return notFound(`Object type '${type}' not found`)
      if (!objectType.primaryKey) {
        return badRequest(`Object type '${objectType.apiName}' has no primary key configured`)
      }
      if (!objectType.sourceDatasetId) {
        return notFound(`Object type '${objectType.apiName}' has no backing dataset`)
      }

      const consumer = await resolveConsumerVersion(objectType.sourceDatasetId)
      const version = consumer?.versionNumber == null
        ? null
        : await getDatasetVersion(objectType.sourceDatasetId, consumer.versionNumber)
      if (!version) {
        return notFound(`Dataset for object type '${objectType.apiName}' has no versions`)
      }

      const rows = parseJsonSafe<Row[]>(version.dataJson, [])
      const row = rows.find((r) => looseEqual(r[objectType.primaryKey as string], pk))
      if (!row) {
        return notFound(`Object '${pk}' not found in type '${objectType.apiName}'`)
      }

      const { rows: [maskedRow], maskedColumns } = await applyMasking(
        objectType.sourceDatasetId,
        [row],
        'viewer',
      )

      return jsonOk({
        object: { pk: maskedRow?.[objectType.primaryKey] ?? null, values: maskedRow, _masked: maskedColumns },
      })
    })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load object')
  }
}
