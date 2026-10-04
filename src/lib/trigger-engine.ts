// Persist upstream events before returning to the writer. Repeated delivery of
// the same dataset version uses the same event key, so it queues only once.
import { db } from '@/lib/db'
import { enqueuePipelineJob } from '@/lib/execution-jobs'
import { createNotification } from '@/lib/notify'
import { parseJsonSafe } from '@/lib/api-utils'
import type { VersionCreatedEvent } from '@/lib/version-events'

export async function handleVersionCreated(event: VersionCreatedEvent): Promise<void> {
  const candidates = await db.pipeline.findMany({
    where: { triggerMode: 'upstream' },
    select: { id: true, name: true, upstreamDatasetIds: true, maxRetries: true },
  })
  for (const pipeline of candidates) {
    const watchedIds = parseJsonSafe<string[]>(pipeline.upstreamDatasetIds, [])
    if (!Array.isArray(watchedIds) || !watchedIds.includes(event.datasetId)) continue
    if (event.source?.startsWith('pipeline:') &&
        event.source.slice('pipeline:'.length).trim().toLowerCase() === pipeline.name.trim().toLowerCase()) continue

    const eventKey = `upstream:${pipeline.id}:${event.datasetId}:${event.versionNumber}`
    const job = await enqueuePipelineJob(pipeline.id, {
      trigger: 'upstream', eventKey, maxAttempts: pipeline.maxRetries + 1,
    })
    if (job.status === 'queued' && job.attempt === 0) {
      await createNotification({
        type: 'pipeline_triggered', title: `Queued: ${pipeline.name}`,
        body: `dataset ${event.datasetId} v${event.versionNumber}`,
        resourceType: 'pipeline', resourceId: pipeline.id, href: `/pipelines/${pipeline.id}`,
      })
    }
  }
}
