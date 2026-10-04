import { db } from '@/lib/db'
import { jsonOk, serverError } from '@/lib/api-utils'
import { requireRole } from '@/lib/governance'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const denied = requireRole(req, 'viewer')
  if (denied) return denied
  try {
    const jobs = await db.executionJob.findMany({
      orderBy: { createdAt: 'desc' }, take: 50,
    })
    const pipelines = await db.pipeline.findMany({
      where: { id: { in: [...new Set(jobs.map((job) => job.pipelineId))] } },
      select: { id: true, name: true },
    })
    const names = new Map(pipelines.map((pipeline) => [pipeline.id, pipeline.name]))
    return jsonOk({ jobs: jobs.map((job) => ({
      id: job.id, pipelineId: job.pipelineId, pipelineName: names.get(job.pipelineId) ?? job.pipelineId,
      versionNumber: job.versionNumber, trigger: job.trigger, status: job.status,
      leaseExpired: job.status === 'running' && job.leaseUntil !== null && job.leaseUntil < new Date(),
      attempt: job.attempt, maxAttempts: job.maxAttempts, error: job.error,
      lastRunId: job.lastRunId, createdAt: job.createdAt, updatedAt: job.updatedAt,
    })) })
  } catch (error) {
    return serverError(error instanceof Error ? error.message : 'Failed to load jobs')
  }
}
