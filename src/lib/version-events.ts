// MiniFoundry — R14 version-created event hook.
//
// Every code path that creates a NEW DatasetVersion (ingestions, transform
// runs, pipeline run outputs, CSV upload, branch merge, ontology write-back)
// MUST call emitVersionCreated() after the version row is committed.
// Listeners are executed sequentially and their failures are swallowed so a
// broken listener can never break the caller's main flow.
//
// Listeners:
//  1. trigger-engine.handleVersionCreated — upstream pipeline triggering (R14)
//  2. quality auto-evaluation (P2) — every new version is evaluated against
//     the dataset's enabled quality rules and the aggregate state is stamped
//     onto the version row (feeds the publication gate).

import { db } from '@/lib/db'
import { handleVersionCreated } from '@/lib/trigger-engine'
import { evaluateRules } from '@/lib/quality'
import { createNotification } from '@/lib/notify'

export interface VersionCreatedEvent {
  datasetId: string
  versionNumber: number
  /** best-effort actor label for trigger logs, e.g. "pipeline:Shipment Overview" */
  source?: string
}

/**
 * Fire-and-forget (awaited, never-throws) notification that a dataset has a
 * new version. Call AFTER the version is visible in the DB.
 */
export async function emitVersionCreated(event: VersionCreatedEvent): Promise<void> {
  try {
    await handleVersionCreated(event)
  } catch (error) {
    console.error('[version-events] trigger-engine handler failed:', error)
  }
  // P2: automatic quality evaluation for every new version (trigger label
  // 'post_run' when a pipeline produced it, 'auto' otherwise).
  try {
    const fromPipeline = (event.source ?? '').startsWith('pipeline')
    await evaluateRules(event.datasetId, event.versionNumber, fromPipeline ? 'post_run' : 'auto')
  } catch (error) {
    console.error('[version-events] quality auto-evaluation failed:', error)
  }
  // P4: notify dataset watchers about the new version (Phase 4 collaboration).
  try {
    await notifyWatchers(event)
  } catch (error) {
    console.error('[version-events] watcher notification failed:', error)
  }
}

/**
 * P4: create one notification per watcher of the dataset. Session users get
 * targeted notifications; demo simulator watchers ('sim:<role>') become
 * broadcasts so the sandbox bell shows them. Never throws.
 */
async function notifyWatchers(event: VersionCreatedEvent): Promise<void> {
  const watchers = await db.datasetWatcher.findMany({
    where: { datasetId: event.datasetId },
    select: { userEmail: true },
  })
  if (watchers.length === 0) return

  const dataset = await db.dataset.findUnique({
    where: { id: event.datasetId },
    select: { name: true },
  })
  if (!dataset) return

  const label = event.source ?? 'a write'
  for (const watcher of watchers) {
    const isSim = watcher.userEmail.startsWith('sim:')
    await createNotification({
      userEmail: isSim ? null : watcher.userEmail,
      type: 'system',
      title: `${dataset.name} — new version v${event.versionNumber}`,
      body: `A new version was written by ${label}.`,
      resourceType: 'dataset',
      resourceId: event.datasetId,
      href: `/datasets/${event.datasetId}`,
    })
  }
}

/** Latest versionNumber for a dataset (across ALL branches), 0 when empty. */
export async function getHeadVersionNumber(datasetId: string): Promise<number> {
  const head = await db.datasetVersion.findFirst({
    where: { datasetId },
    orderBy: { versionNumber: 'desc' },
    select: { versionNumber: true },
  })
  return head?.versionNumber ?? 0
}
