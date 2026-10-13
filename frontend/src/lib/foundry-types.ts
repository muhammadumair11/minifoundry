// MiniFoundry — shared frontend types for the backend API contract (Task 1-a).
// Shapes mirror the REST responses under src/app/api/** exactly.

import { formatDistanceToNowStrict } from 'date-fns'

// ─── Platform stats ──────────────────────────────────────────────────

export interface ApiStats {
  projects: number
  datasets: number
  pipelines: number
  runs: number
  successRuns: number
  failedRuns: number
  totalRows: number
  recentRuns: {
    id: string
    pipelineName: string
    status: string
    startedAt: string
    finishedAt: string | null
  }[]
  recentDatasets: {
    id: string
    name: string
    rowCount: number
    updatedAt: string
  }[]
}

// ─── Datasets ────────────────────────────────────────────────────────

export type ColumnType = 'string' | 'number' | 'boolean'

export interface ColumnDef {
  name: string
  type: ColumnType
  /** M9 additive: name of the marking gating this column, null when unmarked. */
  markedWith?: string | null
}

export interface DatasetCurrentVersion {
  versionNumber: number
  rowCount: number
  columnCount: number
}

export interface DatasetSummary {
  id: string
  name: string
  description: string | null
  projectId: string | null
  tags: string[]
  createdAt?: string
  updatedAt: string
  currentVersion: DatasetCurrentVersion | null
  versionsCount: number
  latestDraftVersion?: number | null
}

export interface DatasetsListResponse {
  datasets: DatasetSummary[]
}

/** Human-readable origin of one dataset version (resolved from createdBy).
 *  Additive on DatasetVersionSummary + DatasetDetailResponse.versions. */
export interface VersionProvenance {
  kind: 'ingestion' | 'pipeline' | 'transform' | 'action' | 'merge' | 'seed' | 'unknown'
  /** Human label, e.g. "Pipeline — Shipment Overview". */
  label: string
  /** Optional secondary info (run status, connector type…). */
  detail: string | null
  /** Deep link to the writer when one exists. */
  href: string | null
}

export interface DatasetVersionSummary {
  id: string
  versionNumber: number
  rowCount: number
  createdBy: string | null
  createdAt: string
  /** R14 additive: which branch the version was committed on. */
  branch?: string
  /** P2 additive: 'draft' until published (only on gated datasets). */
  lifecycle?: 'draft' | 'published'
  /** P2 additive: aggregate quality state of this version (null = never evaluated). */
  qualityState?: 'not_evaluated' | 'passed' | 'warned' | 'failed' | null
  /** Additive: resolved writer (ingestion/pipeline/transform/action/merge/seed). */
  provenance?: VersionProvenance | null
}

export interface DatasetDetail {
  id: string
  name: string
  description: string | null
  projectId: string | null
  sourceConnectorId: string | null
  tags: string[]
  createdAt: string
  updatedAt: string
  versionsCount: number
  /** M4 additive: retention window (keep newest N versions, 0 = unlimited). */
  keepLastN?: number
  /** P2 additive: publication gate — new versions land as drafts. */
  qualityGate?: boolean
  /** P2 additive: latest version consumers read (null = pre-gate head). */
  publishedVersion?: number | null
}

export interface DatasetDetailResponse {
  dataset: DatasetDetail
  versions: DatasetVersionSummary[]
  current: {
    id: string
    versionNumber: number
    schema: ColumnDef[]
    rowCount: number
  }
}

export interface RowsResponse {
  rows: Record<string, unknown>[]
  total: number
  page: number
  pageSize: number
  columns: ColumnDef[]
  /** M9 additive: columns whose cell values are masked for the current role. */
  maskedColumns?: string[]
}

// ─── Pipeline graph (nodes/edges JSON) ───────────────────────────────

export type NodeTypeName =
  | 'source'
  | 'filter'
  | 'derive'
  | 'select'
  | 'rename'
  | 'join'
  | 'aggregate'
  | 'sort'
  | 'dedupe'
  | 'union'
  | 'limit'
  | 'output'

export type FilterOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains'
export type AggregateOp = 'sum' | 'avg' | 'min' | 'max' | 'count'

export interface AggregateOpSpec {
  op: AggregateOp
  column?: string
  alias?: string
}

export interface SortSpec {
  column: string
  dir: 'asc' | 'desc'
}

/** Loosely-typed node payload; specific node data interfaces below. */
export interface GraphNodeData {
  datasetId?: string
  column?: string
  operator?: FilterOperator
  value?: string
  newColumn?: string
  expression?: string
  columns?: string[]
  mapping?: Record<string, string>
  how?: 'inner' | 'left'
  leftKey?: string
  rightKey?: string
  groupBy?: string[]
  ops?: AggregateOpSpec[]
  by?: SortSpec[]
  keys?: string[]
  n?: number
  name?: string
  [key: string]: unknown
}

export interface GraphNode {
  id: string
  type: string
  data: GraphNodeData
  position: { x: number; y: number }
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  targetHandle?: string | null
}

export interface PipelineGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

// ─── Pipelines & runs ────────────────────────────────────────────────

export interface RunLog {
  ts: string
  level: 'info' | 'warn' | 'error' | 'success'
  msg: string
}

export interface RunSummary {
  id: string
  pipelineId?: string
  status: string
  /** M3.1 (additive): pipeline version this run executed; null for pre-versioning runs. */
  versionNumber?: number | null
  outputDatasetId?: string | null
  outputVersionNumber?: number | null
  startedAt: string
  finishedAt: string | null
  logs?: RunLog[]
}

