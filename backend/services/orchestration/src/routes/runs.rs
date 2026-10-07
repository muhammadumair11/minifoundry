//! /api/runs* — run list/detail plus durable replay & retry enqueue
//! (ports of src/app/api/runs/**).

use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::response::Response;
use mf_web::{actor_from_headers, json_ok, require_role, ApiError, ApiResult};
use serde_json::{json, Value};
use sqlx::types::Json;

use crate::audit::{self, AuditOptions};
use crate::engine::RunManifest;
use crate::jobs::{self, EnqueueOptions};
use crate::routes::pipelines::{replay_event_key, retry_event_key};
use crate::routes::{coerce_query_int, query_enum, query_string_min1};
use crate::state::{AppState, RunRow};
use crate::versions;

/// Run columns qualified with the `r.` alias (lists join pipelines for names).
fn run_cols_aliased() -> String {
    [
        "id",
        "pipeline_id",
        "status",
        "logs_json",
        "version_number",
        "\"trigger\"",
        "attempt",
        "manifest_json",
        "duration_ms",
        "failure_cause",
        "output_dataset_id",
        "output_version_number",
        "replayed_from_run_id",
        "started_at",
        "finished_at",
    ]
    .iter()
    .map(|c| format!("r.{c}"))
    .collect::<Vec<_>>()
    .join(", ")
}

/// Run row joined with its pipeline name (list + detail).
#[derive(sqlx::FromRow)]
pub struct RunNamedRow {
    #[sqlx(flatten)]
    pub run: RunRow,
    pub pipeline_name: String,
}

/// GET /api/runs — bounded pagination (?limit 1..200 default 100, ?offset
/// 0..10000 default 0), optional ?status= and ?pipelineId= filters, newest first.
pub async fn list_runs(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    let payload = runs_list(&state, &params, 100).await?;
    Ok(json_ok(payload))
}

/// Shared runs-list query (public route + /internal/runs). `default_limit`
/// is 100 for both; validation mirrors the legacy zod schema.
pub async fn runs_list(
    state: &AppState,
    params: &HashMap<String, String>,
    default_limit: i64,
) -> Result<Value, ApiError> {
    let mut issues = Vec::new();
    let status = match query_enum(params, "status", &["running", "success", "failed"]) {
        Ok(s) => s.map(|s| s.to_string()),
        Err(i) => {
            issues.push(i);
            None
        }
    };
    let pipeline_id = match query_string_min1(params, "pipelineId") {
        Ok(p) => p,
        Err(i) => {
            issues.push(i);
            None
        }
    };
    let limit = match coerce_query_int(params, "limit", 1, 200, default_limit) {
        Ok(l) => l,
        Err(i) => {
            issues.push(i);
            default_limit
        }
    };
    let offset = match coerce_query_int(params, "offset", 0, 10_000, 0) {
        Ok(o) => o,
        Err(i) => {
            issues.push(i);
            0
        }
    };
    if !issues.is_empty() {
        return Err(ApiError::bad_request(issues.join("; ")));
    }

    let mut where_parts: Vec<String> = Vec::new();
    if status.is_some() {
        where_parts.push(format!("r.status = ${}", where_parts.len() + 1));
    }
    if pipeline_id.is_some() {
        where_parts.push(format!("r.pipeline_id = ${}", where_parts.len() + 1));
    }
    let where_sql = if where_parts.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", where_parts.join(" AND "))
    };
    let limit_idx = where_parts.len() + 1;
    let offset_idx = where_parts.len() + 2;

    let list_sql = format!(
        "SELECT {}, p.name AS pipeline_name FROM pipeline_runs r JOIN pipelines p ON p.id = r.pipeline_id \
         {where_sql} ORDER BY r.started_at DESC LIMIT ${limit_idx} OFFSET ${offset_idx}",
        run_cols_aliased()
    );
    let count_sql = format!("SELECT COUNT(*) FROM pipeline_runs r {where_sql}");

    let mut q = sqlx::query_as::<_, RunNamedRow>(&list_sql);
    let mut cq = sqlx::query_as::<_, (i64,)>(&count_sql);
    if let Some(s) = &status {
        q = q.bind(s.clone());
        cq = cq.bind(s.clone());
    }
    if let Some(p) = &pipeline_id {
        q = q.bind(p.clone());
        cq = cq.bind(p.clone());
    }
    let runs = q.bind(limit).bind(offset).fetch_all(&state.db).await?;
    let (total,) = cq.fetch_one(&state.db).await?;

    let items: Vec<Value> = runs
        .iter()
        .map(|r| crate::state::serialize_run_list_item(&r.run, &r.pipeline_name))
        .collect();
    Ok(json!({
        "runs": items,
        "meta": { "total": total, "limit": limit, "offset": offset },
    }))
}

