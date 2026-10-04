// GET /api/runs — pipeline runs (joined with pipeline name), newest first.
// Optional filters: ?status=running|success|failed, ?pipelineId=.
// P5 scale track: bounded pagination via ?limit= (1..200, default 100) and
// ?offset= (0..10_000). Response includes meta { total, limit, offset } so
// clients can render "load more" without guessing.

import { z } from 'zod'
import { db } from '@/lib/db'
import { badRequest, jsonOk, serverError, zodErrorMessage } from '@/lib/api-utils'

export const dynamic = 'force-dynamic'

const querySchema = z.object({
  status: z.enum(['running', 'success', 'failed']).optional(),
  pipelineId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
})

export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const parsed = querySchema.safeParse({
      status: url.searchParams.get('status') ?? undefined,
      pipelineId: url.searchParams.get('pipelineId') ?? undefined,
      limit: url.searchParams.get('limit') ?? undefined,
      offset: url.searchParams.get('offset') ?? undefined,
    })
    if (!parsed.success) return badRequest(zodErrorMessage(parsed))
    const { status, pipelineId, limit, offset } = parsed.data

    const where = {
      ...(status ? { status } : {}),
      ...(pipelineId ? { pipelineId } : {}),
    }

    const [runs, total] = await Promise.all([
      db.pipelineRun.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        take: limit,
        skip: offset,
        include: { pipeline: { select: { name: true } } },
      }),
      db.pipelineRun.count({ where }),
    ])

    return jsonOk({
      runs: runs.map((r) => ({
        id: r.id,
        pipelineId: r.pipelineId,
        pipelineName: r.pipeline.name,
        status: r.status,
        versionNumber: r.versionNumber,
        // R14 (additive): trigger + attempt for the orchestration jobs table.
        trigger: r.trigger,
        attempt: r.attempt,
        // Phase 1 (additive): build-record scalars (the full manifest lives in
        // GET /api/runs/[id] — kept out of the list to bound the payload).
        durationMs: r.durationMs ?? (r.finishedAt ? r.finishedAt.getTime() - r.startedAt.getTime() : null),
        failureCause: r.failureCause,
        outputVersionNumber: r.outputVersionNumber,
        replayedFromRunId: r.replayedFromRunId,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
      })),
      meta: { total, limit, offset },
    })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load runs')
  }
}