export interface PipelineSummary {
  id: string
  name: string
  description: string | null
  graph: PipelineGraph
  createdAt: string
  updatedAt: string
  runsCount: number
  lastRun: {
    id: string
    status: string
    startedAt: string
    finishedAt: string | null
  } | null
}

export interface PipelinesListResponse {
  pipelines: PipelineSummary[]
}

export interface PipelineDetail {
  id: string
  name: string
  description: string | null
  graph: PipelineGraph
  createdAt: string
  updatedAt: string
  /** M3.1 (additive): latest snapshot version number; null when no versions yet. */
  latestVersionNumber?: number | null
  /** M3.1 (additive): total snapshots retained for this pipeline. */
  versionCount?: number
}

export interface PipelineDetailResponse {
  pipeline: PipelineDetail
  runs: RunSummary[]
}

export interface RunResponse {
  run: RunSummary
}

// ─── Lineage ─────────────────────────────────────────────────────────

export interface LineageNode {
  id: string
  name: string
  kind: 'source' | 'derived'
  rowCount: number
  updatedAt: string
}

export interface LineageEdgeDto {
  id: string
  from: string
  to: string
  pipelineId?: string | null
}

export interface LineageGraph {
  nodes: LineageNode[]
  edges: LineageEdgeDto[]
}

// ─── Ingestion ───────────────────────────────────────────────────────

export interface IngestionSummary {
  id: string
  connectorName: string | null
  datasetName: string | null
  status: string
  message: string | null
  rowsIngested: number
  startedAt: string
  finishedAt: string | null
}

export interface IngestionsListResponse {
  ingestions: IngestionSummary[]
}

export interface IngestResponse {
  ingestion: IngestionSummary
  dataset: Pick<DatasetSummary, 'id' | 'name' | 'description' | 'projectId' | 'tags' | 'updatedAt'> & {
    sourceConnectorId: string | null
    version: DatasetCurrentVersion & { id: string; schema: ColumnDef[] }
  }
}

// ─── M5 Orchestration (Task 2-a/2-b contract) ────────────────────────

export interface Schedule {
  id: string
  pipelineId: string
  pipelineName: string
  name: string
  enabled: boolean
  intervalMinutes: number
  lastRunAt: string | null
  nextRunAt: string | null
}

export interface ScheduleListResponse {
  schedules: Schedule[]
}

export interface ScheduleResponse {
  schedule: Schedule
}

export interface OrchestrationRun {
  id: string
  pipelineId: string
  pipelineName: string
  status: string
  /** M3.1 (additive): pipeline version this run executed; null for pre-versioning runs. */
  versionNumber?: number | null
  startedAt: string
  finishedAt: string | null
  /** finishedAt - startedAt; null while the run is still in flight. */
  durationMs: number | null
}

export interface RunsListResponse {
  runs: OrchestrationRun[]
}

export interface HealthDataset {
  id: string
  name: string
  rowCount: number
  updatedAt: string
  freshnessMinutes: number
}

export interface FailingPipeline {
  id: string
  name: string
  failedCount: number
  lastFailureAt: string
}

export interface HealthResponse {
  /** All-time success / (success + failed); 100 when no finished runs. */
  successRatePct: number
  /** Mean duration over finished runs; null when none. */
  avgDurationMs: number | null
  runs7d: number
  failed7d: number
  datasets: HealthDataset[]
  /** Top 5 pipelines with failedCount > 0. */
  failingPipelines: FailingPipeline[]
}

// ─── M7 Ontology & M8 Workshop-lite (Task 3-a/3-b contract) ──────────

export type OntologyColorKey = 'emerald' | 'teal' | 'amber' | 'rose' | 'orange' | 'zinc'
export type LinkCardinality = 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many'
export type LinkDirection = 'outgoing' | 'incoming'
export type ActionOperation = 'create' | 'update' | 'delete'

export interface OntologyProperty {
  apiName: string
  displayName: string
  dataType: string
  isTitle: boolean
  hideInTable: boolean
}

export interface LinkSummary {
  id: string
  apiName: string
  displayName: string
  cardinality: LinkCardinality
}

/** Outgoing link: `toType*` describes the target side. */
export interface OutgoingLinkSummary extends LinkSummary {
  toTypeId: string
  toTypeApiName: string
  toTypeDisplayName: string
  fkProperty: string | null
  fkSide: 'from' | 'to' | null
  linkDatasetId: string | null
  linkDatasetName: string | null
  fromKeyColumn: string | null
  toKeyColumn: string | null
}

/** Incoming link: `fromType*` describes the other side (the link's source). */
export interface IncomingLinkSummary extends LinkSummary {
  fromTypeId: string
  fromTypeApiName: string
  fromTypeDisplayName: string
}

export interface OntologyActionSummary {
  id: string
  apiName: string
  displayName: string
  operation: ActionOperation
  enabled: boolean
}

export interface OntologyObjectType {
  id: string
  apiName: string
  displayName: string
  description: string | null
  primaryKey: string
  icon: string | null
  color: string | null
  sourceDatasetId: string | null
  sourceDatasetName: string | null
  /** Latest backing-dataset version rowCount; null when no dataset/versions. */
  objectCount: number | null
  properties: OntologyProperty[]
  linksOut: OutgoingLinkSummary[]
  linksIn: IncomingLinkSummary[]
  actions: OntologyActionSummary[]
  createdAt: string
}

export interface OntologyListResponse {
  objectTypes: OntologyObjectType[]
}

