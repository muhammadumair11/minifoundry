// GET /api/ingestions — latest 50 ingestion runs with connector/dataset names.

import { db } from '@/lib/db'
import { jsonOk, serverError } from '@/lib/api-utils'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const [ingestions, datasets] = await Promise.all([
      db.ingestion.findMany({
        orderBy: { startedAt: 'desc' },
        take: 50,
        include: { connector: { select: { id: true, name: true } } },
      }),
      db.dataset.findMany({ select: { id: true, name: true } }),
    ])

    const datasetNameById = new Map(datasets.map((d) => [d.id, d.name]))

    return jsonOk({
      ingestions: ingestions.map((ing) => ({
        id: ing.id,
        connectorName: ing.connector?.name ?? null,
        datasetName: ing.datasetId ? datasetNameById.get(ing.datasetId) ?? null : null,
        status: ing.status,
        message: ing.message,
        rowsIngested: ing.rowsIngested,
        startedAt: ing.startedAt,
        finishedAt: ing.finishedAt,
      })),
    })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load ingestions')
  }
}
