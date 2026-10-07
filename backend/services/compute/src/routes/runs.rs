//! /api/transforms/{id}/run, /api/transforms/{id}/runs and
//! /api/transforms/{id}/runs/{runId}/replay — synchronous workbook execution,
//! per-workbook history and manifest replay.

use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::response::Response;
use mf_types::Value;
use mf_web::{actor_from_headers, json_ok, require_role, ApiError, ApiResult};
use std::collections::HashMap;

use crate::audit::{self, AuditOptions};
use crate::catalog;
use crate::engine::{self, RunOptions, TransformManifest, TransformSnapshot};
use crate::routes::transforms::{fetch_runs, fetch_transform, snapshot_of};
use crate::state::{serialize_transform_run, AppState, TransformRunRow, RUN_COLS};

/// Legacy PREVIEW_ROWS (run route output preview).
const PREVIEW_ROWS: i64 = 20;

/// Legacy shared-mode gate for code execution: the gateway forwards the
/// platform mode; direct callers fall back to this service's MF_DEMO_MODE.
fn demo_mode_active(state: &AppState, headers: &HeaderMap) -> bool {
    match headers
        .get(mf_auth::HEADER_DEMO_MODE)
        .and_then(|v| v.to_str().ok())
    {
        Some(v) => v == "1",
        None => state.mode.demo,
    }
}

fn shared_mode_error() -> ApiError {
    ApiError::forbidden(
        "Code transforms require an isolated runner and are disabled in shared mode",
    )
}

/// POST /api/transforms/{id}/run — synchronous execution. ALWAYS 200 with
/// the serialized run (+ preview/schema) even when the run failed; only
/// infrastructure problems escape as 500 (legacy serverError parity).
pub async fn run_transform(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;
    if !demo_mode_active(&state, &headers) {
        return Err(shared_mode_error());
    }

    let transform = fetch_transform(&state, &id).await?;
    let run = engine::run_transform(&state, &snapshot_of(&transform), RunOptions::default())
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;

    audit::audit(
        &state,
        &actor,
        AuditOptions::new("transform.run", "transform")
            .resource_id(Some(&transform.id))
            .resource_name(Some(&transform.name))
            .detail(Some(&format!(
                "status={} rows={}",
                run.status,
                run.row_count.unwrap_or(0)
            ))),
    )
    .await;

    // Output preview + schema from the published version (empty on failure).
    let (preview, schema) = match (&run.output_dataset_id, run.output_version_number) {
        (Some(dataset_id), Some(version)) => fetch_preview(&state, dataset_id, version).await,
        _ => (Vec::new(), Vec::new()),
    };

    Ok(json_ok(serde_json::json!({
        "run": serialize_transform_run(&run),
        "preview": preview,
        "schema": schema,
    })))
}

/// First PREVIEW_ROWS rows + schema of the published output version.
/// Best-effort like legacy (version gone / parse failure → empty). The schema
/// is normalized to raw `{name, type}` entries — legacy `parseSchema` read
/// schemaJson directly (no governance `markedWith` annotation).
async fn fetch_preview(
    state: &AppState,
    dataset_id: &str,
    version: i32,
) -> (Vec<Value>, Vec<Value>) {
    let n = version.to_string();
    let schema = match catalog::get_version(&state.catalog, dataset_id, &n).await {
        Ok(Some(meta)) => catalog::normalize_schema(meta.get("schema")),
        _ => Vec::new(),
    };
    let preview =
        match catalog::get_rows_paged(&state.catalog, dataset_id, &n, 0, PREVIEW_ROWS).await {
            Ok(rows) => rows
                .into_iter()
                .take(PREVIEW_ROWS as usize)
                .map(Value::Object)
                .collect(),
            Err(_) => Vec::new(),
        };
    (preview, schema)
}

