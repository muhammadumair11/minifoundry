// MiniFoundry — P2 trust workflow: publication gate helpers.
//
// A dataset with `qualityGate: true` holds every new version as a DRAFT.
// Consumers (pipeline sources, dashboards, object layer, public API) read the
// last PUBLISHED version — drafts are studio-only until an admin approves.
//
// Publishing rules:
//   - version must exist and be a draft
//   - an admin-approved request must pin the exact main-branch draft
//   - quality evaluation must complete with passed or warned state
//   - publishing moves dataset.publishedVersion to this version
//
// Toggling the gate:
//   - enable:  publishedVersion backfilled to head (existing data becomes the
//     baseline consumers keep seeing)
//   - disable: requires no outstanding main-branch drafts

import { db } from '@/lib/db'
import { handleVersionCreated } from '@/lib/trigger-engine'

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
  approvalId: string,
  decidedBy: string,
  decisionNote?: string | null,
): Promise<PublishOutcome> {
  const approval = await db.approvalRequest.findUnique({ where: { id: approvalId } })
  if (!approval || approval.status !== 'pending' || approval.kind !== 'publish_dataset' ||
      approval.targetId !== datasetId || approval.versionNumber !== versionNumber) {
    throw new PublicationError('A pending approval for this exact draft is required', 403)
  }
  const dataset = await db.dataset.findUnique({
    where: { id: datasetId },
    select: { id: true, name: true, qualityGate: true, publishedVersion: true },
  })
  if (!dataset) throw new PublicationError(`Dataset '${datasetId}' not found`, 404)
  if (!dataset.qualityGate) throw new PublicationError('Dataset quality gate is disabled', 409)

  const version = await db.datasetVersion.findUnique({
    where: { datasetId_versionNumber: { datasetId, versionNumber } },
    select: { versionNumber: true, lifecycle: true, qualityState: true, qualitySummaryJson: true, branch: true },
  })
  if (!version) {
    throw new PublicationError(`Version ${versionNumber} of '${dataset.name}' not found`, 404)
  }
  if (version.branch !== 'main') throw new PublicationError('Only main branch versions can be published', 409)
  if (version.lifecycle === 'published') {
    throw new PublicationError(
      `v${versionNumber} is already published (only drafts can be published)`,
      400,
    )
  }

  if (!version.qualitySummaryJson || (version.qualityState !== 'passed' && version.qualityState !== 'warned')) {
    const failures = await failingErrorRules(datasetId, versionNumber)
    throw new PublicationError(
      `Publication blocked: v${versionNumber} requires a completed quality evaluation without error-severity failures (current: ${version.qualityState ?? 'not_evaluated'})`,
      403,
      failures.map((f) => `${f.name}${f.message ? ` — ${f.message}` : ''}`),
    )
  }

  await db.$transaction(async (tx) => {
    const approved = await tx.approvalRequest.updateMany({
      where: { id: approvalId, status: 'pending', versionNumber },
      data: { status: 'approved', decidedBy, decidedAt: new Date(), decisionNote: decisionNote ?? null },
    })
    if (approved.count !== 1) throw new PublicationError('Approval was already decided', 409)
    const published = await tx.datasetVersion.updateMany({
      where: {
        datasetId, versionNumber, branch: 'main', lifecycle: 'draft',
        qualityState: { in: ['passed', 'warned'] },
      },
      data: { lifecycle: 'published' },
    })
    if (published.count !== 1) throw new PublicationError('Draft changed before publication', 409)
    const current = await tx.dataset.findUniqueOrThrow({ where: { id: datasetId }, select: { tags: true } })
    const tags = JSON.parse(current.tags) as string[]
    if (!tags.includes('production')) tags.push('production')
    await tx.dataset.update({
      where: { id: datasetId },
      data: { publishedVersion: versionNumber, tags: JSON.stringify(tags) },
    })
  })

  // Only a published version may trigger downstream consumers.
  try {
    await handleVersionCreated({ datasetId, versionNumber, source: 'publication' })
  } catch (error) {
    console.error('[publication] downstream trigger failed:', error)
  }

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
    where: { datasetId, branch: 'main', lifecycle: 'draft' },
    orderBy: { versionNumber: 'desc' },
    select: { versionNumber: true },
  })
  return draft?.versionNumber ?? null
}

/**
 * Toggle a dataset's quality gate. Called from PATCH /api/datasets/[id].
 * Enabling backfills the pointer. Disabling requires that no main draft
 * remains, so it cannot silently bypass publication.
 */
export async function setQualityGate(datasetId: string, enabled: boolean): Promise<void> {
  const dataset = await db.dataset.findUnique({
    where: { id: datasetId },
    select: { id: true, qualityGate: true },
  })
  if (!dataset || dataset.qualityGate === enabled) return

  if (enabled) {
    const head = await db.datasetVersion.findFirst({
      where: { datasetId, branch: 'main', lifecycle: 'published' },
      orderBy: { versionNumber: 'desc' }, select: { versionNumber: true },
    })
    await db.dataset.update({
      where: { id: datasetId },
      data: { qualityGate: true, publishedVersion: head?.versionNumber ?? null },
    })
    return
  }

  const drafts = await db.datasetVersion.count({ where: { datasetId, branch: 'main', lifecycle: 'draft' } })
  if (drafts > 0) {
    throw new PublicationError('Resolve or remove all drafts before disabling the quality gate', 409)
  }
  // Disabling is an admin operation; no draft may be implicitly published.
  const head = await db.datasetVersion.findFirst({
    where: { datasetId, branch: 'main' }, orderBy: { versionNumber: 'desc' },
    select: { versionNumber: true },
  })
  await db.dataset.update({
    where: { id: datasetId },
    data: { qualityGate: false, publishedVersion: head?.versionNumber ?? null },
  })
}
