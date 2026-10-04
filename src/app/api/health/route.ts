// GET /api/health — platform health metrics for the orchestration dashboard.
// Shape (Task 2-a contract):
// {
//   successRatePct,          // all-time success / (success + failed); 100 when none
//   avgDurationMs,           // mean duration over finished runs; null when none
//   runs7d, failed7d,        // runs with startedAt >= now - 7d
//   datasets: [{ id, name, rowCount, updatedAt, freshnessMinutes }],
//   failingPipelines: [{ id, name, failedCount, lastFailureAt }], // top 5, failedCount > 0
// }

import { db } from '@/lib/db'
import { jsonOk, serverError } from '@/lib/api-utils'

export const dynamic = 'force-dynamic'

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

export async function GET() {
  try {
    const now = new Date()
    const weekAgo = new Date(now.getTime() - SEVEN_DAYS_MS)

    const [
      successCount,
      failedCount,
      runs7d,
      failed7d,
      finishedRuns,
      datasets,
      failingGroups,
    ] = await Promise.all([
      db.pipelineRun.count({ where: { status: 'success' } }),
      db.pipelineRun.count({ where: { status: 'failed' } }),
      db.pipelineRun.count({ where: { startedAt: { gte: weekAgo } } }),
      db.pipelineRun.count({ where: { startedAt: { gte: weekAgo }, status: 'failed' } }),
      db.pipelineRun.findMany({
        where: { finishedAt: { not: null } },
        select: { startedAt: true, finishedAt: true },
      }),
      db.dataset.findMany({
        orderBy: { updatedAt: 'desc' },
        select: {
          id: true,
          name: true,
          updatedAt: true,
          versions: { orderBy: { versionNumber: 'desc' }, take: 1, select: { rowCount: true } },
        },
      }),
      db.pipelineRun.groupBy({
        by: ['pipelineId'],
        where: { status: 'failed' },
        _count: { _all: true },
        _max: { finishedAt: true },
        orderBy: { _count: { pipelineId: 'desc' } },
        take: 5,
      }),
    ])

    const finishedTotal = successCount + failedCount
    const successRatePct =
      finishedTotal === 0 ? 100 : Math.round((successCount / finishedTotal) * 1000) / 10

    const durations = finishedRuns.map((r) =>
      r.finishedAt ? r.finishedAt.getTime() - r.startedAt.getTime() : 0,
    )
    const avgDurationMs =
      durations.length === 0
        ? null
        : Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)

    const datasetRows = datasets.map((d) => ({
      id: d.id,
      name: d.name,
      rowCount: d.versions[0]?.rowCount ?? 0,
      updatedAt: d.updatedAt,
      freshnessMinutes: Math.max(0, Math.round((now.getTime() - d.updatedAt.getTime()) / 60_000)),
    }))

    const failingIds = failingGroups.map((g) => g.pipelineId)
    const failingPipelines = failingIds.length
      ? await db.pipeline
          .findMany({ where: { id: { in: failingIds } }, select: { id: true, name: true } })
          .then((rows) => {
            const nameById = new Map(rows.map((p) => [p.id, p.name]))
            return failingGroups.map((g) => ({
              id: g.pipelineId,
              name: nameById.get(g.pipelineId) ?? 'Unknown pipeline',
              failedCount: g._count._all,
              lastFailureAt: g._max.finishedAt,
            }))
          })
      : []

    return jsonOk({
      successRatePct,
      avgDurationMs,
      runs7d,
      failed7d,
      datasets: datasetRows,
      failingPipelines,
    })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load health metrics')
  }
}
