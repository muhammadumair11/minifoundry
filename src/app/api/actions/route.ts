// GET /api/actions — all action types with their object type + param count.

import { db } from '@/lib/db'
import { jsonOk, parseJsonSafe, serverError } from '@/lib/api-utils'
import type { ActionParamDef } from '@/lib/ontology-service'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const actions = await db.actionType.findMany({
      orderBy: [{ createdAt: 'asc' }, { apiName: 'asc' }],
      include: { objectType: { select: { id: true, apiName: true, displayName: true } } },
    })
    return jsonOk({
      actions: actions.map((a) => ({
        id: a.id,
        apiName: a.apiName,
        displayName: a.displayName,
        description: a.description,
        operation: a.operation,
        enabled: a.enabled,
        objectTypeId: a.objectTypeId,
        objectTypeApiName: a.objectType.apiName,
        objectTypeDisplayName: a.objectType.displayName,
        paramCount: parseJsonSafe<ActionParamDef[]>(a.parametersJson, []).length,
      })),
    })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load actions')
  }
}
