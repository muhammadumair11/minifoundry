//! /internal/* — service-to-service endpoints (per contracts/INTERNAL_API.md,
//! orchestration section). Guarded by the shared service token (same
//! `require_service` pattern as the auth service).

use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::response::Response;
use mf_web::{json_ok, ApiError, ApiResult};
use serde_json::{json, Value};

use crate::routes::health::compute_runs_health;
use crate::routes::pipelines::{pipeline_detail_payload, pipelines_list_payload};
use crate::routes::runs::runs_list;
use crate::state::AppState;

/// Internal endpoints require the shared service token (both runtime modes);
/// compose always provisions MF_SERVICE_TOKEN.
pub fn require_service(state: &AppState, headers: &HeaderMap) -> Result<(), ApiError> {
    let provided = headers
        .get(mf_auth::SERVICE_TOKEN_HEADER)
        .and_then(|v| v.to_str().ok());
    if state.mode.is_service_authorized(provided) {
        Ok(())
    } else {
        Err(ApiError::forbidden("service token required"))
    }
}

/// GET /internal/pipelines — pipeline list (public contract).
pub async fn internal_pipelines(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    require_service(&state, &headers)?;
    Ok(json_ok(pipelines_list_payload(&state).await?))
}

/// GET /internal/pipelines/{id} — pipeline detail incl. current graph.
pub async fn internal_pipeline_detail(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    require_service(&state, &headers)?;
    Ok(json_ok(pipeline_detail_payload(&state, &id).await?))
}

/// GET /internal/runs?limit=&status= — recent runs (stats/health/curriculum).
pub async fn internal_runs(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    require_service(&state, &headers)?;
    Ok(json_ok(runs_list(&state, &params, 100).await?))
}

/// GET /internal/health/runs — run aggregates for the platform health route.
pub async fn internal_health_runs(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    require_service(&state, &headers)?;
    let runs = compute_runs_health(&state)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    Ok(json_ok(runs))
}

/// GET /internal/search?q= — pipeline matches in the SearchResultItem shape
/// the governance search fan-out merges verbatim.
pub async fn internal_search(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    require_service(&state, &headers)?;
    let q = params.get("q").map(|s| s.trim().to_string()).unwrap_or_default();
    if q.is_empty() {
        return Ok(json_ok(json!({ "results": [] })));
    }
    let rows: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT id, name, description FROM pipelines WHERE name ILIKE '%' || $1 || '%' \
         ORDER BY updated_at DESC LIMIT 10",
    )
    .bind(&q)
    .fetch_all(&state.db)
    .await?;
    let results: Vec<Value> = rows
        .iter()
        .map(|(id, name, description)| {
            json!({
                "type": "pipeline",
                "id": id,
                "title": name,
                "subtitle": description,
                "href": format!("/pipelines/{id}"),
            })
        })
        .collect();
    Ok(json_ok(json!({ "results": results })))
}

/// GET /internal/stats — {pipelines, runs, runsSuccess, runsFailed,
/// schedules, jobsQueued, jobsRunning} (exact INTERNAL_API.md contract).
pub async fn internal_stats(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    require_service(&state, &headers)?;
    let (pipelines,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM pipelines").fetch_one(&state.db).await?;
    let (runs,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM pipeline_runs").fetch_one(&state.db).await?;
    let (runs_success,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM pipeline_runs WHERE status = 'success'")
            .fetch_one(&state.db)
            .await?;
    let (runs_failed,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM pipeline_runs WHERE status = 'failed'")
            .fetch_one(&state.db)
            .await?;
    let (schedules,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM schedules").fetch_one(&state.db).await?;
    let (jobs_queued,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM execution_jobs WHERE status = 'queued'")
            .fetch_one(&state.db)
            .await?;
    let (jobs_running,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM execution_jobs WHERE status = 'running'")
            .fetch_one(&state.db)
            .await?;
    Ok(json_ok(json!({
        "pipelines": pipelines,
        "runs": runs,
        "runsSuccess": runs_success,
        "runsFailed": runs_failed,
        "schedules": schedules,
        "jobsQueued": jobs_queued,
        "jobsRunning": jobs_running,
    })))
}

/// GET /internal/curriculum-state — live-data flags the governance curriculum
/// auto-verifier consumes (pipeline created / version saved / run succeeded /
/// schedule exists / replay used) plus the underlying counts.
pub async fn internal_curriculum_state(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    require_service(&state, &headers)?;
    let (pipelines,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM pipelines").fetch_one(&state.db).await?;
    let (saved_versions,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM pipeline_versions WHERE created_by IS DISTINCT FROM 'backfill'",
    )
    .fetch_one(&state.db)
    .await?;
    let (runs,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM pipeline_runs").fetch_one(&state.db).await?;
    let (runs_success,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM pipeline_runs WHERE status = 'success'")
            .fetch_one(&state.db)
            .await?;
    let (runs_failed,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM pipeline_runs WHERE status = 'failed'")
            .fetch_one(&state.db)
            .await?;
    let (replay_runs,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM pipeline_runs WHERE \"trigger\" = 'replay'")
            .fetch_one(&state.db)
            .await?;
    let (schedules,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM schedules").fetch_one(&state.db).await?;
    let (jobs_queued,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM execution_jobs WHERE status = 'queued'")
            .fetch_one(&state.db)
            .await?;
    let (jobs_running,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM execution_jobs WHERE status = 'running'")
            .fetch_one(&state.db)
            .await?;
    Ok(json_ok(json!({
        "pipelines": pipelines,
        "pipelineVersionsSaved": saved_versions,
        "runs": runs,
        "runsSuccess": runs_success,
        "runsFailed": runs_failed,
        "replayRuns": replay_runs,
        "schedules": schedules,
        "jobsQueued": jobs_queued,
        "jobsRunning": jobs_running,
        "flags": {
            "pipelineCreated": pipelines > 0,
            "pipelineVersionSaved": saved_versions > 0,
            "runSucceeded": runs_success > 0,
            "scheduleExists": schedules > 0,
            "replayUsed": replay_runs > 0,
        },
    })))
}

/// POST /internal/reset — truncate every orchestration table (governance
/// settings/reset calls this; auth users are NOT touched).
pub async fn internal_reset(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    require_service(&state, &headers)?;
    sqlx::query(
        "TRUNCATE pipeline_runs, execution_jobs, schedules, pipeline_versions, pipelines",
    )
    .execute(&state.db)
    .await
    .map_err(|e| ApiError::internal(e.to_string()))?;
    tracing::warn!("internal reset: orchestration tables truncated");
    Ok(json_ok(json!({ "ok": true })))
}
