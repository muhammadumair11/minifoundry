//! Shared service state + DB row models + exact-legacy serializers.
//!
//! Ports the `Transform` / `TransformRun` Prisma models and the
//! `serializeTransform` / `serializeTransformRun` shapes from
//! `src/lib/transform-engine.ts` (field order and casing pinned by
//! backend/contracts/reads/transforms-list.json + transform-runs.json).

use chrono::{DateTime, Utc};
use mf_auth::RuntimeMode;
use mf_internal::ServiceClient;
use mf_types::{LogEntry, Value};
use sqlx::types::Json;
use sqlx::PgPool;
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub tenants: mf_db::TenantPools,
    pub nats: async_nats::Client,
    pub mode: Arc<RuntimeMode>,
    /// Catalog internal client (dataset reads for workbook inputs + the
    /// single version-write door for workbook output).
    pub catalog: ServiceClient,
}

// ─── DB rows ────────────────────────────────────────────────────────────

pub const TRANSFORM_COLS: &str = "id, name, description, language, source_code, \
     inputs_json, output_dataset_name, created_at, updated_at";

pub const RUN_COLS: &str = "id, transform_id, status, logs_json, duration_ms, row_count, \
     output_dataset_id, output_version_number, error, manifest_json, replay_of_run_id, \
     started_at, finished_at";

#[derive(Debug, sqlx::FromRow)]
pub struct TransformRow {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    /// sql | javascript | python
    pub language: String,
    pub source_code: String,
    /// JSON string[] — input dataset ids, in order.
    pub inputs_json: Json<Value>,
    pub output_dataset_name: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl TransformRow {
    /// Port of `parseJsonSafe<string[]>(transform.inputsJson, [])`.
    pub fn input_ids(&self) -> Vec<String> {
        match &self.inputs_json.0 {
            Value::Array(arr) => arr
                .iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect(),
            _ => Vec::new(),
        }
    }
}

#[derive(Debug, sqlx::FromRow)]
pub struct TransformRunRow {
    pub id: String,
    pub transform_id: String,
    /// running | success | failed
    pub status: String,
    pub logs_json: Json<Value>,
    pub duration_ms: Option<i32>,
    pub row_count: Option<i32>,
    pub output_dataset_id: Option<String>,
    pub output_version_number: Option<i32>,
    pub error: Option<String>,
    pub manifest_json: Option<Json<Value>>,
    pub replay_of_run_id: Option<String>,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
}

impl TransformRunRow {
    /// Stored logs re-serialized through the typed LogEntry contract
    /// (`{ ts, level, msg }` in exactly that order); unparseable → [].
    pub fn logs(&self) -> Vec<LogEntry> {
        serde_json::from_value::<Vec<LogEntry>>(self.logs_json.0.clone()).unwrap_or_default()
    }
}

// ─── Serializers (exact legacy shapes) ──────────────────────────────────

/// `serializeTransformRun` (transform-engine.ts): logs parsed from JSON,
/// timestamps via mf_types::ts, hasManifest = manifestJson present.
pub fn serialize_transform_run(run: &TransformRunRow) -> Value {
    let logs: Vec<Value> = run
        .logs()
        .iter()
        .map(|e| serde_json::to_value(e).unwrap_or(Value::Null))
        .collect();
    serde_json::json!({
        "id": run.id,
        "transformId": run.transform_id,
        "status": run.status,
        "logs": logs,
        "durationMs": run.duration_ms,
        "rowCount": run.row_count,
        "outputDatasetId": run.output_dataset_id,
        "outputVersionNumber": run.output_version_number,
        "error": run.error,
        "startedAt": mf_types::ts::format(&run.started_at),
        "finishedAt": run.finished_at.map(|d| mf_types::ts::format(&d)),
        "hasManifest": run.manifest_json.is_some(),
        "replayOfRunId": run.replay_of_run_id,
    })
}

/// `serializeTransform` (transform-engine.ts). `input_names` maps dataset id
/// → name (missing datasets → null, like the legacy Map lookup). `latest` is
/// the transform's most recent run (startedAt desc), when any.
pub fn serialize_transform(
    t: &TransformRow,
    input_names: &HashMap<String, String>,
    runs_count: i64,
    latest: Option<&TransformRunRow>,
) -> Value {
    let inputs: Vec<Value> = t
        .input_ids()
        .iter()
        .map(|dataset_id| {
            serde_json::json!({
                "datasetId": dataset_id,
                "datasetName": input_names.get(dataset_id),
            })
        })
        .collect();
    serde_json::json!({
        "id": t.id,
        "name": t.name,
        "description": t.description,
        "language": t.language,
        "sourceCode": t.source_code,
        "inputs": inputs,
        "outputDatasetName": t.output_dataset_name,
        "createdAt": mf_types::ts::format(&t.created_at),
        "updatedAt": mf_types::ts::format(&t.updated_at),
        "runsCount": runs_count,
        "latestRun": latest.map(|r| serde_json::json!({
            "id": r.id,
            "status": r.status,
            "rowCount": r.row_count,
            "durationMs": r.duration_ms,
            "finishedAt": r.finished_at.map(|d| mf_types::ts::format(&d)),
            "error": r.error,
        })),
    })
}

impl mf_web::TenantService for AppState {
    fn tenant_pools(&self) -> &mf_db::TenantPools {
        &self.tenants
    }
    fn demo_mode(&self) -> bool {
        self.mode.demo
    }
    fn with_database(&self, db: sqlx::PgPool) -> Self {
        Self { db, ..self.clone() }
    }
}
