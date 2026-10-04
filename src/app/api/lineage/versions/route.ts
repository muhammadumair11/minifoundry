// GET /api/lineage/versions?datasetId=X&versionNumber=N — P2 version-level
// lineage. Returns the exact input versions that produced X vN (upstream) and
// the output versions X vN fed into (downstream), joined with dataset /
// pipeline / run display info for the trust workflow UI.

import type { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { badRequest, jsonOk, serverError } from '@/lib/api-utils'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const datasetId = url.searchParams.get('datasetId')
    const versionParam = url.searchParams.get('versionNumber')
    if (!datasetId) return badRequest('datasetId query parameter is required')
    const versionNumber = Number(versionParam)
    if (!Number.isInteger(versionNumber) || versionNumber <= 0) {
      return badRequest('versionNumber must be a positive integer')
    }

    const [dataset, upstream, downstream] = await Promise.all([
      db.dataset.findUnique({
        where: { id: datasetId },
        select: { id: true, name: true },
      }),
      db.versionLineageEdge.findMany({
        where: { toDatasetId: datasetId, toVersionNumber: versionNumber },
        orderBy: { createdAt: 'asc' },
        take: 50,
      }),
      db.versionLineageEdge.findMany({
        where: { fromDatasetId: datasetId, fromVersionNumber: versionNumber },
        orderBy: { createdAt: 'asc' },
        take: 50,
      }),
    ])
    if (!dataset) return badRequest(`Dataset '${datasetId}' not found`)

    // Join display info for every referenced dataset / pipeline / run.
    const datasetIds = [
      ...new Set([
        ...upstream.map((e) => e.fromDatasetId),
        ...downstream.map((e) => e.toDatasetId),
        datasetId,
      ]),
    ]
    const pipelineIds = [
      ...new Set(
        [...upstream, ...downstream]
          .flatMap((e) => [e.pipelineId])
          .filter((v): v is string => v != null),
      ),
    ]
    const runIds = [
      ...new Set(
        [...upstream, ...downstream].flatMap((e) => [e.runId]).filter((v): v is string => v != null),
      ),
    ]
    const [datasets, pipelines, runs] = await Promise.all([
      db.dataset.findMany({
        where: { id: { in: datasetIds } },
        select: { id: true, name: true },
      }),
      pipelineIds.length > 0
        ? db.pipeline.findMany({ where: { id: { in: pipelineIds } }, select: { id: true, name: true } })
        : Promise.resolve([] as { id: string; name: string }[]),
      runIds.length > 0
        ? db.pipelineRun.findMany({
            where: { id: { in: runIds } },
            select: { id: true, trigger: true, status: true, startedAt: true },
          })
        : Promise.resolve([] as { id: string; trigger: string; status: string; startedAt: Date }[]),
    ])
    const names = new Map(datasets.map((d) => [d.id, d.name]))
    const pipelineNames = new Map(pipelines.map((p) => [p.id, p.name]))
    const runsById = new Map(runs.map((r) => [r.id, r]))

    const shape = (e: (typeof upstream)[number], direction: 'up' | 'down') => ({
      fromDatasetId: e.fromDatasetId,
      fromDatasetName: names.get(e.fromDatasetId) ?? '(unknown)',
      fromVersionNumber: e.fromVersionNumber,
      toDatasetId: e.toDatasetId,
      toDatasetName: names.get(e.toDatasetId) ?? '(unknown)',
      toVersionNumber: e.toVersionNumber,
      runId: e.runId,
      runTrigger: e.runId ? (runsById.get(e.runId)?.trigger ?? null) : null,
      runStatus: e.runId ? (runsById.get(e.runId)?.status ?? null) : null,
      startedAt: e.runId ? (runsById.get(e.runId)?.startedAt ?? null) : null,
      pipelineId: e.pipelineId,
      pipelineName: e.pipelineId ? (pipelineNames.get(e.pipelineId) ?? null) : null,
      direction,
    })

    return jsonOk({
      datasetId,
      datasetName: dataset.name,
      versionNumber,
      upstream: upstream.map((e) => shape(e, 'up')),
      downstream: downstream.map((e) => shape(e, 'down')),
    })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load version lineage')
  }
}
