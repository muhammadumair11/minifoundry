//! /internal/* — service-to-service endpoints (contracts/INTERNAL_API.md,
//! compute section). Guarded by the shared service token (same
//! require_service pattern as services/auth).

use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::response::Response;
use mf_web::{json_ok, ApiError, ApiResult};
use std::collections::HashMap;

use crate::routes::transforms::serialized_transform_list;
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

/// GET /internal/transforms — transform list (public contract shape).
pub async fn list_transforms(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    require_service(&state, &headers)?;
    let transforms = serialized_transform_list(&state).await?;
    Ok(json_ok(serde_json::json!({ "transforms": transforms })))
}

/// GET /internal/search?q= — transform matches for the governance search
/// fan-out. Same semantics as the legacy global search slice: name contains
/// (case-insensitive), name asc, take 10, items shaped
/// `{type:'transform', id, title, subtitle, href:'/transforms'}`.
pub async fn search(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    require_service(&state, &headers)?;
    let q = params.get("q").map(|s| s.trim()).unwrap_or("");
    if q.is_empty() {
        return Ok(json_ok(serde_json::json!({ "results": [] })));
    }
    let rows: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT id, name, description FROM transforms WHERE name ILIKE $1 \
         ORDER BY name ASC LIMIT 10",
    )
    .bind(format!("%{q}%"))
    .fetch_all(&state.db)
    .await?;
    let results: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|(id, name, description)| {
            serde_json::json!({
                "type": "transform",
                "id": id,
                "title": name,
                "subtitle": description,
                "href": "/transforms",
            })
        })
        .collect();
    Ok(json_ok(serde_json::json!({ "results": results })))
}

/// GET /internal/stats — `{transforms, transformRuns}` counts.
pub async fn stats(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    require_service(&state, &headers)?;
    let (transforms,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM transforms")
        .fetch_one(&state.db)
        .await?;
    let (runs,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM transform_runs")
        .fetch_one(&state.db)
        .await?;
    Ok(json_ok(serde_json::json!({
        "transforms": transforms,
        "transformRuns": runs,
    })))
}

/// GET /internal/curriculum-state — flags/counts the curriculum
/// auto-verifier needs (workbook created/run, per-language usage, replay).
/// Language flags count runs of transforms with that language (any status);
/// success is tracked separately.
pub async fn curriculum_state(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    require_service(&state, &headers)?;

    let (transform_created,): (bool,) = sqlx::query_as("SELECT EXISTS(SELECT 1 FROM transforms)")
        .fetch_one(&state.db)
        .await?;
    let (workbook_run,): (bool,) = sqlx::query_as("SELECT EXISTS(SELECT 1 FROM transform_runs)")
        .fetch_one(&state.db)
        .await?;
    let (workbook_run_success,): (bool,) =
        sqlx::query_as("SELECT EXISTS(SELECT 1 FROM transform_runs WHERE status = 'success')")
            .fetch_one(&state.db)
            .await?;
    let db = &state.db;
    let lang_used = |lang: &'static str| async move {
        let (used,): (bool,) = sqlx::query_as(
            "SELECT EXISTS(SELECT 1 FROM transform_runs r JOIN transforms t ON t.id = r.transform_id \
             WHERE t.language = $1)",
        )
        .bind(lang)
        .fetch_one(db)
        .await?;
        Ok::<bool, sqlx::Error>(used)
    };
    let sql_used = lang_used("sql").await?;
    let javascript_used = lang_used("javascript").await?;
    let python_used = lang_used("python").await?;
    let (replay_used,): (bool,) = sqlx::query_as(
        "SELECT EXISTS(SELECT 1 FROM transform_runs WHERE replay_of_run_id IS NOT NULL)",
    )
    .fetch_one(&state.db)
    .await?;
    let (transforms,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM transforms")
        .fetch_one(&state.db)
        .await?;
    let (runs,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM transform_runs")
        .fetch_one(&state.db)
        .await?;
    let (runs_success,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM transform_runs WHERE status = 'success'")
            .fetch_one(&state.db)
            .await?;

    Ok(json_ok(serde_json::json!({
        "transformCreated": transform_created,
        "workbookRun": workbook_run,
        "workbookRunSuccess": workbook_run_success,
        "sqlUsed": sql_used,
        "javascriptUsed": javascript_used,
        "pythonUsed": python_used,
        "replayUsed": replay_used,
        "transforms": transforms,
        "transformRuns": runs,
        "runsSuccess": runs_success,
    })))
}

/// POST /internal/reset — truncate compute tables (governance settings/reset
/// fan-out; runs first — FK).
pub async fn reset(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    require_service(&state, &headers)?;
    sqlx::query("TRUNCATE TABLE transform_runs, transforms")
        .execute(&state.db)
        .await?;
    Ok(json_ok(serde_json::json!({ "ok": true })))
}
