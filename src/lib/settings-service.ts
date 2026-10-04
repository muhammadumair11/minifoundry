// MiniFoundry — Task 12-a Settings/Reset service.
//
// resetWorkspace: wipes ALL domain data (datasets, pipelines, outputs,
// ontology, governance, API tokens, logs, projects) inside ONE transaction,
// in FK-safe order. User rows are KEPT so login keeps working. A single
// 'workspace.reset' AuditEntry is written (inside the same transaction) as
// the ONLY audit row that survives, embedding the non-zero per-model counts.
//
// getWorkspaceOverview: read-only platform-wide counts for the Settings page.
// Aggregate numbers only — no secrets, safe for any role.

import { db } from '@/lib/db'
import type { WorkspaceOverview } from '@/lib/foundry-types'

/** Per-model deleted-row counts, keyed by Prisma model (plural, camelCase). */
export type ResetCounts = Record<string, number>

export interface ResetResult {
  resetAt: string
  counts: ResetCounts
}

/**
 * Delete every domain row (everything except User) inside a single
 * transaction, then write the one AuditEntry that documents the wipe.
 * Order is FK-safe; deletes that the schema would cascade anyway are done
 * explicitly so they can be counted and reported.
 */
export async function resetWorkspace(
  actor: { role: string; email: string | null },
): Promise<ResetResult> {
  const counts = await db.$transaction(async (tx) => {
    const c: ResetCounts = {}

    // a) Action logs (would cascade via ActionType; explicit for counting).
    c.actionLogs = (await tx.actionLog.deleteMany()).count
    // b) Ontology children (would cascade via ObjectType; explicit for counting).
    c.linkTypes = (await tx.linkType.deleteMany()).count
    c.properties = (await tx.property.deleteMany()).count
    // c) Object types.
    c.objectTypes = (await tx.objectType.deleteMany()).count
    // d) Column markings (dataset/marking children).
    c.columnMarkings = (await tx.columnMarking.deleteMany()).count
    // d2) R14: quality results (rule children), then rules (dataset children).
    c.qualityResults = (await tx.qualityResult.deleteMany()).count
    c.qualityRules = (await tx.qualityRule.deleteMany()).count
    // d3) R14: dataset branches (dataset children).
    c.datasetBranches = (await tx.datasetBranch.deleteMany()).count
    // d4) P4: dataset comments & watchers (dataset children).
    c.datasetComments = (await tx.datasetComment.deleteMany()).count
    c.datasetWatchers = (await tx.datasetWatcher.deleteMany()).count
    // e) Dataset versions (would cascade via Dataset; explicit for counting).
    c.datasetVersions = (await tx.datasetVersion.deleteMany()).count
    // f) Lineage edges (no FK to datasets — manual cleanup).
    c.lineageEdges = (await tx.lineageEdge.deleteMany()).count
    // f2) P2: version-level lineage edges (no FK — manual cleanup).
    c.versionLineageEdges = (await tx.versionLineageEdge.deleteMany()).count
    // g) Datasets.
    c.datasets = (await tx.dataset.deleteMany()).count
    // h) Pipeline versions (NO FK to Pipeline — must be deleted manually or they orphan).
    c.pipelineVersions = (await tx.pipelineVersion.deleteMany()).count
    // i) Pipeline runs (would cascade via Pipeline; explicit for counting).
    c.pipelineRuns = (await tx.pipelineRun.deleteMany()).count
    // j) Schedules (cascade children of Pipeline).
    c.schedules = (await tx.schedule.deleteMany()).count
    // k) Pipelines.
    c.pipelines = (await tx.pipeline.deleteMany()).count
    // l) Transform runs (would cascade via Transform; explicit for counting).
    c.transformRuns = (await tx.transformRun.deleteMany()).count
    // m) Transforms (code workbooks).
    c.transforms = (await tx.transform.deleteMany()).count
    // n) Ingestions.
    c.ingestions = (await tx.ingestion.deleteMany()).count
    // o) Connectors.
    c.connectors = (await tx.connector.deleteMany()).count
    // p) Approval requests.
    c.approvalRequests = (await tx.approvalRequest.deleteMany()).count
    // q) Markings (after their columnMarking children).
    c.markings = (await tx.marking.deleteMany()).count
    // r) API request logs (deliberately no FK to tokens — wipe explicitly).
    c.apiRequestLogs = (await tx.apiRequestLog.deleteMany()).count
    // s) API tokens.
    c.apiTokens = (await tx.apiToken.deleteMany()).count
    // t) Audit entries — wiped here; the reset entry below re-populates.
    c.auditEntries = (await tx.auditEntry.deleteMany()).count
    // u) Projects (after their datasets/pipelines are gone).
    c.projects = (await tx.project.deleteMany()).count
    // v) R14: dashboards, saved object views, per-resource ACLs, notifications.
    c.dashboards = (await tx.dashboard.deleteMany()).count
    c.objectViews = (await tx.objectView.deleteMany()).count
    c.resourceAcls = (await tx.resourceAcl.deleteMany()).count
    c.notifications = (await tx.notification.deleteMany()).count
    // w) P3: curriculum manual check-offs (per-actor progress).
    c.curriculumProgress = (await tx.curriculumProgress.deleteMany()).count

    // KEEP: User rows are NOT touched — login must keep working.

    // The ONE audit row that survives: the wipe itself, documented with its
    // non-zero counts.
    const detail = JSON.stringify(
      Object.fromEntries(Object.entries(c).filter(([, n]) => n > 0)),
    )
    await tx.auditEntry.create({
      data: {
        actorRole: actor.role,
        actorEmail: actor.email ?? null,
        action: 'workspace.reset',
        resourceType: 'platform',
        resourceName: 'MiniFoundry',
        detail,
      },
    })

    return c
  })

  return { resetAt: new Date().toISOString(), counts }
}

