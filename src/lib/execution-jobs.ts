import { randomUUID } from 'node:crypto'
import { Prisma, type ExecutionJob } from '@prisma/client'
import { db } from '@/lib/db'
import { ensurePipelineVersion } from '@/lib/pipeline-version-service'
import { PIPELINE_BUSY_MESSAGE, runPipeline } from '@/lib/engine'
import { createNotification } from '@/lib/notify'
import { parseJsonSafe } from '@/lib/api-utils'
import type { RunManifest } from '@/lib/engine'

const LEASE_MS = 2 * 60_000
const RETRY_DELAY_MS = 2_000

export interface EnqueuePipelineOptions {
  trigger: 'manual' | 'schedule' | 'upstream'
  eventKey: string
  scheduleId?: string
  maxAttempts?: number
}

export async function enqueuePipelineJob(pipelineId: string, options: EnqueuePipelineOptions): Promise<ExecutionJob> {
  const existing = await db.executionJob.findUnique({ where: { eventKey: options.eventKey } })
  if (existing) return existing

  // Capture the graph version at event time, before a learner edits it again.
  const version = await ensurePipelineVersion(pipelineId)
  try {
    return await db.executionJob.create({
      data: {
        pipelineId,
        versionNumber: version.versionNumber,
        trigger: options.trigger,
        scheduleId: options.scheduleId ?? null,
        eventKey: options.eventKey,
        maxAttempts: Math.max(1, Math.min(6, options.maxAttempts ?? 1)),
      },
    })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const raced = await db.executionJob.findUnique({ where: { eventKey: options.eventKey } })
      if (raced) return raced
    }
    throw error
  }
}

/** Compare-and-swap a candidate so concurrent workers cannot claim the same lease. */
export async function claimExecutionJob(workerId: string, now = new Date()): Promise<ExecutionJob | null> {
  for (let scan = 0; scan < 10; scan++) {
    const candidate = await db.executionJob.findFirst({
      where: {
        OR: [
          { status: 'queued', availableAt: { lte: now } },
          { status: 'running', leaseUntil: { lt: now } },
        ],
      },
      orderBy: { createdAt: 'asc' },
    })
    if (!candidate) return null
    const claimed = await db.executionJob.updateMany({
      where: {
        id: candidate.id,
        status: candidate.status,
        attempt: candidate.attempt,
        ...(candidate.status === 'running'
          ? { leaseUntil: { lt: now } }
          : { availableAt: { lte: now } }),
      },
      data: {
        status: 'running',
        attempt: { increment: 1 },
        leaseOwner: workerId,
        leaseUntil: new Date(now.getTime() + LEASE_MS),
        error: null,
      },
    })
    if (claimed.count === 1) return db.executionJob.findUnique({ where: { id: candidate.id } })
  }
  return null
}

export async function heartbeatExecutionJob(jobId: string, workerId: string): Promise<boolean> {
  const updated = await db.executionJob.updateMany({
    where: { id: jobId, status: 'running', leaseOwner: workerId },
    data: { leaseUntil: new Date(Date.now() + LEASE_MS) },
  })
  return updated.count === 1
}