export interface ObjectTypeResponse {
  objectType: OntologyObjectType
}

export interface SeedOntologyResponse {
  seeded: boolean
  created: string[]
}

export interface CreateObjectTypeResponse {
  objectType: OntologyObjectType
}

/** Minimal type meta used by objects endpoints. */
export interface ObjectsTypeMeta {
  id: string
  apiName: string
  displayName: string
  primaryKey: string
  icon: string | null
  color: string | null
  titleProperty: string | null
}

export interface ObjectRow {
  pk: string
  values: Record<string, unknown>
  _title: string
  /** M9 additive: apiNames whose values were masked for the current role. */
  _masked?: string[]
}

export interface ObjectsListResponse {
  objectType: ObjectsTypeMeta
  columns: OntologyProperty[]
  rows: ObjectRow[]
  total: number
  page: number
  pageSize: number
}

export interface LinkTarget {
  pk: string
  _title: string
}

export interface ObjectLink {
  id: string
  apiName: string
  displayName: string
  direction: LinkDirection
  cardinality: LinkCardinality
  toTypeId: string
  toTypeApiName: string
  toTypeDisplayName: string
  toTypeIcon: string | null
  toTypeColor: string | null
  targets: LinkTarget[]
}

export interface ObjectDetailResponse {
  objectType: ObjectsTypeMeta
  object: {
    pk: string
    values: Record<string, unknown>
    /** M9 additive: apiNames whose values were masked for the current role. */
    _masked?: string[]
  }
  links: ObjectLink[]
}

export interface ActionSummary {
  id: string
  apiName: string
  displayName: string
  description: string | null
  operation: ActionOperation
  enabled: boolean
  objectTypeId: string
  objectTypeApiName: string
  objectTypeDisplayName: string
  paramCount: number
}

export interface ActionsListResponse {
  actions: ActionSummary[]
}

export interface ActionLogEntry {
  id: string
  actionApiName: string
  actionDisplayName: string
  objectTypeDisplayName: string
  result: 'success' | 'failed'
  message: string
  objectPk: string | null
  versionNumber: number | null
  /** Coerced applied params — additive beyond the 3-a contract. */
  params: Record<string, unknown> | null
  createdAt: string
}

export interface ActionLogsResponse {
  logs: ActionLogEntry[]
}

export interface ActionParam {
  apiName: string
  displayName: string
  dataType: string
  required: boolean
  mapsTo: string
  isPk?: boolean
  oneOf?: string[]
}

export interface ActionDetail {
  id: string
  apiName: string
  displayName: string
  description: string | null
  operation: ActionOperation
  enabled: boolean
  parameters: ActionParam[]
  objectType: ObjectsTypeMeta
}

export interface ActionResponse {
  action: ActionDetail
}

export interface ApplyActionResponse {
  ok: boolean
  versionNumber: number
  rowCount: number
  objectPk: string | null
}

// ─── M9 Governance (Task 4-c contract) ───────────────────────────────

export type FoundryRole = 'viewer' | 'editor' | 'admin'
export type MarkingColor = 'rose' | 'amber' | 'teal' | 'zinc'

export interface SessionResponse {
  role: FoundryRole
  organizationId?: string | null
  organizationRole?: import('@/lib/permissions').OrganizationRole | null
  demoMode?: boolean
  /** M9 (additive): real-auth identity when a valid `foundry-session` cookie is present; null in simulator/anonymous mode. */
  session?: SessionUserInfo | null
}

export interface MarkedColumn {
  datasetId: string
  datasetName: string
  columnName: string
}

export interface Marking {
  id: string
  name: string
  description: string | null
  color: MarkingColor
  minRole: FoundryRole
  createdAt: string
  columns: MarkedColumn[]
}

export interface MarkingsListResponse {
  markings: Marking[]
}

export interface MarkingResponse {
  marking: Marking
}

export interface MarkedCountResponse {
  marked: number
}

export interface UnmarkedCountResponse {
  unmarked: number
}

export type ApprovalKind = 'publish_dataset' | 'publish_pipeline'
export type ApprovalStatus = 'pending' | 'approved' | 'rejected'

export interface ApprovalRequest {
  id: string
  kind: ApprovalKind
  targetId: string
  targetName: string
  requestedBy: string
  note: string | null
  status: ApprovalStatus
  decidedBy: string | null
  decidedAt: string | null
  decisionNote: string | null
  createdAt: string
  /** P2 carryover, additive: live publication-gate status for PENDING
   *  publish_dataset requests (null/absent for everything else). Lets the
   *  admin see WHY a publish would be blocked BEFORE deciding. */
  publishPreview?: PublishGatePreview | null
}

/** Live publication-gate read-out for one pending publish_dataset request. */
export interface PublishGatePreview {
  status: 'blocked' | 'ready' | 'no_draft' | 'ungated'
  gateOn: boolean
  draftVersion: number | null
  qualityState: string | null
  /** Failing error-severity rules (only when status === 'blocked'). */
  failing: { name: string; message: string | null }[]
}

export interface ApprovalsListResponse {
  approvals: ApprovalRequest[]
}

export interface ApprovalResponse {
  approval: ApprovalRequest
}

export type AuditActorRole = 'system' | FoundryRole
export type AuditResourceType =
  | 'dataset'
  | 'pipeline'
  | 'connector'
  | 'marking'
  | 'approval'
  | 'ontology'
  | 'schedule'
  | 'transform'
  | 'project'
  | 'apiToken'
  | 'user'

