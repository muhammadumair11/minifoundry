//! Shared service state + DB row models + legacy-exact serializers.

use chrono::{DateTime, Utc};
use mf_auth::RuntimeMode;
use mf_types::SchemaColumn;
use serde_json::{json, Value};
use sqlx::types::Json;
use sqlx::PgPool;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub nats: async_nats::Client,
    pub mode: Arc<RuntimeMode>,
    /// Governance internal client (column markings, publication approvals).
    pub governance: mf_internal::ServiceClient,
    /// Orchestration internal client (best-effort pipeline/run display names).
    pub orchestration: mf_internal::ServiceClient,
    /// Row cap for learning-scale dataset versions (MAX_ROWS env, default 5000).
    pub max_rows: usize,
}

impl AppState {
    pub async fn from_env(db: PgPool, nats: async_nats::Client) -> anyhow::Result<Self> {
        let max_rows = std::env::var("MAX_ROWS")
            .ok()
            .and_then(|v| v.trim().parse::<usize>().ok())
            .filter(|n| *n > 0)
            .unwrap_or(5000);
        Ok(Self {
            db,
            nats,
            mode: Arc::new(RuntimeMode::from_env()),
            governance: mf_internal::ServiceClient::from_env(
                "governance",
                "GOVERNANCE_INTERNAL_URL",
                8086,
            ),
            orchestration: mf_internal::ServiceClient::from_env(
                "orchestration",
                "ORCHESTRATION_INTERNAL_URL",
                8083,
            ),
            max_rows,
        })
    }
}

// ─── DB rows ────────────────────────────────────────────────────────────

pub const PROJECT_COLS: &str = "id, name, description, created_at, updated_at";