/// GET /api/transforms/{id}/runs?limit=20 — run history, latest first.
/// limit parsing is the legacy `Number(...)` + clamp(trunc, 1, 100), default
/// 20 on anything non-finite. No role guard (legacy parity).
pub async fn list_runs(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    // Existence check first — unknown transform → 404 even for bad limits.
    fetch_transform(&state, &id).await?;

    // Legacy: `Number(searchParams.get('limit') ?? '20')` — empty/whitespace
    // is Number('') = 0 (→ clamps to 1); non-numeric is NaN (→ default 20).
    let limit = match params.get("limit") {
        None => 20,
        Some(raw) => {
            let trimmed = raw.trim();
            let parsed = if trimmed.is_empty() {
                Some(0.0)
            } else {
                trimmed.parse::<f64>().ok()
            };
            match parsed {
                Some(n) if n.is_finite() => (n.trunc() as i64).clamp(1, 100),
                _ => 20,
            }
        }
    };

    let runs: Vec<TransformRunRow> = fetch_runs(&state, &id, limit).await?;
    let out: Vec<Value> = runs.iter().map(serialize_transform_run).collect();
    Ok(json_ok(serde_json::json!({ "runs": out })))
}

/// POST /api/transforms/{id}/runs/{runId}/replay — re-execute a run from its
/// manifest: pinned input versions + the recorded code snapshot, as a new run
/// with replayOfRunId set.
pub async fn replay_run(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, run_id)): Path<(String, String)>,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;
    if !demo_mode_active(&state, &headers) {
        return Err(shared_mode_error());
    }

    let transform = fetch_transform(&state, &id).await.ok();
    let prior: Option<TransformRunRow> = sqlx::query_as(&format!(
        "SELECT {RUN_COLS} FROM transform_runs WHERE id = $1 AND transform_id = $2"
    ))
    .bind(&run_id)
    .bind(&id)
    .fetch_optional(&state.db)
    .await?;
    let (Some(transform), Some(prior)) = (transform, prior) else {
        return Err(ApiError::not_found("Transform or run not found"));
    };

    // Manifest gate (legacy checks: manifest present AND both arrays).
    let manifest: Option<TransformManifest> = prior
        .manifest_json
        .as_ref()
        .and_then(|j| serde_json::from_value::<TransformManifest>(j.0.clone()).ok());
    let Some(manifest) = manifest else {
        return Err(ApiError::bad_request(
            "This run has no complete replay manifest",
        ));
    };
    let skipped = manifest
        .configured_inputs
        .iter()
        .any(|input_id| !manifest.inputs.iter().any(|i| &i.dataset_id == input_id));
    if skipped {
        return Err(ApiError::bad_request(
            "The original run skipped an input, so a faithful replay is unavailable",
        ));
    }

    // Snapshot: manifest code/config override the live transform.
    let snapshot = TransformSnapshot {
        id: transform.id.clone(),
        language: manifest.language.clone(),
        source_code: manifest.source_code.clone(),
        input_ids: manifest.configured_inputs.clone(),
        output_dataset_name: manifest.output_dataset_name.clone(),
    };
    let mut overrides: HashMap<String, i64> = HashMap::new();
    for input in &manifest.inputs {
        overrides.insert(input.dataset_id.clone(), input.version_number);
    }
    let replay = engine::run_transform(
        &state,
        &snapshot,
        RunOptions {
            input_overrides: Some(overrides),
            replay_of_run_id: Some(prior.id.clone()),
        },
    )
    .await
    .map_err(|e| ApiError::internal(e.to_string()))?;

    audit::audit(
        &state,
        &actor,
        AuditOptions::new("transform.replay", "transform")
            .resource_id(Some(&id))
            .resource_name(Some(&transform.name))
            .detail(Some(&format!("replay of {}: {}", prior.id, replay.status))),
    )
    .await;

    Ok(json_ok(serde_json::json!({
        "run": serialize_transform_run(&replay),
        "replayOfRunId": prior.id,
    })))
}
