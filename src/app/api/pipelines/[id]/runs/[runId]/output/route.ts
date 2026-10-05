import { db } from '@/lib/db'
import { audit, requireRole } from '@/lib/governance'
import { jsonError, jsonOk, serverError } from '@/lib/api-utils'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string; runId: string }> }

async function assess(id: string, runId: string) {
  const run = await db.pipelineRun.findFirst({ where: { id: runId, pipelineId: id } })
  if (!run) return null
  const datasetId = run.outputDatasetId
  const versionNumber = run.outputVersionNumber
  if (!datasetId || !versionNumber) return { run, state: 'none' as const }
  const [dataset, version] = await Promise.all([
    db.dataset.findUnique({ where: { id: datasetId } }),
    db.datasetVersion.findUnique({ where: { datasetId_versionNumber: { datasetId, versionNumber } } }),
  ])
  if (!dataset || !version) return { run, state: 'removed' as const }

  const reasons: string[] = []
  if (version.createdBy !== run.id) reasons.push('This run is not the recorded writer of the version.')
  if (version.branch !== 'main') reasons.push('Branch versions require branch cleanup.')
  const latest = await db.datasetVersion.findFirst({ where: { datasetId }, orderBy: { versionNumber: 'desc' }, select: { versionNumber: true } })
  if (latest?.versionNumber !== versionNumber) reasons.push('Only the latest dataset version can be removed.')
  const previous = await db.datasetVersion.findFirst({
    where: { datasetId, branch: 'main', versionNumber: { lt: versionNumber } },
    orderBy: { versionNumber: 'desc' }, select: { versionNumber: true, lifecycle: true },
  })
  const mode = previous ? 'version' as const : 'dataset' as const
  if (dataset.publishedVersion === versionNumber && previous?.lifecycle !== 'published' && previous) {
    reasons.push('The preceding version is not published.')
  }
  const [downstream, branches, approvals, activeJobs, pipelines, transforms, dashboards, objectTypes, linkTypes, actions, otherOutputs] = await Promise.all([
    db.versionLineageEdge.count({ where: { fromDatasetId: datasetId, fromVersionNumber: versionNumber } }),
    db.datasetBranch.findMany({ where: { datasetId }, select: { baseVersion: true, headVersion: true } }),
    db.approvalRequest.count({ where: { kind: 'publish_dataset', targetId: datasetId, versionNumber, status: 'pending' } }),
    version.outputJobId ? db.executionJob.count({ where: { id: version.outputJobId, status: { in: ['queued', 'running'] } } }) : Promise.resolve(0),
    db.pipeline.findMany({ select: { id: true, name: true, graphJson: true, upstreamDatasetIds: true } }),
    db.transform.findMany({ select: { name: true, inputsJson: true, outputDatasetName: true } }),
    db.dashboard.findMany({ select: { title: true, layoutJson: true } }),
    db.objectType.count({ where: { sourceDatasetId: datasetId } }),
    db.linkType.count({ where: { linkDatasetId: datasetId } }),
    db.actionType.count({ where: { targetDatasetId: datasetId } }),
    db.pipelineRun.count({ where: { outputDatasetId: datasetId, outputVersionNumber: versionNumber, id: { not: runId } } }),
  ])
  if (downstream) reasons.push(`${downstream} downstream output(s) use this exact version.`)
  if (branches.some((branch) => branch.baseVersion === versionNumber || branch.headVersion === versionNumber)) reasons.push('A branch points to this version.')
  if (mode === 'dataset' && branches.length) reasons.push('The dataset has branches.')
  if (approvals) reasons.push('A publication request is pending for this version.')
  if (activeJobs) reasons.push('The output job is still active.')
  if (otherOutputs) reasons.push('Another run references this output version.')
  const pipelineConsumers = pipelines.filter((pipeline) => pipeline.graphJson.includes(datasetId) || pipeline.upstreamDatasetIds.includes(datasetId))
  if (pipelineConsumers.length) reasons.push(`Referenced by pipeline: ${pipelineConsumers.map((pipeline) => pipeline.name).join(', ')}.`)
  const transformConsumers = transforms.filter((transform) => transform.inputsJson.includes(datasetId) || transform.outputDatasetName === dataset.name)
  if (transformConsumers.length) reasons.push(`Referenced by transform: ${transformConsumers.map((transform) => transform.name).join(', ')}.`)
  if (dashboards.some((dashboard) => dashboard.layoutJson.includes(datasetId))) reasons.push('Referenced by a dashboard.')
  if (objectTypes || linkTypes || actions) reasons.push('Referenced by the Ontology or an action.')
  return {
    run,
    state: 'available' as const,
    dataset,
    version,
    mode,
    previousVersionNumber: previous?.versionNumber ?? null,
    reasons,
    allowed: reasons.length === 0,
  }
}

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { id, runId } = await params
    const result = await assess(id, runId)
    if (!result) return jsonError(404, 'Run not found')
    if (result.state !== 'available') return jsonOk({ state: result.state, allowed: false })
    return jsonOk({
      state: result.state,
      allowed: result.allowed,
      mode: result.mode,
      datasetName: result.dataset.name,
      datasetId: result.dataset.id,
      versionNumber: result.version.versionNumber,
      rowCount: result.version.rowCount,
      reasons: result.reasons,
    })
  } catch (error) {
    return serverError(error instanceof Error ? error.message : 'Failed to check output')
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  try {
    const denied = requireRole(req, 'editor')
    if (denied) return denied
    const { id, runId } = await params
    const result = await assess(id, runId)
    if (!result) return jsonError(404, 'Run not found')
    if (result.state !== 'available') return jsonError(409, 'This run has no output to remove')
    if (!result.allowed) return jsonError(409, result.reasons.join(' '))
    const datasetId = result.dataset.id
    const versionNumber = result.version.versionNumber
    await db.$transaction(async (tx) => {
      await tx.datasetVersionRow.deleteMany({ where: { datasetId, versionNumber } })
      await tx.qualityResult.deleteMany({ where: { datasetId, versionNumber } })
      await tx.versionLineageEdge.deleteMany({ where: { toDatasetId: datasetId, toVersionNumber: versionNumber } })
      if (result.mode === 'dataset') {
        await tx.lineageEdge.deleteMany({ where: { OR: [{ fromDatasetId: datasetId }, { toDatasetId: datasetId }] } })
        await tx.dataset.delete({ where: { id: datasetId } })
      } else {
        await tx.datasetVersion.delete({ where: { datasetId_versionNumber: { datasetId, versionNumber } } })
        if (result.dataset.publishedVersion === versionNumber) {
          await tx.dataset.update({ where: { id: datasetId }, data: { publishedVersion: result.previousVersionNumber } })
        }
      }
    })
    audit({
      req,
      action: 'pipeline.output.delete',
      resourceType: 'pipeline',
      resourceId: id,
      resourceName: result.dataset.name,
      detail: `run=${runId} dataset=${datasetId} version=${versionNumber} mode=${result.mode}`,
    })
    return jsonOk({ removed: result.mode, datasetId, versionNumber })
  } catch (error) {
    return serverError(error instanceof Error ? error.message : 'Failed to remove output')
  }
}
