//! /api/transforms + /api/transforms/{id} — workbook CRUD.
//! Ports of the legacy transforms route.ts / [id]/route.ts handlers.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::Response;
use mf_web::{actor_from_headers, json_created, json_ok, require_role, ApiError, ApiResult};
use sqlx::types::Json;
use std::collections::HashMap;

use crate::audit::{self, AuditOptions};
use crate::catalog;
use crate::engine::TransformSnapshot;
use crate::routes::{
    as_object, opt_enum, opt_str_array, opt_str_min1_msg, opt_str_nullish, parse_body,
    req_str_min1_msg,
};
use crate::state::{
    serialize_transform, serialize_transform_run, AppState, TransformRow, TransformRunRow,
    RUN_COLS, TRANSFORM_COLS,
};

const LANGUAGES: &[&str] = &["sql", "javascript", "python"];

/// Legacy `resolveInputNames`: dataset id → name for every input id
/// referenced by the given transforms. Names live in the CATALOG service —
/// each unique id is looked up through the internal API; unavailable ids
/// (deleted datasets OR an unreachable catalog) simply get no entry, which
/// serializes as `datasetName: null` exactly like the legacy Map miss.
pub async fn resolve_input_names(
    state: &AppState,
    transforms: &[TransformRow],
) -> HashMap<String, String> {
    let mut ids: Vec<String> = Vec::new();
    for t in transforms {
        for id in t.input_ids() {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
    }
    let mut names = HashMap::new();
    for id in ids {
        match catalog::get_dataset(&state.catalog, &id).await {
            Ok(Some(ds)) => {
                if let Some(name) = ds.get("name").and_then(|v| v.as_str()) {
                    names.insert(id, name.to_string());
                }
            }
            // Transport failure: the catalog is down — skip the remaining
            // lookups (all would time out the same way) and serialize nulls.
            Err(mf_internal::InternalError::Transport(_)) => break,
            _ => {}
        }
    }
    names
}

/// Per-transform run counts (`_count.runs`).
pub async fn run_counts(
    state: &AppState,
) -> Result<HashMap<String, i64>, sqlx::Error> {
    let rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT transform_id, COUNT(*) FROM transform_runs GROUP BY transform_id",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(rows.into_iter().collect())
}

/// Latest run per transform (`runs: { orderBy startedAt desc, take: 1 }`).
pub async fn latest_runs(
    state: &AppState,
) -> Result<HashMap<String, TransformRunRow>, sqlx::Error> {
    let rows: Vec<TransformRunRow> = sqlx::query_as(&format!(
        "SELECT DISTINCT ON (transform_id) {RUN_COLS} FROM transform_runs \
         ORDER BY transform_id, started_at DESC"
    ))
    .fetch_all(&state.db)
    .await?;
    Ok(rows.into_iter().map(|r| (r.transform_id.clone(), r)).collect())
}

/// Shared list serialization (public GET /api/transforms and the internal
/// list endpoint return the same shape).
pub async fn serialized_transform_list(
    state: &AppState,
) -> Result<Vec<serde_json::Value>, sqlx::Error> {
    let transforms: Vec<TransformRow> =
        sqlx::query_as(&format!("SELECT {TRANSFORM_COLS} FROM transforms ORDER BY created_at ASC"))
            .fetch_all(&state.db)
            .await?;
    let counts = run_counts(state).await?;
    let latest = latest_runs(state).await?;
    let names = resolve_input_names(state, &transforms).await;
    Ok(transforms
        .iter()
        .map(|t| {
            serialize_transform(
                t,
                &names,
                counts.get(&t.id).copied().unwrap_or(0),
                latest.get(&t.id),
            )
        })
        .collect())
}

/// GET /api/transforms — list every transform (createdAt asc) with resolved
/// input dataset names, run counts and the latest run summary. No role guard
/// (legacy parity).
pub async fn list_transforms(State(state): State<AppState>) -> ApiResult<Response> {
    let transforms = serialized_transform_list(&state).await?;
    Ok(json_ok(serde_json::json!({ "transforms": transforms })))
}

/// POST /api/transforms — create a workbook (editor+). zod v4 messages via
/// the auth-reference helpers; duplicate name → exact legacy 400.
pub async fn create_transform(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;

    let v = parse_body(&body)?;
    let m = as_object(v)?;
    // Validation order = createSchema field order (zod reports the first).
    let name = req_str_min1_msg(&m, "name", "name is required")?;
    let description = opt_str_nullish(&m, "description")?.flatten();
    let language = opt_enum(&m, "language", LANGUAGES)?.unwrap_or("sql");
    let source_code = req_str_min1_msg(&m, "sourceCode", "sourceCode is required")?;
    let inputs = opt_str_array(&m, "inputs")?.unwrap_or_default();
    let output_dataset_name =
        req_str_min1_msg(&m, "outputDatasetName", "outputDatasetName is required")?;

    let id = mf_db::new_id();
    let inputs_json = Json(
        serde_json::to_value(&inputs).unwrap_or_else(|_| serde_json::Value::Array(Vec::new())),
    );
    let result = sqlx::query_as(&format!(
        "INSERT INTO transforms (id, name, description, language, source_code, inputs_json, \
         output_dataset_name) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING {TRANSFORM_COLS}"
    ))
    .bind(&id)
    .bind(name)
    .bind(description)
    .bind(language)
    .bind(source_code)
    .bind(inputs_json)
    .bind(output_dataset_name)
    .fetch_one(&state.db)
    .await;

    let transform: TransformRow = match result {
        Ok(t) => t,
        Err(sqlx::Error::Database(e)) if e.code().as_deref() == Some("23505") => {
            return Err(ApiError::bad_request(format!(
                "A transform named '{name}' already exists"
            )))
        }
        Err(e) => return Err(ApiError::internal(e.to_string())),
    };

    audit::audit(
        &state,
        &actor,
        AuditOptions::new("transform.create", "transform")
            .resource_id(Some(&transform.id))
            .resource_name(Some(&transform.name)),
    )
    .await;

    let names = resolve_input_names(&state, std::slice::from_ref(&transform)).await;
    Ok(json_created(serde_json::json!({
        "transform": serialize_transform(&transform, &names, 0, None),
    })))
}

/// Fetch one transform or the exact legacy 404.
pub async fn fetch_transform(
    state: &AppState,
    id: &str,
) -> Result<TransformRow, ApiError> {
    let row: Option<TransformRow> =
        sqlx::query_as(&format!("SELECT {TRANSFORM_COLS} FROM transforms WHERE id = $1"))
            .bind(id)
            .fetch_optional(&state.db)
            .await?;
    row.ok_or_else(|| ApiError::not_found(format!("Transform '{id}' not found")))
}

/// The transform's last `limit` runs, latest first.
pub async fn fetch_runs(
    state: &AppState,
    id: &str,
    limit: i64,
) -> Result<Vec<TransformRunRow>, sqlx::Error> {
    sqlx::query_as(&format!(
        "SELECT {RUN_COLS} FROM transform_runs WHERE transform_id = $1 \
         ORDER BY started_at DESC LIMIT $2"
    ))
    .bind(id)
    .bind(limit)
    .fetch_all(&state.db)
    .await
}

/// Shared detail payload: { transform, runs (last 10) }.
pub async fn detail_payload(
    state: &AppState,
    transform: &TransformRow,
) -> Result<serde_json::Value, ApiError> {
    let runs = fetch_runs(state, &transform.id, 10).await?;
    let names = resolve_input_names(state, std::slice::from_ref(transform)).await;
    // runsCount counts ALL runs, not just the fetched 10.
    let total: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM transform_runs WHERE transform_id = $1",
    )
    .bind(&transform.id)
    .fetch_one(&state.db)
    .await?;
    let serialized_runs: Vec<serde_json::Value> =
        runs.iter().map(serialize_transform_run).collect();
    Ok(serde_json::json!({
        "transform": serialize_transform(transform, &names, total.0, runs.first()),
        "runs": serialized_runs,
    }))
}

