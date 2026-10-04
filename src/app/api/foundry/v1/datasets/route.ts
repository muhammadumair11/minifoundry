// GET /api/foundry/v1/datasets?page=&pageSize= — public dataset catalog.
// Token-authed (viewer-role), paginated v1 envelope; latestVersion comes from
// the newest DatasetVersion (same query pattern as the session /api/datasets).

import { db } from '@/lib/db'
import { jsonOk, parseJsonSafe, serverError } from '@/lib/api-utils'
import { v1List, v1PageFrom, withApiToken } from '@/lib/api-v1'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
    return await withApiToken(req, async () => {
      const { page, pageSize } = v1PageFrom(new URL(req.url))

      const [datasets, total] = await Promise.all([
        db.dataset.findMany({
          orderBy: { updatedAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: {
            versions: {
              where: { branch: 'main', lifecycle: 'published' },
              orderBy: { versionNumber: 'desc' },
              take: 1,
              select: { versionNumber: true, rowCount: true, createdAt: true },
            },
          },
        }),
        db.dataset.count(),
      ])

      return jsonOk(
        v1List(
          datasets.map((d) => ({
            id: d.id,
            name: d.name,
            description: d.description,
            tags: parseJsonSafe<string[]>(d.tags, []),
            projectId: d.projectId,
            latestVersion: d.versions[0]
              ? {
                  versionNumber: d.versions[0].versionNumber,
                  rowCount: d.versions[0].rowCount,
                  createdAt: d.versions[0].createdAt,
                }
              : null,
            updatedAt: d.updatedAt,
          })),
          { page, pageSize },
          total,
        ),
      )
    })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load datasets')
  }
}