/// GET /api/runs/{id} — single run with parsed build manifest (viewer+).
pub async fn run_detail(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "viewer")?;

    let row: Option<RunNamedRow> = sqlx::query_as(&format!(
        "SELECT {}, p.name AS pipeline_name FROM pipeline_runs r JOIN pipelines p ON p.id = r.pipeline_id WHERE r.id = $1",
        run_cols_aliased()
    ))
    .bind(&id)
    .fetch_optional(&state.db)
    .await?;
    let Some(row) = row else {
        return Err(ApiError::not_found(format!("Run '{id}' not found")));
    };

    // Legacy runs have no manifestJson → manifest is null.
    let manifest: Value = match &row.run.manifest_json {
        Some(Json(v)) => v.clone(),
        None => Value::Null,
    };
    let mut run = crate::state::serialize_run(&row.run);
    if let Value::Object(m) = &mut run {
        m.insert("pipelineName".into(), json!(row.pipeline_name));
        m.insert("manifest".into(), manifest);
    }
    Ok(json_ok(json!({ "run": run })))
}

/// POST /api/runs/{id}/replay — enqueue a durable replay pinned to the
/// original graph version and recorded input versions (editor+).
pub async fn replay_run(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;

    #[derive(sqlx::FromRow)]
    struct ReplaySource {
        id: String,
        pipeline_id: String,
        version_number: Option<i32>,
        manifest_json: Option<Json<Value>>,
        pipeline_name: String,
    }
    let run: Option<ReplaySource> = sqlx::query_as(
        "SELECT r.id, r.pipeline_id, r.version_number, r.manifest_json, p.name AS pipeline_name \
         FROM pipeline_runs r JOIN pipelines p ON p.id = r.pipeline_id WHERE r.id = $1",
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await?;
    let Some(run) = run else {
        return Err(ApiError::not_found(format!("Run '{id}' not found")));
    };
    let Some(Json(manifest_value)) = run.manifest_json.clone() else {
        return Err(ApiError::bad_request(
            "This run has no recorded build manifest — it cannot be replayed from recorded inputs.",
        ));
    };
    let Ok(manifest) = serde_json::from_value::<RunManifest>(manifest_value) else {
        return Err(ApiError::bad_request(
            "Run manifest is unreadable — cannot replay",
        ));
    };

    let pinned = run.version_number.unwrap_or(1);
    let graph_version = versions::get_pipeline_version(&state, &run.pipeline_id, pinned)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    let Some(graph_version) = graph_version else {
        let label = run
            .version_number
            .map(|v| v.to_string())
            .unwrap_or_else(|| "?".to_string());
        return Err(ApiError::bad_request(format!(
            "Pinned pipeline version v{label} no longer exists — cannot replay faithfully"
        )));
    };

    let mut input_overrides = serde_json::Map::new();
    for input in &manifest.inputs {
        if let Some(vn) = input.version_number {
            input_overrides.insert(input.dataset_id.clone(), json!(vn));
        }
    }

    let job = jobs::enqueue_pipeline_job(
        &state,
        &run.pipeline_id,
        EnqueueOptions {
            trigger: "replay",
            event_key: replay_event_key(&run.id),
            schedule_id: None,
            max_attempts: None,
            graph_version_number: Some(graph_version.version_number),
            payload: json!({
                "inputOverrides": Value::Object(input_overrides),
                "replayOfRunId": run.id,
            }),
        },
    )
    .await
    .map_err(|e| ApiError::internal(e.to_string()))?;

    audit::audit(
        &state,
        &actor,
        AuditOptions::new("pipeline.run", "pipeline")
            .resource_id(Some(&run.pipeline_id))
            .resource_name(Some(&run.pipeline_name))
            .detail(Some(&format!("queued replay of run {id} (job {})", job.id))),
    )
    .await;

    Ok(json_ok(
        json!({ "job": { "id": job.id, "status": job.status, "eventKey": job.event_key } }),
    ))
}

/// POST /api/runs/{id}/retry — enqueue a durable retry pinning the LATEST
/// pipeline version at enqueue time (editor+).
pub async fn retry_run(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;

    #[derive(sqlx::FromRow)]
    struct RetrySource {
        id: String,
        pipeline_id: String,
        pipeline_name: String,
    }
    let run: Option<RetrySource> = sqlx::query_as(
        "SELECT r.id, r.pipeline_id, p.name AS pipeline_name \
         FROM pipeline_runs r JOIN pipelines p ON p.id = r.pipeline_id WHERE r.id = $1",
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await?;
    let Some(run) = run else {
        return Err(ApiError::not_found(format!("Run '{id}' not found")));
    };

    let version = versions::ensure_pipeline_version(&state, &run.pipeline_id)
        .await
        .map_err(ApiError::internal)?;
    let job = jobs::enqueue_pipeline_job(
        &state,
        &run.pipeline_id,
        EnqueueOptions {
            trigger: "retry",
            event_key: retry_event_key(&run.id),
            schedule_id: None,
            max_attempts: Some(1),
            graph_version_number: Some(version.version_number),
            payload: json!({ "parentRunId": run.id }),
        },
    )
    .await
    .map_err(|e| ApiError::internal(e.to_string()))?;

    audit::audit(
        &state,
        &actor,
        AuditOptions::new("pipeline.run", "pipeline")
            .resource_id(Some(&run.pipeline_id))
            .resource_name(Some(&run.pipeline_name))
            .detail(Some(&format!("queued retry of run {id} (job {})", job.id))),
    )
    .await;

    Ok(json_ok(
        json!({ "job": { "id": job.id, "status": job.status, "eventKey": job.event_key } }),
    ))
}