export interface AuditEntry {
  id: string
  actorRole: AuditActorRole
  /** M9 (additive): user email when the actor was a real (session) user; null for simulator/machine actors. */
  actorEmail?: string | null
  action: string
  resourceType: string
  resourceId: string | null
  resourceName: string | null
  detail: string | null
  createdAt: string
}

export interface AuditListResponse {
  entries: AuditEntry[]
}

/** Server-side masked-cell literal (6 dashes, mono-friendly). */
export const MASK_LITERAL = '------'

// ─── M4 Code transforms (Task 5-a contract) ──────────────────────────

export type TransformLanguage = 'sql' | 'javascript' | 'python'
export type TransformRunStatus = 'running' | 'success' | 'failed'

/** One configured input: dataset id + resolved name (null when the dataset was deleted). */
export interface TransformInputRef {
  datasetId: string
  datasetName: string | null
}

export interface TransformRunSummary {
  id: string
  transformId: string
  status: TransformRunStatus
  logs: RunLog[]
  durationMs: number | null
  rowCount: number | null
  outputDatasetId: string | null
  outputVersionNumber: number | null
  error: string | null
  startedAt: string
  finishedAt: string | null
  hasManifest?: boolean
  replayOfRunId?: string | null
}

export interface TransformSummary {
  id: string
  name: string
  description: string | null
  language: TransformLanguage
  sourceCode: string
  inputs: TransformInputRef[]
  outputDatasetName: string
  createdAt: string
  updatedAt: string
  runsCount: number
  latestRun: {
    id: string
    status: string
    rowCount: number | null
    durationMs: number | null
    finishedAt: string | null
    error: string | null
  } | null
}

export interface TransformsListResponse {
  transforms: TransformSummary[]
}

export interface TransformResponse {
  transform: TransformSummary
}

export interface TransformDetailResponse {
  transform: TransformSummary
  /** Last 10 runs, latest first. */
  runs: TransformRunSummary[]
}

/**
 * POST /api/transforms/[id]/run — ALWAYS 200, even when the run failed
 * (UI renders run.logs / run.error). preview = first 20 published output
 * rows ([] on failure); schema = output dataset version columns.
 */
export interface TransformRunResponse {
  run: TransformRunSummary
  preview: Record<string, unknown>[]
  schema: ColumnDef[]
}

export interface TransformRunsListResponse {
  /** Latest first (GET /api/transforms/[id]/runs?limit=20). */
  runs: TransformRunSummary[]
}

export interface SeedTransformsResponse {
  seeded: boolean
  created: string[]
  skipped: string[]
}

/** POST /api/datasets/[id]/prune response. */
export interface PruneResponse {
  pruned: number
  remaining: number
}

/** Project as returned by GET /api/projects (counts resolved server-side). */
export interface FoundryProject {
  id: string
  name: string
  description: string | null
  datasetsCount: number
  pipelinesCount: number
  createdAt: string
  updatedAt: string
}

export interface ProjectsListResponse {
  projects: FoundryProject[]
}

/** POST /api/projects response (no counts yet). */
export interface CreateProjectResponse {
  project: {
    id: string
    name: string
    description: string | null
    createdAt: string
    updatedAt: string
  }
}

/** PATCH /api/projects/[id] response (project without timestamps). */
export interface ProjectMutationResponse {
  project: {
    id: string
    name: string
    description: string | null
    datasetsCount: number
    pipelinesCount: number
  }
}

// ─── M10 Platform API (Task 6-b contract) ────────────────────────────

export const V1_API_VERSION = 'v1'
export const V1_RATE_LIMIT_PER_MINUTE = 60

/** API token as listed by GET /api/tokens — NEVER carries the hash or secret. */
export interface ApiTokenInfo {
  id: string
  name: string
  /** First 12 chars of the secret (mf_live_XXX) — safe to display. */
  prefix: string
  requestCount: number
  lastUsedAt: string | null
  revokedAt: string | null
  createdAt: string
}

export interface TokensListResponse {
  tokens: ApiTokenInfo[]
}

export interface CreateTokenResponse {
  token: {
    id: string
    name: string
    prefix: string
    createdAt: string
  }
  /** Plaintext `mf_live_...` secret — shown EXACTLY ONCE, never stored. */
  secret: string
}

export interface V1WhoamiResponse {
  token: {
    name: string
    prefix: string
    createdAt: string
    lastUsedAt: string | null
    requestCount: number
  }
  api: { version: 'v1'; rateLimitPerMinute: number }
}

/** 1-based pagination block used by every v1 list envelope. */
export interface V1Pagination {
  page: number
  pageSize: number
  total: number
  totalPages: number
}

export interface V1DatasetSummary {
  id: string
  name: string
  description: string | null
  tags: string[]
  projectId: string | null
  latestVersion: { versionNumber: number; rowCount: number; createdAt: string } | null
  updatedAt: string
}

export interface V1DatasetsResponse {
  data: V1DatasetSummary[]
  pagination: V1Pagination
}

export interface V1DatasetDetailResponse {
  dataset: {
    id: string
    name: string
    description: string | null
    tags: string[]
    projectId: string | null
    keepLastN: number
    version: {
      versionNumber: number
      /** Columns carry additive markedWith (marking name | null). */
      schema: ColumnDef[]
      rowCount: number
      createdAt: string
    }
  }
  versions: { versionNumber: number; rowCount: number; createdAt: string }[]
}

