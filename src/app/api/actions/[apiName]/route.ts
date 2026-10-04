// GET /api/actions/[apiName] — single action type with parsed parameters.
// `[apiName]` accepts the action apiName OR its id.

import { db } from '@/lib/db'
import { jsonOk, notFound, parseJsonSafe, serverError } from '@/lib/api-utils'
import type { ActionParamDef } from '@/lib/ontology-service'

export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: { params: Promise<{ apiName: string }> }) {
  try {
    const { apiName } = await params
    const include = { objectType: { select: { id: true, apiName: true, displayName: true, primaryKey: true, icon: true, color: true } } }
    const action =
      (await db.actionType.findUnique({ where: { apiName }, include })) ??
      (await db.actionType.findUnique({ where: { id: apiName }, include }))
    if (!action) return notFound(`Action '${apiName}' not found`)

    return jsonOk({
      action: {
        id: action.id,
        apiName: action.apiName,
        displayName: action.displayName,
        description: action.description,
        operation: action.operation,
        enabled: action.enabled,
        parameters: parseJsonSafe<ActionParamDef[]>(action.parametersJson, []),
        objectType: {
          id: action.objectType.id,
          apiName: action.objectType.apiName,
          displayName: action.objectType.displayName,
          primaryKey: action.objectType.primaryKey,
          icon: action.objectType.icon,
          color: action.objectType.color,
        },
      },
    })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load action')
  }
}
