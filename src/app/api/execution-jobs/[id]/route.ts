import { db } from '@/lib/db'
import { jsonOk, notFound, serverError } from '@/lib/api-utils'
import { requireRole } from '@/lib/governance'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = requireRole(req, 'viewer')
  if (denied) return denied
  try {
    const { id } = await params
    const job = await db.executionJob.findUnique({ where: { id } })
    if (!job) return notFound(`Job '${id}' not found`)
    return jsonOk({ job: {
      id: job.id, pipelineId: job.pipelineId, status: job.status,
      attempt: job.attempt, maxAttempts: job.maxAttempts,
      lastRunId: job.lastRunId, error: job.error,
    } })
  } catch (error) {
    return serverError(error instanceof Error ? error.message : 'Failed to load job')
  }
}