export interface V1RowsResponse {
  data: Record<string, unknown>[]
  pagination: V1Pagination
  version: { versionNumber: number; rowCount: number }
  /** Columns masked for API tokens (viewer role). */
  maskedColumns: string[]
}

/** Same serialized object types as the session-authed /api/ontology. */
export interface V1OntologyResponse {
  objectTypes: OntologyObjectType[]
  /** Every action flattened across types, tagged with its owner type. */
  actions: Array<
    OntologyActionSummary & {
      objectType: { id: string; apiName: string; displayName: string }
    }
  >
}

/** Object row as served by v1 (same fields as the session objects endpoint). */
export interface V1ObjectRow {
  pk: unknown
  values: Record<string, unknown>
  _title: unknown
  _masked: string[]
}

export interface V1ObjectsResponse {
  data: V1ObjectRow[]
  pagination: V1Pagination
  objectType: ObjectsTypeMeta
  columns: OntologyProperty[]
}

export interface V1ObjectResponse {
  object: {
    pk: unknown
    values: Record<string, unknown>
    _masked: string[]
  }
}

export interface V1PipelineSummary {
  id: string
  name: string
  description: string | null
  nodeCount: number
  lastRun: { status: string; startedAt: string } | null
  updatedAt: string
}

export interface V1PipelinesResponse {
  data: V1PipelineSummary[]
  pagination: V1Pagination
}

export interface V1PipelineResponse {
  pipeline: {
    id: string
    name: string
    description: string | null
    /** Graph nodes array (graph.nodes). */
    nodes: GraphNode[]
    /** Full graph for convenience (nodes + edges). */
    graph: PipelineGraph
    /** 5 latest run summaries, latest first (no logs). */
    lastRuns: Array<{
      id: string
      status: string
      startedAt: string
      finishedAt: string | null
    }>
  }
}

// ─── M9 Real users & auth (Task 7-b contract) ────────────────────────

/** Login/me identity shape — passwordHash NEVER leaves the server. */
export interface AuthUser {
  id: string
  email: string
  name: string
  role: FoundryRole
  organizationId: string
  organizationRole: import('@/lib/permissions').OrganizationRole
  lastLoginAt: string | null
}

/** Real-auth identity inside GET /api/session (additive `session` field). */
export interface SessionUserInfo {
  email: string
  name: string
  /** Legacy service permission level, NOT the organization membership role. */
  role: FoundryRole
  organizationId?: string | null
  organizationRole?: import('@/lib/permissions').OrganizationRole | null
  /** M9 impersonation (additive): EFFECTIVE role — differs from `role` only while an admin impersonates. */
  effectiveRole?: FoundryRole
  /** M9 impersonation (additive): true while the session carries a role override. */
  impersonating?: boolean
}

export interface LoginResponse {
  user: AuthUser
}

export interface MeResponse {
  authenticated: boolean
  user?: AuthUser
}

/** Admin view of a user (GET /api/users, PATCH /api/users/[id]). */
export interface AdminUser {
  id: string
  email: string
  name: string
  role: FoundryRole
  isActive: boolean
  lastLoginAt: string | null
  createdAt: string
}

export interface UsersListResponse {
  users: AdminUser[]
}

export interface UserMutationResponse {
  user: AdminUser
}

/** POST /api/session/role — same contract as before (M9 may add 403 for session non-admins). */
export interface RoleSwitchResponse {
  role: FoundryRole
}

// ─── M10.1 API usage (Task 8-b contract) ─────────────────────────────

/** One zero-filled hour of the byHour series (UTC hour boundary). */
export interface ApiUsageBucket {
  /** '2026-10-02T19:00' — bucket start, UTC. */
  hourIso: string
  count: number
  /** 4xx+5xx requests in this bucket (429 included). */
  errors: number
}

/** Per-token usage joined in memory by id — logs survive token deletion. */
export interface ApiUsageToken {
  tokenId: string
  /** '(deleted token)' when the id no longer exists in ApiToken. */
  name: string
  /** null for deleted tokens (name is displayable, prefix is not). */
  prefix: string | null
  count: number
  lastSeen: string
}

/** Templated route usage — placeholders, NEVER raw ids/pks. */
export interface ApiUsageRoute {
  route: string
  count: number
}

/** One non-2xx request from the dashboard tail (newest first). */
export interface ApiUsageError {
  id: string
  route: string
  status: number
  tokenId: string
  createdAt: string
}

/** GET /api/tokens/usage — 24h usage dashboard payload. */
export interface ApiUsageResponse {
  /** Always 24 today (the endpoint always returns exactly this many buckets). */
  windowHours: number
  total: number
  /** 2xx count. */
  ok: number
  /** 4xx+5xx count (429 included). */
  errors: number
  /** 429 count. */
  limited: number
  /** null when there is no traffic in the window. */
  avgDurationMs: number | null
  /** Exactly windowHours buckets, zero-filled, oldest → newest. */
  byHour: ApiUsageBucket[]
  /** Sorted count desc. */
  byToken: ApiUsageToken[]
  /** Top 6 templated routes, count desc. */
  topRoutes: ApiUsageRoute[]
  /** Last 10 non-2xx, newest first. */
  recentErrors: ApiUsageError[]
}

/** POST /api/tokens/usage/seed — demo traffic inserted. */
export interface ApiUsageSeedResponse {
  seeded: number
}

/** DELETE /api/tokens/usage — all request logs cleared. */
export interface ApiUsageClearResponse {
  pruned: number
}

// ─── M3.1 pipeline versions (Task 9-b contract) ─────────────────────