/**
 * Platform-wide counts for the Settings page. Promise.all of independent
 * count queries; contains no secrets, safe for any role.
 */
export async function getWorkspaceOverview(): Promise<WorkspaceOverview> {
  const [
    projects,
    connectors,
    datasets,
    datasetVersions,
    pipelines,
    pipelineVersions,
    pipelineRuns,
    schedules,
    transforms,
    transformRuns,
    objectTypes,
    properties,
    linkTypes,
    actions,
    actionLogs,
    markings,
    columnMarkings,
    approvalRequests,
    pendingApprovals,
    auditEntries,
    apiTokens,
    activeTokens,
    apiRequestLogs,
    users,
  ] = await Promise.all([
    db.project.count(),
    db.connector.count(),
    db.dataset.count(),
    db.datasetVersion.count(),
    db.pipeline.count(),
    db.pipelineVersion.count(),
    db.pipelineRun.count(),
    db.schedule.count(),
    db.transform.count(),
    db.transformRun.count(),
    db.objectType.count(),
    db.property.count(),
    db.linkType.count(),
    db.actionType.count(),
    db.actionLog.count(),
    db.marking.count(),
    db.columnMarking.count(),
    db.approvalRequest.count(),
    db.approvalRequest.count({ where: { status: 'pending' } }),
    db.auditEntry.count(),
    db.apiToken.count(),
    db.apiToken.count({ where: { revokedAt: null } }),
    db.apiRequestLog.count(),
    db.user.count(),
  ])

  return {
    projects,
    connectors,
    datasets,
    datasetVersions,
    pipelines,
    pipelineVersions,
    pipelineRuns,
    schedules,
    transforms,
    transformRuns,
    objectTypes,
    properties,
    linkTypes,
    actions,
    actionLogs,
    markings,
    columnMarkings,
    approvalRequests,
    pendingApprovals,
    auditEntries,
    apiTokens,
    activeTokens,
    apiRequestLogs,
    users,
  }
}
