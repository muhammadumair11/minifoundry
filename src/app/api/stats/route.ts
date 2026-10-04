// GET /api/stats — platform overview counters + recent activity (per API contract).

import { db } from '@/lib/db'
import { jsonOk, serverError } from '@/lib/api-utils'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const [projects, datasets, pipelines, runs, successRuns, failedRuns] = await Promise.all([
      db.project.count(),
      db.dataset.count(),
      db.pipeline.count(),
      db.pipelineRun.count(),
      db.pipelineRun.count({ where: { status: 'success' } }),
      db.pipelineRun.count({ where: { status: 'failed' } }),
    ])

    const datasetsWithCurrent = await db.dataset.findMany({
      select: { versions: { orderBy: { versionNumber: 'desc' }, take: 1, select: { rowCount: true } } },
    })
    const totalRows = datasetsWithCurrent.reduce((n, d) => n + (d.versions[0]?.rowCount ?? 0), 0)

    const [recentRuns, recentDatasets] = await Promise.all([
      db.pipelineRun.findMany({
        orderBy: { startedAt: 'desc' },
        take: 5,
        include: { pipeline: { select: { name: true } } },
      }),
      db.dataset.findMany({
        orderBy: { updatedAt: 'desc' },
        take: 5,
        include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1, select: { rowCount: true } } },
      }),
    ])

    return jsonOk({
      projects,
      datasets,
      pipelines,
      runs,
      successRuns,
      failedRuns,
      totalRows,
      recentRuns: recentRuns.map((r) => ({
        id: r.id,
        pipelineName: r.pipeline.name,
        status: r.status,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
      })),
      recentDatasets: recentDatasets.map((d) => ({
        id: d.id,
        name: d.name,
        rowCount: d.versions[0]?.rowCount ?? 0,
        updatedAt: d.updatedAt,
      })),
    })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load stats')
  }
}