/** One entry of GET /api/pipelines/[id]/versions (desc by versionNumber). */
export interface PipelineVersionSummary {
  versionNumber: number
  nodeCount: number
  note: string | null
  createdBy: string | null
  createdAt: string
  /** Runs pinned to this version (pre-versioning runs count nowhere). */
  runCount: number
}

export interface PipelineVersionsResponse {
  versions: PipelineVersionSummary[]
}

/** GET /api/pipelines/[id]/versions/[version] — one snapshot with its parsed graph. */
export interface PipelineVersionDetail {
  versionNumber: number
  nodeCount: number
  note: string | null
  createdBy: string | null
  createdAt: string
  graph: PipelineGraph | null
}

export interface PipelineVersionResponse {
  version: PipelineVersionDetail
}

/** POST /api/pipelines/[id]/restore — pipeline payload mirrors PUT/PATCH + new snapshot. */
export interface RestorePipelineResponse {
  pipeline: PipelineDetail
  version: {
    versionNumber: number
    nodeCount: number
    note: string | null
    createdBy: string | null
    createdAt: string
  }
}

// ─── Misc helpers ────────────────────────────────────────────────────

export interface SeedResponse {
  seeded: boolean
  datasets: string[]
  /** M9 (additive): demo users ensured during this seed call. */
  usersEnsured?: number
}

export interface CreatePipelineResponse {
  pipeline: PipelineDetail
}

export function shortId(id: string | null | undefined, len = 8): string {
  if (!id) return '—'
  return id.length <= len ? id : id.slice(0, len)
}

