// GET /api/actions/logs?limit=50 — latest action log entries, newest first.
// Static segment NEXT TO [apiName] — App Router resolves static routes first
// (same pattern as schedules/due).

import { db } from '@/lib/db'
import { jsonOk, parseJsonSafe, serverError } from '@/lib/api-utils'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const limit = Math.min(200, Math.max(1, Math.floor(Number(url.searchParams.get('limit') ?? '50')) || 50))

    const logs = await db.actionLog.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      include: {
        actionType: {
          select: {
            apiName: true,
            displayName: true,
            objectType: { select: { displayName: true } },
          },
        },
      },
    })

    return jsonOk({
      logs: logs.map((l) => ({
        id: l.id,
        actionApiName: l.actionType.apiName,
        actionDisplayName: l.actionType.displayName,
        objectTypeDisplayName: l.actionType.objectType.displayName,
        result: l.result,
        message: l.message,
        objectPk: l.objectPk,
        versionNumber: l.versionNumber,
        params: parseJsonSafe<Record<string, unknown>>(l.paramsJson, {}),
        createdAt: l.createdAt,
      })),
    })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load action logs')
  }
}
