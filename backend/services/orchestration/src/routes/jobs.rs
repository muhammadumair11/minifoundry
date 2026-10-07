//! /api/execution-jobs* — the durable jobs table (ports of
//! src/app/api/execution-jobs/**). Viewer+ reads.

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::Response;
use mf_web::{actor_from_headers, json_ok, require_role, ApiError, ApiResult};
use serde_json::{json, Value};

use crate::state::{serialize_job_detail, serialize_job_list_item, AppState, JobRow, JOB_COLS};

/// GET /api/execution-jobs — 50 newest jobs with pipeline names (a deleted
/// pipeline falls back to the raw pipelineId, exactly like the legacy Map
/// lookup `names.get(job.pipelineId) ?? job.pipelineId`).
pub async fn list_jobs(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "viewer")?;

    let jobs: Vec<JobRow> = sqlx::query_as(&format!(
        "SELECT {JOB_COLS} FROM execution_jobs ORDER BY created_at DESC LIMIT 50"
    ))
    .fetch_all(&state.db)
    .await?;

    let ids: Vec<String> = {
        let mut seen = std::collections::HashSet::new();
        jobs.iter()
            .map(|j| j.pipeline_id.clone())
            .filter(|id| seen.insert(id.clone()))
            .collect()
    };
    let names: Vec<(String, String)> = if ids.is_empty() {
        vec![]
    } else {
        sqlx::query_as("SELECT id, name FROM pipelines WHERE id = ANY($1)")
            .bind(&ids)
            .fetch_all(&state.db)
            .await?
    };
    let name_by: std::collections::HashMap<&str, &str> =
        names.iter().map(|(id, name)| (id.as_str(), name.as_str())).collect();

    let items: Vec<Value> = jobs
        .iter()
        .map(|job| {
            serialize_job_list_item(
                job,
                name_by.get(job.pipeline_id.as_str()).copied().unwrap_or(job.pipeline_id.as_str()),
            )
        })
        .collect();
    Ok(json_ok(json!({ "jobs": items })))
}

/// GET /api/execution-jobs/{id} — one job (viewer+).
pub async fn job_detail(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "viewer")?;

    let job: Option<JobRow> =
        sqlx::query_as(&format!("SELECT {JOB_COLS} FROM execution_jobs WHERE id = $1"))
            .bind(&id)
            .fetch_optional(&state.db)
            .await?;
    let Some(job) = job else {
        return Err(ApiError::not_found(format!("Job '{id}' not found")));
    };
    Ok(json_ok(json!({ "job": serialize_job_detail(&job) })))
}
