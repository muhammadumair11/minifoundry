// GET /api/foundry/v1/pipelines?page=&pageSize= — pipeline listing over the
// public API. nodeCount is derived from the stored graph JSON; lastRun is the
// latest run by startedAt (status + startedAt only).

import { db } from '@/lib/db'
import { jsonOk, parseJsonSafe, serverError } from '@/lib/api-utils'
import type { PipelineGraph } from '@/lib/engine'
import { v1List, v1PageFrom, withApiToken } from '@/lib/api-v1'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
    return await withApiToken(req, async () => {
      const { page, pageSize } = v1PageFrom(new URL(req.url))

      const [pipelines, total] = await Promise.all([
        db.pipeline.findMany({
          orderBy: { updatedAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: {
            runs: {
              orderBy: { startedAt: 'desc' },
              take: 1,
              select: { status: true, startedAt: true },
            },
          },
        }),
        db.pipeline.count(),
      ])

      return jsonOk(
        v1List(
          pipelines.map((p) => {
            const graph = parseJsonSafe<PipelineGraph | null>(p.graphJson, null)
            return {
              id: p.id,
              name: p.name,
              description: p.description,
              nodeCount: graph?.nodes.length ?? 0,
              lastRun: p.runs[0]
                ? { status: p.runs[0].status, startedAt: p.runs[0].startedAt }
                : null,
              updatedAt: p.updatedAt,
            }
          }),
          { page, pageSize },
          total,
        ),
      )
    })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load pipelines')
  }
}