/// GET /api/transforms/{id} — detail = list shape + last 10 runs. No guard.
pub async fn get_transform(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let transform = fetch_transform(&state, &id).await?;
    Ok(json_ok(detail_payload(&state, &transform).await?))
}

/// PATCH /api/transforms/{id} — partial update (editor+). Body validation
/// runs BEFORE the row lookup (legacy: zod first, Prisma P2025 second).
pub async fn update_transform(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;

    let v = parse_body(&body)?;
    let m = as_object(v)?;
    // patchSchema field order: name, description, language, sourceCode,
    // inputs, outputDatasetName — all optional.
    let name = opt_str_min1_msg(&m, "name", "name is required")?;
    let description = opt_str_nullish(&m, "description")?;
    let language = opt_enum(&m, "language", LANGUAGES)?;
    let source_code = opt_str_min1_msg(&m, "sourceCode", "sourceCode is required")?;
    let inputs = opt_str_array(&m, "inputs")?;
    let output_dataset_name =
        opt_str_min1_msg(&m, "outputDatasetName", "outputDatasetName is required")?;

    // audit detail = provided field keys in schema order, comma-joined
    // (legacy `Object.keys(data).join(',') || null`).
    let detail_fields: Vec<&str> = [
        ("name", name.is_some()),
        ("description", description.is_some()),
        ("language", language.is_some()),
        ("sourceCode", source_code.is_some()),
        ("inputs", inputs.is_some()),
        ("outputDatasetName", output_dataset_name.is_some()),
    ]
    .into_iter()
    .filter(|(_, present)| *present)
    .map(|(k, _)| k)
    .collect();
    let detail = if detail_fields.is_empty() {
        None
    } else {
        Some(detail_fields.join(","))
    };

    // Merge onto the stored row and UPDATE ... RETURNING (RowNotFound → the
    // exact legacy 404; unique violation → the exact legacy 400).
    let result = sqlx::query_as(&format!(
        "UPDATE transforms SET \
           name = COALESCE($2, name), \
           description = CASE WHEN $3 THEN $4 ELSE description END, \
           language = COALESCE($5, language), \
           source_code = COALESCE($6, source_code), \
           inputs_json = COALESCE($7, inputs_json), \
           output_dataset_name = COALESCE($8, output_dataset_name), \
           updated_at = now() \
         WHERE id = $1 RETURNING {TRANSFORM_COLS}"
    ))
    .bind(&id)
    .bind(name)
    .bind(description.is_some())
    .bind(description.as_ref().and_then(|d| d.as_deref()))
    .bind(language)
    .bind(source_code)
    .bind(inputs.as_ref().map(|v| {
        Json(serde_json::to_value(v).unwrap_or_else(|_| serde_json::Value::Array(Vec::new())))
    }))
    .bind(output_dataset_name)
    .fetch_optional(&state.db)
    .await;

    let transform: TransformRow = match result {
        Ok(Some(t)) => t,
        Ok(None) => return Err(ApiError::not_found(format!("Transform '{id}' not found"))),
        Err(sqlx::Error::Database(e)) if e.code().as_deref() == Some("23505") => {
            return Err(ApiError::bad_request(format!(
                "A transform named '{}' already exists",
                name.unwrap_or("")
            )))
        }
        Err(e) => return Err(ApiError::internal(e.to_string())),
    };

    audit::audit(
        &state,
        &actor,
        AuditOptions::new("transform.update", "transform")
            .resource_id(Some(&transform.id))
            .resource_name(Some(&transform.name))
            .detail(detail.as_deref()),
    )
    .await;

    Ok(json_ok(detail_payload(&state, &transform).await?))
}

/// DELETE /api/transforms/{id} — editor+; runs cascade (FK ON DELETE
/// CASCADE = legacy Prisma onDelete: Cascade).
pub async fn delete_transform(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;

    let transform = fetch_transform(&state, &id).await?;
    sqlx::query("DELETE FROM transforms WHERE id = $1")
        .bind(&id)
        .execute(&state.db)
        .await?;

    audit::audit(
        &state,
        &actor,
        AuditOptions::new("transform.delete", "transform")
            .resource_id(Some(&transform.id))
            .resource_name(Some(&transform.name)),
    )
    .await;

    Ok(json_ok(serde_json::json!({ "ok": true })))
}

/// Build the engine snapshot for a live transform row.
pub fn snapshot_of(t: &TransformRow) -> TransformSnapshot {
    TransformSnapshot {
        id: t.id.clone(),
        language: t.language.clone(),
        source_code: t.source_code.clone(),
        input_ids: t.input_ids(),
        output_dataset_name: t.output_dataset_name.clone(),
    }
}
