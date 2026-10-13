//! Shared service state, DB row models and the exact legacy serializers
//! (`serializeRun` / `serializeSchedule` from src/lib/api-utils.ts).

use chrono::{DateTime, Utc};
use mf_auth::RuntimeMode;
use serde_json::Value;
use sqlx::types::Json;
use sqlx::PgPool;
use std::sync::Arc;

use crate::catalog::CatalogClient;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub tenants: mf_db::TenantPools,
    pub nats: async_nats::Client,
    pub mode: Arc<RuntimeMode>,
    pub catalog: Arc<CatalogClient>,
}

// ─── DB rows ────────────────────────────────────────────────────────────

#[derive(Debug, sqlx::FromRow)]
pub struct PipelineRow {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub graph_json: Json<Value>,
    pub trigger_mode: String,
    pub upstream_dataset_ids: Json<Value>,
    pub max_retries: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, sqlx::FromRow)]
#[allow(dead_code)] // full row mirror; not every column is read on every path
pub struct PipelineVersionRow {
    pub id: String,
    pub pipeline_id: String,
    pub version_number: i32,
    pub graph_json: Json<Value>,
    pub node_count: i32,
    pub note: Option<String>,
    pub created_by: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, sqlx::FromRow)]
pub struct RunRow {
    pub id: String,
    pub pipeline_id: String,
    pub status: String,
    pub logs_json: Json<Value>,
    pub version_number: Option<i32>,
    pub trigger: String,
    pub attempt: i32,
    pub manifest_json: Option<Json<Value>>,
    pub duration_ms: Option<i32>,
    pub failure_cause: Option<String>,
    pub output_dataset_id: Option<String>,
    pub output_version_number: Option<i32>,
    pub replayed_from_run_id: Option<String>,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
}

#[derive(Debug, sqlx::FromRow)]
#[allow(dead_code)] // full row mirror; not every column is read on every path
pub struct JobRow {
    pub organization_id: String,
    pub id: String,
    pub pipeline_id: String,
    pub version_number: i32,
    pub trigger: String,
    pub schedule_id: Option<String>,
    pub event_key: String,
    pub payload_json: Json<Value>,
    pub status: String,
    pub attempt: i32,
    pub max_attempts: i32,
    pub available_at: DateTime<Utc>,
    pub lease_owner: Option<String>,
    pub lease_until: Option<DateTime<Utc>>,
    pub last_run_id: Option<String>,
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
}