#[derive(Debug, sqlx::FromRow)]
pub struct ProjectRow {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

pub const CONNECTOR_COLS: &str =
    "id, name, type AS ctype, config, created_at, updated_at";

#[derive(Debug, sqlx::FromRow)]
pub struct ConnectorRow {
    pub id: String,
    pub name: String,
    pub ctype: String,
    /// JSON text (insertion-ordered round-trip; legacy stored a JSON string).
    pub config: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

pub const INGESTION_COLS: &str =
    "id, connector_id, dataset_id, status, message, rows_ingested, started_at, finished_at";

#[derive(Debug, sqlx::FromRow)]
pub struct IngestionRow {
    pub id: String,
    pub connector_id: Option<String>,
    pub dataset_id: Option<String>,
    pub status: String,
    pub message: Option<String>,
    pub rows_ingested: i32,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
}

pub const DATASET_COLS: &str = "id, name, description, project_id, source_connector_id, tags, \
     keep_last_n, quality_gate, published_version, created_at, updated_at";

#[derive(Debug, sqlx::FromRow)]
pub struct DatasetRow {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub project_id: Option<String>,
    pub source_connector_id: Option<String>,
    pub tags: Json<Vec<String>>,
    pub keep_last_n: i32,
    pub quality_gate: bool,
    pub published_version: Option<i32>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

pub const VERSION_COLS: &str = "id, dataset_id, version_number, schema_json, row_count, data_json, \
     created_by, output_job_id, created_at, branch, parent_version, lifecycle, quality_state, \
     quality_summary_json";

#[derive(Debug, sqlx::FromRow)]
#[allow(dead_code)] // decoded for row fidelity; not every field is serialized
pub struct VersionRow {
    pub id: String,
    pub dataset_id: String,
    pub version_number: i32,
    pub schema_json: Json<Vec<SchemaColumn>>,
    pub row_count: i32,
    /// JSON text of the row array (insertion-ordered rows; see migration notes).
    pub data_json: String,
    pub created_by: Option<String>,
    pub output_job_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub branch: String,
    pub parent_version: Option<i32>,
    pub lifecycle: String,
    pub quality_state: Option<String>,
    pub quality_summary_json: Option<Json<Value>>,
}

/// Head-version aggregate used by the dataset list (no data_json payload).
#[derive(Debug, sqlx::FromRow)]
pub struct VersionHeadRow {
    pub dataset_id: String,
    pub version_number: i32,
    pub row_count: i32,
    pub schema_json: Json<Vec<SchemaColumn>>,
}

/// Slim version row for the detail payload (versions list).
#[derive(Debug, sqlx::FromRow)]
pub struct VersionMetaRow {
    pub id: String,
    pub version_number: i32,
    pub row_count: i32,
    pub created_by: Option<String>,
    pub created_at: DateTime<Utc>,
    pub schema_json: Json<Vec<SchemaColumn>>,
    pub branch: String,
    pub lifecycle: String,
    pub quality_state: Option<String>,
}

pub const BRANCH_COLS: &str = "id, dataset_id, name, base_version, head_version, merged_at, \
     merged_into, description, created_by, created_at";

#[derive(Debug, sqlx::FromRow)]
pub struct BranchRow {
    pub id: String,
    pub dataset_id: String,
    pub name: String,
    pub base_version: i32,
    pub head_version: i32,
    pub merged_at: Option<DateTime<Utc>>,
    pub merged_into: Option<i32>,
    pub description: Option<String>,
    pub created_by: Option<String>,
    pub created_at: DateTime<Utc>,
}

pub const RULE_COLS: &str =
    "id, dataset_id, name, kind, column_name, config_json, severity, enabled, created_at";

#[derive(Debug, sqlx::FromRow)]
pub struct RuleRow {
    pub id: String,
    pub dataset_id: String,
    pub name: String,
    pub kind: String,
    pub column_name: Option<String>,
    pub config_json: Json<Value>,
    pub severity: String,
    pub enabled: bool,
    pub created_at: DateTime<Utc>,
}

pub const RESULT_COLS: &str =
    "id, rule_id, dataset_id, version_number, passed, actual, message, trigger, created_at";

#[derive(Debug, sqlx::FromRow)]
pub struct ResultRow {
    pub id: String,
    pub rule_id: String,
    pub dataset_id: String,
    pub version_number: i32,
    pub passed: bool,
    pub actual: Option<String>,
    pub message: Option<String>,
    pub trigger: String,
    pub created_at: DateTime<Utc>,
}

pub const COMMENT_COLS: &str =
    "id, dataset_id, version_number, author_key, author_label, author_role, body, created_at";

#[derive(Debug, sqlx::FromRow)]
pub struct CommentRow {
    pub id: String,
    pub dataset_id: String,
    pub version_number: Option<i32>,
    pub author_key: String,
    pub author_label: String,
    pub author_role: String,
    pub body: String,
    pub created_at: DateTime<Utc>,
}

pub const LINEAGE_EDGE_COLS: &str =
    "id, from_dataset_id, to_dataset_id, pipeline_id, created_at";

#[derive(Debug, sqlx::FromRow)]
#[allow(dead_code)] // decoded for row fidelity
pub struct LineageEdgeRow {
    pub id: String,
    pub from_dataset_id: String,
    pub to_dataset_id: String,
    pub pipeline_id: Option<String>,
    pub created_at: DateTime<Utc>,
}

pub const VERSION_LINEAGE_EDGE_COLS: &str = "id, run_id, pipeline_id, transform_run_id, \
     transform_id, from_dataset_id, from_version_number, to_dataset_id, to_version_number, created_at";

#[derive(Debug, sqlx::FromRow)]
#[allow(dead_code)] // decoded for row fidelity
pub struct VersionLineageEdgeRow {
    pub id: String,
    pub run_id: Option<String>,
    pub pipeline_id: Option<String>,
    pub transform_run_id: Option<String>,
    pub transform_id: Option<String>,
    pub from_dataset_id: String,
    pub from_version_number: i32,
    pub to_dataset_id: String,
    pub to_version_number: i32,
    pub created_at: DateTime<Utc>,
}

// ─── Serializers (exact legacy shapes — see api-utils.ts / branching.ts) ──

pub fn ts(dt: &DateTime<Utc>) -> Value {
    Value::String(mf_types::ts::format(dt))
}

pub fn ts_opt(dt: &Option<DateTime<Utc>>) -> Value {
    match dt {
        Some(d) => ts(d),
        None => Value::Null,
    }
}

/// serializeDatasetSummary — pass the head version (latest first) when known.
pub fn serialize_dataset_summary(
    d: &DatasetRow,
    head: Option<(&i32, &i32, &[SchemaColumn])>,
    versions_count: i64,
) -> Value {
    let current = match head {
        Some((version_number, row_count, schema)) => json!({
            "versionNumber": version_number,
            "rowCount": row_count,
            "columnCount": schema.len(),
        }),
        None => Value::Null,
    };
    json!({
        "id": d.id,
        "name": d.name,
        "description": d.description,
        "projectId": d.project_id,
        "sourceConnectorId": d.source_connector_id,
        "tags": d.tags.0,
        "createdAt": ts(&d.created_at),
        "updatedAt": ts(&d.updated_at),
        "currentVersion": current,
        "versionsCount": versions_count,
    })
}

/// serializeBranch (branching.ts).
pub fn serialize_branch(b: &BranchRow) -> Value {
    json!({
        "id": b.id,
        "datasetId": b.dataset_id,
        "name": b.name,
        "baseVersion": b.base_version,
        "headVersion": b.head_version,
        "mergedAt": ts_opt(&b.merged_at),
        "mergedInto": b.merged_into,
        "description": b.description,
        "createdBy": b.created_by,
        "createdAt": ts(&b.created_at),
    })
}

/// serializeRule (quality route).
pub fn serialize_rule(r: &RuleRow) -> Value {
    json!({
        "id": r.id,
        "datasetId": r.dataset_id,
        "name": r.name,
        "kind": r.kind,
        "column": r.column_name,
        "config": r.config_json.0,
        "severity": r.severity,
        "enabled": r.enabled,
        "createdAt": ts(&r.created_at),
    })
}

/// serializeResult (quality route).
pub fn serialize_result(r: &ResultRow) -> Value {
    json!({
        "id": r.id,
        "ruleId": r.rule_id,
        "datasetId": r.dataset_id,
        "versionNumber": r.version_number,
        "passed": r.passed,
        "actual": r.actual,
        "message": r.message,
        "trigger": r.trigger,
        "createdAt": ts(&r.created_at),
    })
}

/// Comment shape (comments route).
pub fn serialize_comment(c: &CommentRow) -> Value {
    json!({
        "id": c.id,
        "datasetId": c.dataset_id,
        "versionNumber": c.version_number,
        "authorKey": c.author_key,
        "authorLabel": c.author_label,
        "authorRole": c.author_role,
        "body": c.body,
        "createdAt": ts(&c.created_at),
    })
}

/// serializeConnector (api-utils.ts) — config parsed from JSON text, optional
/// most-recent ingestion.
pub fn serialize_connector(c: &ConnectorRow, last: Option<&IngestionRow>) -> Value {
    json!({
        "id": c.id,
        "name": c.name,
        "type": c.ctype,
        "config": crate::rows::parse_json_text::<Value>(&c.config, json!({})),
        "createdAt": ts(&c.created_at),
        "updatedAt": ts(&c.updated_at),
        "lastIngestion": last.map(|i| json!({
            "id": i.id,
            "status": i.status,
            "finishedAt": ts_opt(&i.finished_at),
            "rowsIngested": i.rows_ingested,
        })),
    })
}

/// The FULL ingestion row exactly as Prisma serialized it (ingest responses):
/// model field order id, connectorId, datasetId, status, message,
/// rowsIngested, startedAt, finishedAt.
pub fn serialize_ingestion_full(i: &IngestionRow) -> Value {
    json!({
        "id": i.id,
        "connectorId": i.connector_id,
        "datasetId": i.dataset_id,
        "status": i.status,
        "message": i.message,
        "rowsIngested": i.rows_ingested,
        "startedAt": ts(&i.started_at),
        "finishedAt": ts_opt(&i.finished_at),
    })
}

/// Ingestions-list item (GET /api/ingestions).
pub fn serialize_ingestion_list_item(
    i: &IngestionRow,
    connector_name: Option<&str>,
    dataset_name: Option<&str>,
) -> Value {
    json!({
        "id": i.id,
        "connectorName": connector_name,
        "datasetName": i.dataset_id.as_ref().and(dataset_name),
        "status": i.status,
        "message": i.message,
        "rowsIngested": i.rows_ingested,
        "startedAt": ts(&i.started_at),
        "finishedAt": ts_opt(&i.finished_at),
    })
}