export async function processExecutionJob(job: ExecutionJob, workerId: string): Promise<void> {
  const heartbeat = setInterval(() => {
    void heartbeatExecutionJob(job.id, workerId).catch((error) =>
      console.error('[job-worker] heartbeat failed:', error),
    )
  }, 15_000)
  try {
    if (await completeCommittedOutput(job.id, workerId)) return
    const version = await db.pipelineVersion.findUnique({
      where: { pipelineId_versionNumber: { pipelineId: job.pipelineId, versionNumber: job.versionNumber } },
    })
    if (!version) throw new Error(`Pipeline version ${job.versionNumber} is unavailable`)
    const run = await runPipeline(job.pipelineId, {
      graphOverride: version.graphJson,
      versionNumber: version.versionNumber,
      outputJobId: job.id,
      // The schedule window was reserved when the job was enqueued.
      trigger: job.attempt === 1 ? job.trigger : 'retry',
      attempt: job.attempt,
    })
    await db.executionJob.updateMany({
      where: { id: job.id, status: 'running', leaseOwner: workerId },
      data: { lastRunId: run.id },
    })
    if (run.failureCause === PIPELINE_BUSY_MESSAGE) {
      await db.executionJob.updateMany({
        where: { id: job.id, status: 'running', leaseOwner: workerId },
        data: {
          status: 'queued', attempt: { decrement: 1 },
          availableAt: new Date(Date.now() + RETRY_DELAY_MS),
          leaseOwner: null, leaseUntil: null, error: PIPELINE_BUSY_MESSAGE,
        },
      })
      return
    }
    if (run.status !== 'success') {
      throw new Error(run.failureCause ?? `Pipeline run ${run.id} failed`)
    }
    await db.executionJob.updateMany({
      where: { id: job.id, status: 'running', leaseOwner: workerId },
      data: {
        status: 'succeeded', lastRunId: run.id, leaseOwner: null,
        leaseUntil: null, finishedAt: new Date(),
      },
    })
  } catch (error) {
    // A worker can lose its lease after the version was committed but before
    // it acknowledged the job. Never write a second output for the same job.
    if (await completeCommittedOutput(job.id, workerId)) return
    const message = error instanceof Error ? error.message : String(error)
    const exhausted = job.attempt >= job.maxAttempts
    const updated = await db.executionJob.updateMany({
      where: { id: job.id, status: 'running', leaseOwner: workerId },
      data: {
        status: exhausted ? 'failed' : 'queued',
        error: message,
        leaseOwner: null,
        leaseUntil: null,
        availableAt: new Date(Date.now() + RETRY_DELAY_MS),
        finishedAt: exhausted ? new Date() : null,
      },
    })
    if (exhausted && updated.count === 1) {
      const pipeline = await db.pipeline.findUnique({ where: { id: job.pipelineId }, select: { name: true } })
      await createNotification({
        type: 'run_failed', title: `Pipeline failed: ${pipeline?.name ?? job.pipelineId}`,
        body: `attempt ${job.attempt}/${job.maxAttempts}: ${message.slice(0, 160)}`,
        resourceType: 'pipeline', resourceId: job.pipelineId, href: `/pipelines/${job.pipelineId}`,
      })
    }
  } finally {
    clearInterval(heartbeat)
  }
}

async function completeCommittedOutput(jobId: string, workerId: string): Promise<boolean> {
  const output = await db.datasetVersion.findUnique({
    where: { outputJobId: jobId }, include: { dataset: { select: { name: true } } },
  })
  if (!output) return false
  const runId = output.createdBy
  if (!runId) throw new Error(`Output for job ${jobId} has no producing run`)
  const run = await db.pipelineRun.findUnique({ where: { id: runId } })
  if (!run) throw new Error(`Output for job ${jobId} has no producing run record`)
  const manifest = parseJsonSafe<RunManifest | null>(run.manifestJson, null)
  if (!manifest || !Array.isArray(manifest.inputs) || !Array.isArray(manifest.nodes)) {
    throw new Error(`Output for job ${jobId} has no recoverable input manifest`)
  }
  const inputs = [...new Map(manifest.inputs
    .filter((input) => input.versionNumber != null)
    .map((input) => [input.datasetId, input])).values()]
  for (const input of inputs) {
    await db.lineageEdge.upsert({
      where: { fromDatasetId_toDatasetId_pipelineId: {
        fromDatasetId: input.datasetId, toDatasetId: output.datasetId, pipelineId: run.pipelineId,
      } },
      update: {},
      create: { fromDatasetId: input.datasetId, toDatasetId: output.datasetId, pipelineId: run.pipelineId },
    })
    const existing = await db.versionLineageEdge.findFirst({
      where: { runId, fromDatasetId: input.datasetId, toDatasetId: output.datasetId,
        toVersionNumber: output.versionNumber },
    })
    if (!existing) await db.versionLineageEdge.create({ data: {
      runId, pipelineId: run.pipelineId, fromDatasetId: input.datasetId,
      fromVersionNumber: input.versionNumber!, toDatasetId: output.datasetId,
      toVersionNumber: output.versionNumber,
    } })
  }
  const recoveredManifest: RunManifest = {
    ...manifest,
    outputs: [{ datasetId: output.datasetId, datasetName: output.dataset.name,
      versionNumber: output.versionNumber, rowCount: output.rowCount }],
  }
  await db.pipelineRun.update({
    where: { id: runId },
    data: {
      status: 'success', finishedAt: new Date(), outputDatasetId: output.datasetId,
      outputVersionNumber: output.versionNumber, manifestJson: JSON.stringify(recoveredManifest),
      failureCause: null,
    },
  })
  await db.executionJob.updateMany({
    where: { id: jobId, status: 'running', leaseOwner: workerId },
    data: { status: 'succeeded', lastRunId: runId, leaseOwner: null, leaseUntil: null, finishedAt: new Date() },
  })
  return true
}

export async function processNextExecutionJob(workerId: string = randomUUID()): Promise<boolean> {
  const job = await claimExecutionJob(workerId)
  if (!job) return false
  await processExecutionJob(job, workerId)
  return true
}