export function formatDuration(startedAt: string, finishedAt: string | null): string {
  if (!finishedAt) return '—'
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime()
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m ${s}s`
}

/** Strict relative time ("3m ago") for data-UI timestamps; '—' for null/invalid. */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return formatDistanceToNowStrict(d, { addSuffix: true })
}

/** "every 10m" / "every 1h" / "every 1d" — human label for schedule intervals. */
export function formatInterval(minutes: number): string {
  if (minutes >= 1440 && minutes % 1440 === 0) return `every ${minutes / 1440}d`
  if (minutes >= 60 && minutes % 60 === 0) return `every ${minutes / 60}h`
  return `every ${minutes}m`
}

// Data-freshness thresholds (Task 2-c spec): fresh < 15m, aging < 2h, else stale.
export const FRESH_THRESHOLD_MINUTES = 15
export const STALE_THRESHOLD_MINUTES = 120

export type FreshnessLevel = 'fresh' | 'aging' | 'stale'

export function freshnessLevel(freshnessMinutes: number): FreshnessLevel {
  if (freshnessMinutes < FRESH_THRESHOLD_MINUTES) return 'fresh'
  if (freshnessMinutes < STALE_THRESHOLD_MINUTES) return 'aging'
  return 'stale'
}

// ─── Task 12-a settings/reset contract ───────────────────────────────

/** GET /api/settings/overview — platform-wide counts for the Settings page. */
export interface WorkspaceOverview {
  projects: number
  connectors: number
  datasets: number
  datasetVersions: number
  pipelines: number
  pipelineVersions: number
  pipelineRuns: number
  schedules: number
  transforms: number
  transformRuns: number
  objectTypes: number
  properties: number
  linkTypes: number
  actions: number
  actionLogs: number
  markings: number
  columnMarkings: number
  approvalRequests: number
  /** Subset of approvalRequests with status 'pending'. */
  pendingApprovals: number
  auditEntries: number
  apiTokens: number
  /** Subset of apiTokens without revokedAt. */
  activeTokens: number
  apiRequestLogs: number
  users: number
}

/** POST /api/settings/reset — wipe result; per-model deleted-row counts (zeros included). */
export interface ResetResponse {
  resetAt: string
  counts: Record<string, number>
}

// ════════════════════════════════════════════════════════════════════
// Task 14 shared contracts (branches, quality, triggers, writeback,
// dashboards, object views, ACLs, notifications, search)
// Owner: orchestrator — sub-agents must NOT edit this section; define
// component-local types locally instead.
// ════════════════════════════════════════════════════════════════════

/** R14 dataset branch (named pointer to a head version on a commit line). */
export interface DatasetBranchInfo {
  id: string
  datasetId: string
  name: string
  baseVersion: number
  headVersion: number
  mergedAt: string | null
  mergedInto: number | null
  description: string | null
  createdBy: string | null
  createdAt: string
}

/** GET /api/datasets/[id]/branches — branch list + main head. */
export interface DatasetBranchesResponse {
  branches: DatasetBranchInfo[]
  mainHead: number
}

/** POST /api/datasets/[id]/branches — create branch. */
export interface CreateBranchRequest {
  name: string
  description?: string
  /** version to branch from; defaults to main head */
  baseVersion?: number
}
export type CreateBranchResponse = DatasetBranchInfo

/** POST /api/datasets/[id]/branches/[branchId]/merge — merge result. */
export interface MergeBranchResponse {
  mergedVersion: number
  rowsMerged: number
  branchName: string
}

/** R14 version diff. */
export interface VersionDiffResponse {
  datasetId: string
  fromVersion: number
  toVersion: number
  schema: {
    added: { name: string; type: string }[]
    removed: { name: string; type: string }[]
    changed: { name: string; fromType: string; toType: string }[]
  }
  rowCount: { from: number; to: number }
  /** rows whose PK-ish (first column) value is only in toVersion */
  addedRows: Record<string, unknown>[]
  /** rows only in fromVersion */
  removedRows: Record<string, unknown>[]
  /** rows with same key but different values */
  changedRows: { key: string; before: Record<string, unknown>; after: Record<string, unknown> }[]
  truncated: boolean
}

/** R14 data quality. */
export type QualityRuleKind =
  | 'not_null'
  | 'unique'
  | 'range'
  | 'allowed_values'
  | 'regex'
  | 'freshness'
  | 'row_count_min'

export interface QualityRuleInfo {
  id: string
  datasetId: string
  name: string
  kind: QualityRuleKind
  column: string | null
  config: Record<string, unknown>
  severity: 'warn' | 'error'
  enabled: boolean
  createdAt: string
}

export interface QualityResultInfo {
  id: string
  ruleId: string
  datasetId: string
  versionNumber: number
  passed: boolean
  actual: string | null
  message: string | null
  trigger: string
  createdAt: string
}

/** GET /api/datasets/[id]/quality — rules + latest result per rule. */
export interface DatasetQualityResponse {
  rules: (QualityRuleInfo & { lastResult: QualityResultInfo | null })[]
  lastEvaluatedAt: string | null
}

/** POST /api/datasets/[id]/quality/evaluate — run all enabled rules. */
export interface EvaluateQualityResponse {
  qualityState?: 'not_evaluated' | 'passed' | 'warned' | 'failed'
  versionNumber: number
  results: { ruleName: string; kind: string; passed: boolean; actual: string | null; message: string | null; severity: string }[]
  passed: number
  failed: number
}

/** R14 pipeline trigger/retry fields (embedded in pipeline payloads). */
export interface PipelineTriggerConfig {
  triggerMode: 'manual' | 'upstream'
  upstreamDatasetIds: string[]
  maxRetries: number
}

/** R14 dashboard widget + dashboard payloads. */
export type DashboardWidgetType = 'bar' | 'line' | 'pie' | 'area' | 'stat' | 'table'

export interface DashboardWidget {
  id: string
  type: DashboardWidgetType
  title: string
  /** Legacy widgets omit sourceType and are treated as dataset-backed. */
  sourceType?: 'dataset' | 'objectType'
  datasetId?: string
  datasetName?: string
  objectTypeId?: string
  objectTypeName?: string
  config: {
    groupBy?: string
    valueColumn?: string
    agg?: 'count' | 'sum' | 'avg' | 'min' | 'max'
    topN?: number
    sortDir?: 'asc' | 'desc'
    /** stat widget: property to aggregate; omit = row count */
  }
  /** grid span on large screens: 1 or 2 columns */
  span?: 1 | 2
}

export interface DashboardInfo {
  id: string
  title: string
  description: string | null
  widgets: DashboardWidget[]
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

export interface DashboardListResponse {
  dashboards: (Pick<DashboardInfo, 'id' | 'title' | 'description' | 'createdAt' | 'updatedAt'> & { widgetCount: number })[]
}

/** POST /api/dashboards/[id]/data — server-side aggregation for widgets. */
export interface WidgetDataRequest {
  widget: DashboardWidget
}
export interface WidgetDataResponse {
  /** bar/line/pie/area: [{ name, value }]; stat: [{ name: 'value', value }]; table: raw rows */
  rows: Record<string, unknown>[]
  datasetName: string
  sourceName?: string
  sourceType?: 'dataset' | 'objectType'
  rowCount: number
  error?: string
}

// ─── Applications (Workshop-style operational apps) ──────────────────
//
// Apps bind widgets to Ontology object types + actions BY apiName (stable
// across re-seeded workspaces). The whole app definition lives in one JSON
// config; widgets render over rows fetched from /api/objects with the app's
// global filters applied, and object selection is shared app-wide (map
// marker / table row → detail panel with links + actions).

/** Grid span on large screens (3-column canvas). */
export type AppWidgetSpan = 1 | 2 | 3
export type AppMapMode = 'markers' | 'cluster' | 'heatmap'
export type AppWidgetType = 'map' | 'objectTable' | 'stat' | 'actionButton' | 'chart'

export interface AppSection { id: string; title: string }
export interface AppPage { id: string; title: string; sections: AppSection[] }

export interface AppWidgetPlacement {
  /** Missing placement on pre-pages apps resolves to the first page/section. */
  pageId?: string
  sectionId?: string
}

/** One object-type layer rendered on a map widget. */
export interface AppMapLayerConfig {
  id: string
  objectTypeApiName: string
  visible: boolean
  /** Number property holding latitude; null = auto-detect by name. */
  latProperty?: string | null
  /** Number property holding longitude; null = auto-detect by name. */
  lngProperty?: string | null
  /** String property for offline centroid geocoding (e.g. 'city', 'country'); null = auto-detect. */
  fallbackProperty?: string | null
  /** Categorical property driving marker color; null = object-type accent. */
  colorBy?: string | null
  /** Numeric property driving marker size / heatmap weight. */
  sizeBy?: string | null
}

export interface AppMapWidget extends AppWidgetPlacement {
  id: string
  type: 'map'
  title: string
  layers: AppMapLayerConfig[]
  mapMode: AppMapMode
  span: AppWidgetSpan
}

export interface AppTableWidget extends AppWidgetPlacement {
  id: string
  type: 'objectTable'
  title: string
  objectTypeApiName: string
  /** Property apiNames to show; null/empty = sensible defaults. */
  columns?: string[] | null
  span: AppWidgetSpan
}

export interface AppStatWidget extends AppWidgetPlacement {
  id: string
  type: 'stat'
  title: string
  objectTypeApiName: string
  agg: 'count' | 'sum' | 'avg' | 'min' | 'max'
  /** Property aggregated by sum/avg/min/max; ignored for count. */
  valueProperty?: string | null
  span: AppWidgetSpan
}

export interface AppActionWidget extends AppWidgetPlacement {
  id: string
  type: 'actionButton'
  title: string
  actionApiName: string
  /** Pre-fill the action's pk parameter from the app's selected object. */
  useSelection: boolean
  span: AppWidgetSpan
}

export interface AppChartWidget extends AppWidgetPlacement {
  id: string
  type: 'chart'
  title: string
  objectTypeApiName: string
  chartType: 'bar' | 'line' | 'area' | 'pie'
  groupBy: string
  agg: 'count' | 'sum' | 'avg' | 'min' | 'max'
  valueProperty?: string | null
  topN: number
  span: AppWidgetSpan
}

export type AppWidget = AppMapWidget | AppTableWidget | AppStatWidget | AppActionWidget | AppChartWidget

export type AppFilterOp = 'eq' | 'neq' | 'contains' | 'gt' | 'lt' | 'gte' | 'lte'

/** App-level global filter definition; the runtime value lives in UI state. */
export interface AppFilterDef {
  id: string
  /** Object type apiName this filter constrains; '*' = any type having `property`. */
  objectTypeApiName: string
  property: string
  op: AppFilterOp
  kind: 'text' | 'number' | 'select'
  /** Options for kind='select' (stored on the definition, not fetched). */
  options: string[]
  label: string | null
}

export interface AppConfig {
  pages: AppPage[]
  widgets: AppWidget[]
  filters: AppFilterDef[]
}

export interface ApplicationSummary {
  id: string
  name: string
  description: string | null
  widgetCount: number
  /** Object type apiNames referenced by the app's widgets/layers/filters. */
  objectTypeApiNames: string[]
  createdAt: string
  updatedAt: string
}

export interface ApplicationsListResponse {
  applications: ApplicationSummary[]
}

export interface ApplicationInfo {
  id: string
  name: string
  description: string | null
  config: AppConfig
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

export interface ApplicationResponse {
  application: ApplicationInfo
}

/** Shared app-wide selection: which object the detail panel shows. */
export interface AppObjectRef {
  objectTypeApiName: string
  pk: string
}

/** Template bodies accepted by POST /api/applications. */
export type ApplicationTemplate = 'blank' | 'supply-chain'

/** R14 saved object views. */
export interface ObjectViewInfo {
  id: string
  objectTypeId: string
  name: string
  filters: { property: string; op: 'eq' | 'neq' | 'contains' | 'gt' | 'lt' | 'gte' | 'lte' | 'in'; value: string }[]
  sortBy: string | null
  sortDir: 'asc' | 'desc'
  createdBy: string | null
  createdAt: string
}

/** R14 ACL payloads. */
export interface ResourceAclInfo {
  id: string
  resourceType: string
  resourceId: string
  userEmail: string
  level: 'viewer' | 'editor' | 'owner'
  grantedBy: string | null
  createdAt: string
}

export interface ResourceAclListResponse {
  acls: ResourceAclInfo[]
}

/** GET /api/acl/check?resourceType=&resourceId= — caller's effective level. */
export interface AclCheckResponse {
  level: 'viewer' | 'editor' | 'owner'
}

/** R14 notification payloads. */
export interface NotificationInfo {
  id: string
  userEmail: string | null
  type: string
  title: string
  body: string | null
  resourceType: string | null
  resourceId: string | null
  href: string | null
  readAt: string | null
  createdAt: string
}

export interface NotificationListResponse {
  notifications: NotificationInfo[]
  unreadCount: number
}

/** GET /api/search?q= — global platform search results. */
export interface SearchResultItem {
  type: 'dataset' | 'pipeline' | 'transform' | 'objectType' | 'object' | 'application' | 'dashboard' | 'connector'
  id: string
  title: string
  subtitle: string | null
  href: string
}

export interface SearchResponse {
  results: SearchResultItem[]
}

// ─── P2: Trust workflow (publication gate + version lineage) ─────────

/** POST /api/datasets/[id]/publish — publish a draft version. */
export interface PublishResponse {
  datasetId: string
  datasetName: string
  versionNumber: number
  qualityState: string
  publishedVersion: number
}

/** GET /api/lineage/impact?datasetId= — transitive downstream impact. */
export interface ImpactItem {
  id: string
  name: string
  depth: number
  viaPipelineId: string | null
  viaPipelineName: string | null
  headVersion: number
  rowCount: number
  gated: boolean
}

export interface LineageImpactResponse {
  root: { id: string; name: string; headVersion: number }
  affected: ImpactItem[]
  total: number
  maxDepth: number
}

/** GET /api/lineage/versions?datasetId=&versionNumber= — version-level edges. */
export interface VersionLineageEdgeInfo {
  fromDatasetId: string
  fromDatasetName: string
  fromVersionNumber: number
  toDatasetId: string
  toDatasetName: string
  toVersionNumber: number
  runId: string | null
  runTrigger: string | null
  runStatus: string | null
  startedAt: string | null
  pipelineId: string | null
  pipelineName: string | null
  direction: 'up' | 'down'
}

export interface VersionLineageResponse {
  datasetId: string
  datasetName: string
  versionNumber: number
  upstream: VersionLineageEdgeInfo[]
  downstream: VersionLineageEdgeInfo[]
}
