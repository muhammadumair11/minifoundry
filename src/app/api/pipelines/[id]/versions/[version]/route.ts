// GET /api/pipelines/[id]/versions/[version] — one version snapshot with its
// parsed graph. 404 for unknown pipelines/versions or non-numeric version
// params. Read endpoint — same guard posture as GET /api/pipelines/[id].

import { jsonOk, notFound, parseJsonSafe, serverError } from '@/lib/api-utils'
import type { PipelineGraph } from '@/lib/engine'
import { getPipelineVersion } from '@/lib/pipeline-version-service'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; version: string }> },
) {
  try {
    const { id, version } = await params
    const versionNumber = Number(version)
    if (!Number.isInteger(versionNumber) || versionNumber < 1) {
      return notFound(`Version '${version}' not found for pipeline '${id}'`)
    }

    const snapshot = await getPipelineVersion(id, versionNumber)
    if (!snapshot) return notFound(`Version '${version}' not found for pipeline '${id}'`)

    return jsonOk({
      version: {
        versionNumber: snapshot.versionNumber,
        nodeCount: snapshot.nodeCount,
        note: snapshot.note,
        createdBy: snapshot.createdBy,
        createdAt: snapshot.createdAt,
        graph: parseJsonSafe<PipelineGraph | null>(snapshot.graphJson, null),
      },
    })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load pipeline version')
  }
}
