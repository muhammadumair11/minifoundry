// GET /api/foundry/v1/ontology — semantic layer over the public API.
// Reuses the session-authed /api/ontology serialization (OBJECT_TYPE_INCLUDE +
// serializeObjectType) and additionally flattens every action into a
// top-level `actions` array tagged with its owner object type.

import { db } from '@/lib/db'
import { jsonOk, serverError } from '@/lib/api-utils'
import { OBJECT_TYPE_INCLUDE, serializeObjectType } from '@/lib/ontology-service'
import { withApiToken } from '@/lib/api-v1'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
    return await withApiToken(req, async () => {
      const objectTypes = await db.objectType.findMany({
        orderBy: { createdAt: 'asc' },
        include: OBJECT_TYPE_INCLUDE,
      })
      const serialized = objectTypes.map(serializeObjectType)
      const actions = serialized.flatMap((ot) =>
        ot.actions.map((a) => ({
          ...a,
          objectType: { id: ot.id, apiName: ot.apiName, displayName: ot.displayName },
        })),
      )
      return jsonOk({ objectTypes: serialized, actions })
    })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load ontology')
  }
}
