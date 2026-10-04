// MiniFoundry — P2 trust workflow: publication gate helpers.
//
// A dataset with `qualityGate: true` holds every new version as a DRAFT.
// Consumers (pipeline sources, dashboards, object layer, public API) read the
// last PUBLISHED version — drafts are studio-only until an editor publishes.
//
// Publishing rules:
//   - version must exist and be a draft
//   - the version's quality state must not be 'failed' (any error-severity
//     rule failing) — that is the whole point of the gate
//   - publishing moves dataset.publishedVersion to this version
//
// Toggling the gate:
//   - enable:  publishedVersion backfilled to head (existing data becomes the
//     baseline consumers keep seeing)
//   - disable: all drafts are published immediately and the pointer follows
//     head (ungated datasets have no unpublished state)

import { db } from '@/lib/db'
import { getHeadVersionNumber } from '@/lib/version-events'

export class PublicationError extends Error {
  status: number
  /** Machine-readable reasons surfaced in API errors and studio UI. */
  reasons: string[]
  constructor(message: string, status = 400, reasons: string[] = []) {
    super(message)
    this.status = status
    this.reasons = reasons
  }
}

export interface PublishOutcome {
  datasetId: string
  datasetName: string
  versionNumber: number
  qualityState: string
  publishedVersion: number
}

/** Failing error-severity rules for one version (latest result per rule). */
export async function failingErrorRules(
  datasetId: string,
  versionNumber: number,
): Promise<{ name: string; message: string | null }[]> {
  const results = await db.qualityResult.findMany({
    where: { datasetId, versionNumber },
    orderBy: { createdAt: 'desc' },
    include: { rule: { select: { name: true, severity: true, enabled: true } } },
  })
  const latestPerRule = new Map<string, (typeof results)[number]>()
  for (const r of results) {
    if (!latestPerRule.has(r.ruleId)) latestPerRule.set(r.ruleId, r)
  }
  return [...latestPerRule.values()]
    .filter((r) => !r.passed && r.rule.severity === 'error')
    .map((r) => ({ name: r.rule.name, message: r.message }))
}

/**
 * Publish a draft version (moves the consumer pointer). Throws
 * PublicationError with a 4xx status and human-readable reasons when the
 * publication gate blocks it.
 */
export async function publishDatasetVersion(
  datasetId: string,
  versionNumber: number,
): Promise<PublishOutcome> {
  const dataset = await db.dataset.findUnique({
    where: { id: datasetId },
    select: { id: true, name: true, qualityGate: true, publishedVersion: true },
  })
  if (!dataset) throw new PublicationError(`Dataset '${datasetId}' not found`, 404)

  const version = await db.datasetVersion.findUnique({
    where: { datasetId_versionNumber: { datasetId, versionNumber } },
    select: { versionNumber: true, lifecycle: true, qualityState: true, branch: true },
  })
  if (!version) {
    throw new PublicationError(`Version ${versionNumber} of '${dataset.name}' not found`, 404)
  }
  if (version.lifecycle === 'published') {
    throw new PublicationError(
      `v${versionNumber} is already published (only drafts can be published)`,
      400,
    )
  }

  if (version.qualityState === 'failed') {
    const failures = await failingErrorRules(datasetId, versionNumber)
    throw new PublicationError(
      `Publication blocked: v${versionNumber} failed ${failures.length} error-severity quality rule${failures.length === 1 ? '' : 's'}`,
      403,
      failures.map((f) => `${f.name}${f.message ? ` — ${f.message}` : ''}`),
    )
  }

  await db.$transaction([
    db.datasetVersion.update({
      where: { datasetId_versionNumber: { datasetId, versionNumber } },
      data: { lifecycle: 'published' },
    }),
    db.dataset.update({
      where: { id: datasetId },
      data: { publishedVersion: versionNumber },
    }),
  ])

  return {
    datasetId,
    datasetName: dataset.name,
    versionNumber,
    qualityState: version.qualityState ?? 'not_evaluated',
    publishedVersion: versionNumber,
  }
}

/** Latest draft version of a dataset (highest versionNumber), or null. */
export async function latestDraftVersion(datasetId: string): Promise<number | null> {
  const draft = await db.datasetVersion.findFirst({
    where: { datasetId, lifecycle: 'draft' },
    orderBy: { versionNumber: 'desc' },
    select: { versionNumber: true },
  })
  return draft?.versionNumber ?? null
}

/**
 * Toggle a dataset's quality gate. Called from PATCH /api/datasets/[id].
 * Enabling backfills the pointer; disabling publishes every draft so an
 * ungated dataset never has hidden unpublished state.
 */
export async function setQualityGate(datasetId: string, enabled: boolean): Promise<void> {
  const dataset = await db.dataset.findUnique({
    where: { id: datasetId },
    select: { id: true, qualityGate: true },
  })
  if (!dataset || dataset.qualityGate === enabled) return

  if (enabled) {
    const head = await getHeadVersionNumber(datasetId)
    await db.dataset.update({
      where: { id: datasetId },
      data: { qualityGate: true, publishedVersion: head || null },
    })
    return
  }

  // Disabling: publish drafts + point consumers at head.
  const head = await getHeadVersionNumber(datasetId)
  await db.$transaction([
    db.datasetVersion.updateMany({
      where: { datasetId, lifecycle: 'draft' },
      data: { lifecycle: 'published' },
    }),
    db.dataset.update({
      where: { id: datasetId },
      data: { qualityGate: false, ...(head > 0 ? { publishedVersion: head } : {}) },
    }),
  ])
}