#[derive(Debug, sqlx::FromRow)]
#[allow(dead_code)] // full row mirror; not every column is read on every path
pub struct ScheduleRow {
    pub id: String,
    pub pipeline_id: String,
    pub name: String,
    pub enabled: bool,
    pub interval_minutes: i32,
    pub last_run_at: Option<DateTime<Utc>>,
    pub next_run_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Schedule joined with its pipeline name (serializeSchedule input).
#[derive(Debug, sqlx::FromRow)]
pub struct ScheduleNamedRow {
    pub id: String,
    pub pipeline_id: String,
    pub name: String,
    pub enabled: bool,
    pub interval_minutes: i32,
    pub last_run_at: Option<DateTime<Utc>>,
    pub next_run_at: Option<DateTime<Utc>>,
    pub pipeline_name: Option<String>,
}

pub const PIPELINE_COLS: &str =
    "id, name, description, graph_json, trigger_mode, upstream_dataset_ids, max_retries, created_at, updated_at";
pub const VERSION_COLS: &str =
    "id, pipeline_id, version_number, graph_json, node_count, note, created_by, created_at";
pub const RUN_COLS: &str = "id, pipeline_id, status, logs_json, version_number, \"trigger\", attempt, manifest_json, duration_ms, failure_cause, output_dataset_id, output_version_number, replayed_from_run_id, started_at, finished_at";
pub const JOB_COLS: &str = "organization_id, id, pipeline_id, version_number, \"trigger\", schedule_id, event_key, payload_json, status, attempt, max_attempts, available_at, lease_owner, lease_until, last_run_id, error, created_at, updated_at, finished_at";
pub const SCHEDULE_COLS: &str =
    "id, pipeline_id, name, enabled, interval_minutes, last_run_at, next_run_at, created_at, updated_at";

// ─── Serializers (exact legacy shapes, ISO-8601 UTC millis + Z) ─────────

fn ts(dt: &DateTime<Utc>) -> Value {
    Value::String(mf_types::ts::format(dt))
}

fn ts_opt(dt: &Option<DateTime<Utc>>) -> Value {
    match dt {
        Some(d) => ts(d),
        None => Value::Null,
    }
}

/// Port of `serializeRun()` — durationMs prefers the recorded column and falls
/// back to timestamp math for legacy rows.
pub fn serialize_run(run: &RunRow) -> Value {
    let duration = match run.duration_ms {
        Some(d) => Value::from(d),
        None => match run.finished_at {
            Some(f) => Value::from((f - run.started_at).num_milliseconds()),
            None => Value::Null,
        },
    };
    let logs = match &run.logs_json.0 {
        v @ Value::Array(_) => (*v).clone(),
        _ => Value::Array(vec![]),
    };
    serde_json::json!({
        "id": run.id,
        "pipelineId": run.pipeline_id,
        "status": run.status,
        "versionNumber": run.version_number,
        "trigger": run.trigger,
        "attempt": run.attempt,
        "durationMs": duration,
        "failureCause": run.failure_cause,
        "outputDatasetId": run.output_dataset_id,
        "outputVersionNumber": run.output_version_number,
        "replayedFromRunId": run.replayed_from_run_id,
        "logs": logs,
        "startedAt": ts(&run.started_at),
        "finishedAt": ts_opt(&run.finished_at),
    })
}

/// GET /api/runs list item — serializeRun fields minus logs/outputDatasetId,
/// plus pipelineName (see runs/route.ts).
pub fn serialize_run_list_item(run: &RunRow, pipeline_name: &str) -> Value {
    let duration = match run.duration_ms {
        Some(d) => Value::from(d),
        None => match run.finished_at {
            Some(f) => Value::from((f - run.started_at).num_milliseconds()),
            None => Value::Null,
        },
    };
    serde_json::json!({
        "id": run.id,
        "pipelineId": run.pipeline_id,
        "pipelineName": pipeline_name,
        "status": run.status,
        "versionNumber": run.version_number,
        "trigger": run.trigger,
        "attempt": run.attempt,
        "durationMs": duration,
        "failureCause": run.failure_cause,
        "outputVersionNumber": run.output_version_number,
        "replayedFromRunId": run.replayed_from_run_id,
        "startedAt": ts(&run.started_at),
        "finishedAt": ts_opt(&run.finished_at),
    })
}

/// Port of `serializeSchedule()` — schedule with the owning pipeline's name.
pub fn serialize_schedule_named(s: &ScheduleNamedRow) -> Value {
    serde_json::json!({
        "id": s.id,
        "pipelineId": s.pipeline_id,
        "pipelineName": s.pipeline_name,
        "name": s.name,
        "enabled": s.enabled,
        "intervalMinutes": s.interval_minutes,
        "lastRunAt": ts_opt(&s.last_run_at),
        "nextRunAt": ts_opt(&s.next_run_at),
    })
}

pub fn serialize_schedule(s: &ScheduleRow, pipeline_name: Option<&str>) -> Value {
    serde_json::json!({
        "id": s.id,
        "pipelineId": s.pipeline_id,
        "pipelineName": pipeline_name,
        "name": s.name,
        "enabled": s.enabled,
        "intervalMinutes": s.interval_minutes,
        "lastRunAt": ts_opt(&s.last_run_at),
        "nextRunAt": ts_opt(&s.next_run_at),
    })
}

/// Pipeline list item (GET /api/pipelines).
pub fn serialize_pipeline_list_item(
    p: &PipelineRow,
    runs_count: i64,
    last_run: Option<&LastRunRow>,
) -> Value {
    serde_json::json!({
        "id": p.id,
        "name": p.name,
        "description": p.description,
        "graph": graph_value(&p.graph_json.0),
        "createdAt": ts(&p.created_at),
        "updatedAt": ts(&p.updated_at),
        "runsCount": runs_count,
        "lastRun": last_run.map(|r| serde_json::json!({
            "id": r.id,
            "status": r.status,
            "startedAt": ts(&r.started_at),
            "finishedAt": ts_opt(&r.finished_at),
        })),
    })
}

#[derive(Debug, sqlx::FromRow)]
pub struct LastRunRow {
    pub pipeline_id: String,
    pub id: String,
    pub status: String,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
}

/// parseJsonSafe(graphJson, null) equivalent for the stored JSONB graph.
pub fn graph_value(v: &Value) -> Value {
    match v {
        Value::Null => Value::Null,
        other => other.clone(),
    }
}

/// Pipeline detail shape shared by GET /api/pipelines/{id} and the internal
/// endpoint (adds versioning + trigger-automation fields).
pub fn serialize_pipeline_detail(
    p: &PipelineRow,
    latest_version_number: Option<i32>,
    version_count: i64,
) -> Value {
    let upstream: Value = match &p.upstream_dataset_ids.0 {
        v @ Value::Array(_) => v.clone(),
        _ => Value::Array(vec![]),
    };
    serde_json::json!({
        "id": p.id,
        "name": p.name,
        "description": p.description,
        "graph": graph_value(&p.graph_json.0),
        "createdAt": ts(&p.created_at),
        "updatedAt": ts(&p.updated_at),
        "latestVersionNumber": latest_version_number,
        "versionCount": version_count,
        "triggerMode": p.trigger_mode,
        "upstreamDatasetIds": upstream,
        "maxRetries": p.max_retries,
    })
}

/// Pipeline shape returned by create/update/restore ({id..updatedAt} only).
pub fn serialize_pipeline_basic(p: &PipelineRow) -> Value {
    serde_json::json!({
        "id": p.id,
        "name": p.name,
        "description": p.description,
        "graph": graph_value(&p.graph_json.0),
        "createdAt": ts(&p.created_at),
        "updatedAt": ts(&p.updated_at),
    })
}

/// Execution-job list item (GET /api/execution-jobs).
pub fn serialize_job_list_item(job: &JobRow, pipeline_name: &str) -> Value {
    let lease_expired =
        job.status == "running" && job.lease_until.is_some_and(|until| until < Utc::now());
    serde_json::json!({
        "id": job.id,
        "pipelineId": job.pipeline_id,
        "pipelineName": pipeline_name,
        "versionNumber": job.version_number,
        "trigger": job.trigger,
        "status": job.status,
        "leaseExpired": lease_expired,
        "attempt": job.attempt,
        "maxAttempts": job.max_attempts,
        "error": job.error,
        "lastRunId": job.last_run_id,
        "createdAt": ts(&job.created_at),
        "updatedAt": ts(&job.updated_at),
    })
}

/// Execution-job detail (GET /api/execution-jobs/{id}).
pub fn serialize_job_detail(job: &JobRow) -> Value {
    serde_json::json!({
        "id": job.id,
        "pipelineId": job.pipeline_id,
        "status": job.status,
        "attempt": job.attempt,
        "maxAttempts": job.max_attempts,
        "lastRunId": job.last_run_id,
        "error": job.error,
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
