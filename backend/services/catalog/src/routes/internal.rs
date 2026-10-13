//! /internal/* — service-to-service endpoints (contracts/INTERNAL_API.md,
//! "catalog" section). Every route rejects callers without the shared
//! `x-service-token` (constant-time compare via mf_auth RuntimeMode — pattern
//! copied from services/auth routes/internal.rs::require_service).

use axum::body::Bytes;
use axum::extract::Path;
use axum::http::HeaderMap;
use axum::response::Response;
use mf_types::{ColumnType, Row, SchemaColumn};
use mf_web::TenantState as State;
use mf_web::{json_created, json_ok, ApiError, ApiResult};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

use crate::dataset_service::{
    ensure_lineage_edge, get_dataset_version, head_version_number, prune_dataset_versions,
    resolve_consumer_version, write_version_lineage_edges, VersionLineageInput,
};
use crate::masking::mask_rows_internal;
use crate::publication::publish_approved;
use crate::routes::datasets::{list_datasets, load_detail};
use crate::routes::require_service;
use crate::rows::{normalize_rows, parse_json_text, rows_from_data_json};
use crate::state::{AppState, DatasetRow, VersionRow, DATASET_COLS, VERSION_COLS};
use crate::validate::{as_object, opt_rows_array, parse_body, req_str};
use crate::version_events::{emit_version_created, VersionCreatedInput};

// ─── Datasets ───────────────────────────────────────────────────────────

/// GET /internal/datasets — same list contract as the public route.
pub async fn internal_list_datasets(
    State(state): State<AppState>,
    headers: HeaderMap,
    query: axum::extract::Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    require_service(&state, &headers)?;
    let limit = lenient_int(query.get("limit"), 1, 200, 100);
    let offset = lenient_int(query.get("offset"), 0, 10_000, 0);
    let body = list_datasets(&state.db, limit, offset).await?;
    Ok(json_ok(body))
}

fn lenient_int(raw: Option<&String>, lo: i64, hi: i64, default: i64) -> i64 {
    let Some(raw) = raw.filter(|s| !s.is_empty()) else {
        return default;
    };
    let n = crate::jsval::js_parse_number(raw);
    if !n.is_finite() || n.fract() != 0.0 {
        return default;
    }
    (n as i64).clamp(lo, hi)
}

/// GET /internal/datasets/by-name/{name} — exact-name lookup (compute's
/// ensureDatasetByName). Returns the full detail payload; 404 when unknown.
pub async fn internal_dataset_by_name(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> ApiResult<Response> {
    require_service(&state, &headers)?;
    let dataset: Option<DatasetRow> = sqlx::query_as(&format!(
        "SELECT {DATASET_COLS} FROM datasets WHERE name = $1 ORDER BY created_at ASC, id ASC LIMIT 1"
    ))
    .bind(&name)
    .fetch_optional(&state.db)
    .await?;
    let Some(dataset) = dataset else {
        return Err(ApiError::not_found(format!("Dataset '{name}' not found")));
    };
    let detail = load_detail(&state, &dataset.id, None)
        .await
        .map_err(|_| ApiError::not_found(format!("Dataset '{}' not found", dataset.id)))?;
    Ok(json_ok(detail))
}

/// GET /internal/datasets/{id} — dataset detail (meta + versions head info).
pub async fn internal_dataset_detail(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    require_service(&state, &headers)?;
    let detail = load_detail(&state, &id, None)
        .await
        .map_err(|_| ApiError::not_found(format!("Dataset '{id}' not found")))?;
    Ok(json_ok(detail))
}

/// POST /internal/datasets — create an (empty) dataset → summary (201).
pub async fn internal_create_dataset(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    require_service(&state, &headers)?;
    let v = parse_body(&body)?;
    let m = as_object(v)?;
    let name = req_str(&m, "name")?;
    if name.trim().is_empty() {
        return Err(ApiError::bad_request(
            "name: Too small: expected string to have >=1 chars",
        ));
    }
    let description = m.get("description").and_then(|d| d.as_str());
    let project_id = m.get("projectId").and_then(|d| d.as_str());
    let tags: Vec<String> = match m.get("tags") {
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(|t| t.as_str().map(String::from))
            .collect(),
        None | Some(Value::Null) => Vec::new(),
        Some(_) => return Err(ApiError::bad_request("tags: Invalid input: expected array")),
    };

    let dataset: DatasetRow = sqlx::query_as(&format!(
        "INSERT INTO datasets (id, name, description, project_id, tags) \
         VALUES ($1, $2, $3, $4, $5) RETURNING {DATASET_COLS}"
    ))
    .bind(mf_db::new_id())
    .bind(name)
    .bind(description)
    .bind(project_id)
    .bind(sqlx::types::Json(&tags))
    .fetch_one(&state.db)
    .await?;

    Ok(json_created(crate::state::serialize_dataset_summary(
        &dataset, None, 0,
    )))
}

// ─── Versions ───────────────────────────────────────────────────────────

struct VersionTarget {
    name: String,
    quality_gate: bool,
}

/// Resolve `{n}` ("head" | positive integer) to a version row.
/// head → resolveConsumerVersion semantics (gate-aware).
async fn resolve_internal_version(
    state: &AppState,
    dataset_id: &str,
    n: &str,
) -> ApiResult<VersionRow> {
    let dataset: Option<VersionTarget> =
        sqlx::query_as("SELECT name, quality_gate FROM datasets WHERE id = $1")
            .bind(dataset_id)
            .fetch_optional(&state.db)
            .await?
            .map(|(name, quality_gate)| VersionTarget { name, quality_gate });
    let Some(dataset) = dataset else {
        return Err(ApiError::not_found(format!(
            "Dataset '{dataset_id}' not found"
        )));
    };

    let selected: Option<i32> = if n == "head" {
        let consumer = resolve_consumer_version(&state.db, dataset_id).await?;
        match consumer.and_then(|c| c.version_number) {
            Some(v) => Some(v),
            None => {
                return Err(ApiError::not_found(if dataset.quality_gate {
                    format!("Dataset '{}' has no published version", dataset.name)
                } else {
                    format!("Dataset '{}' has no versions", dataset.name)
                }))
            }
        }
    } else {
        let parsed = crate::jsval::js_parse_number(n);
        if !parsed.is_finite() || parsed.fract() != 0.0 || parsed < 1.0 {
            return Err(ApiError::bad_request(format!(
                "Invalid version number '{n}'"
            )));
        }
        Some(parsed as i32)
    };

    let version = get_dataset_version(&state.db, dataset_id, selected).await?;
    version.ok_or_else(|| {
        ApiError::not_found(format!(
            "Version {} not found for dataset '{}'",
            selected.unwrap_or(0),
            dataset.name
        ))
    })
}

fn version_meta_json(v: &VersionRow) -> Value {
    json!({
        "id": v.id,
        "datasetId": v.dataset_id,
        "versionNumber": v.version_number,
        "schema": v.schema_json.0,
        "rowCount": v.row_count,
        "createdBy": v.created_by,
        "createdAt": crate::state::ts(&v.created_at),
        "branch": v.branch,
        "parentVersion": v.parent_version,
        "lifecycle": v.lifecycle,
        "qualityState": v.quality_state,
        "outputJobId": v.output_job_id,
    })
}

/// GET /internal/datasets/{id}/versions/{n}
pub async fn internal_get_version(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, n)): Path<(String, String)>,
) -> ApiResult<Response> {
    require_service(&state, &headers)?;
    let version = resolve_internal_version(&state, &id, &n).await?;
    let mut detail = version_meta_json(&version);
    detail["failingRules"] =
        json!(
            crate::publication::failing_error_rules(&state.db, &id, version.version_number,)
                .await
                .into_iter()
                .map(|(name, message)| json!({ "name": name, "message": message }))
                .collect::<Vec<_>>()
        );
    Ok(json_ok(detail))
}

/// Read rows with offset/limit (indexed storage first, dataJson fallback).
async fn read_rows_offset_limit(
    state: &AppState,
    dataset_id: &str,
    version: &VersionRow,
    offset: i64,
    limit: Option<i64>,
) -> ApiResult<(Vec<Row>, i64)> {
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM dataset_version_rows WHERE dataset_id = $1 AND version_number = $2",
    )
    .bind(dataset_id)
    .bind(version.version_number)
    .fetch_one(&state.db)
    .await?;
    if count > 0 {
        let rows: Vec<(String,)> = match limit {
            Some(limit) => {
                sqlx::query_as(
                    "SELECT row_data FROM dataset_version_rows \
                     WHERE dataset_id = $1 AND version_number = $2 \
                     ORDER BY row_index ASC LIMIT $3 OFFSET $4",
                )
                .bind(dataset_id)
                .bind(version.version_number)
                .bind(limit)
                .bind(offset)
                .fetch_all(&state.db)
                .await?
            }
            None => {
                sqlx::query_as(
                    "SELECT row_data FROM dataset_version_rows \
                     WHERE dataset_id = $1 AND version_number = $2 ORDER BY row_index ASC OFFSET $3",
                )
                .bind(dataset_id)
                .bind(version.version_number)
                .bind(offset)
                .fetch_all(&state.db)
                .await?
            }
        };
        let rows = rows
            .into_iter()
            .map(|(data,)| parse_json_text::<Row>(&data, Map::new()))
            .collect();
        return Ok((rows, count));
    }
    let all = rows_from_data_json(&version.data_json);
    let total = all.len() as i64;
    let start = offset.max(0) as usize;
    let rows: Vec<Row> = all
        .into_iter()
        .skip(start)
        .take(limit.map(|l| l.max(0) as usize).unwrap_or(usize::MAX))
        .collect();
    Ok((rows, total))
}

/// GET /internal/datasets/{id}/versions/{n}/rows?offset=&limit=&role=
pub async fn internal_version_rows(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, n)): Path<(String, String)>,
    query: axum::extract::Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    require_service(&state, &headers)?;
    let version = resolve_internal_version(&state, &id, &n).await?;
    let offset = lenient_int(query.get("offset"), 0, i64::MAX, 0);
    let limit_raw = query.get("limit").filter(|s| !s.is_empty());
    let limit = limit_raw.map(|_| lenient_int(query.get("limit"), 0, i64::MAX, 5000));
    let role = crate::routes::internal_role_param(&query);

    let (rows, total) = read_rows_offset_limit(&state, &id, &version, offset, limit).await?;
    let resolved = version.version_number;
    let schema = version.schema_json.0.clone();
    let (rows, masked_columns) = mask_rows_internal(&state, &id, rows, role.as_deref()).await;
    Ok(json_ok(json!({
        "rows": rows,
        "total": total,
        "offset": offset,
        "limit": limit,
        // RESOLVED version (n=head awareness) + schema for run-manifest capture
        "versionNumber": resolved,
        "schema": schema,
        "maskedColumns": masked_columns,
    })))
}

/// GET /internal/datasets/{id}/versions/{n}/rows/all?role=
pub async fn internal_version_rows_all(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, n)): Path<(String, String)>,
    query: axum::extract::Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    require_service(&state, &headers)?;
    let version = resolve_internal_version(&state, &id, &n).await?;
    let role = crate::routes::internal_role_param(&query);
    let (rows, total) = read_rows_offset_limit(&state, &id, &version, 0, None).await?;
    let resolved = version.version_number;
    let schema = version.schema_json.0.clone();
    let (rows, masked_columns) = mask_rows_internal(&state, &id, rows, role.as_deref()).await;
    Ok(json_ok(json!({
        "rows": rows,
        "total": total,
        "versionNumber": resolved,
        "schema": schema,
        "maskedColumns": masked_columns,
    })))
}

/// DELETE /internal/datasets/{id}/versions/{n} — remove one version's rows +
/// version record (orchestration output cleanup). Rolls the consumer pointer
/// back to the previous main version when the deleted one was published
/// (legacy pipeline-output DELETE semantics). 404 when absent.
pub async fn internal_delete_version(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, n)): Path<(String, String)>,
) -> ApiResult<Response> {
    require_service(&state, &headers)?;
    let version_number = {
        let parsed = crate::jsval::js_parse_number(&n);
        if !parsed.is_finite() || parsed.fract() != 0.0 || parsed < 1.0 {
            return Err(ApiError::bad_request(format!(
                "Invalid version number '{n}'"
            )));
        }
        parsed as i32
    };
    let dataset: Option<(String, Option<i32>)> =
        sqlx::query_as("SELECT name, published_version FROM datasets WHERE id = $1")
            .bind(&id)
            .fetch_optional(&state.db)
            .await?;
    let Some((dataset_name, published_version)) = dataset else {
        return Err(ApiError::not_found(format!("Dataset '{id}' not found")));
    };
    let version: Option<(String,)> = sqlx::query_as(
        "SELECT id FROM dataset_versions WHERE dataset_id = $1 AND version_number = $2",
    )
    .bind(&id)
    .bind(version_number)
    .fetch_optional(&state.db)
    .await?;
    if version.is_none() {
        return Err(ApiError::not_found(format!(
            "Version {version_number} not found for dataset '{dataset_name}'"
        )));
    }

    let mut tx = state.db.begin().await?;
    sqlx::query("DELETE FROM dataset_version_rows WHERE dataset_id = $1 AND version_number = $2")
        .bind(&id)
        .bind(version_number)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM quality_results WHERE dataset_id = $1 AND version_number = $2")
        .bind(&id)
        .bind(version_number)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "DELETE FROM version_lineage_edges WHERE to_dataset_id = $1 AND to_version_number = $2",
    )
    .bind(&id)
    .bind(version_number)
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM dataset_versions WHERE dataset_id = $1 AND version_number = $2")
        .bind(&id)
        .bind(version_number)
        .execute(&mut *tx)
        .await?;
    if published_version == Some(version_number) {
        // roll the consumer pointer back to the previous main version (or null)
        let previous: Option<i32> = sqlx::query_scalar(
            "SELECT max(version_number) FROM dataset_versions \
             WHERE dataset_id = $1 AND branch = 'main' AND version_number < $2",
        )
        .bind(&id)
        .bind(version_number)
        .fetch_one(&mut *tx)
        .await?;
        sqlx::query("UPDATE datasets SET published_version = $2, updated_at = now() WHERE id = $1")
            .bind(&id)
            .bind(previous)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;

    Ok(json_ok(json!({
        "ok": true,
        "removed": "version",
        "datasetId": id,
        "versionNumber": version_number,
    })))
}

/// DELETE /internal/datasets/{id} — full dataset delete (same cleanup as the
/// public DELETE: lineage edges manually, everything else cascades). 404 when
/// absent.
pub async fn internal_delete_dataset(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    require_service(&state, &headers)?;
    let dataset: Option<(String, String)> =
        sqlx::query_as("SELECT id, name FROM datasets WHERE id = $1")
            .bind(&id)
            .fetch_optional(&state.db)
            .await?;
    let Some((dataset_id, dataset_name)) = dataset else {
        return Err(ApiError::not_found(format!("Dataset '{id}' not found")));
    };
    sqlx::query("DELETE FROM lineage_edges WHERE from_dataset_id = $1 OR to_dataset_id = $1")
        .bind(&id)
        .execute(&state.db)
        .await?;
    sqlx::query("DELETE FROM datasets WHERE id = $1")
        .bind(&id)
        .execute(&state.db)
        .await?;
    Ok(json_ok(
        json!({ "ok": true, "deleted": dataset_id, "name": dataset_name }),
    ))
}

/// POST /internal/datasets/{id}/versions — THE single version-write door:
/// schema inference when absent, outputJobId idempotency, row storage,
/// VersionLineageEdge/LineageEdge writes from `inputs`, quality auto-eval and
/// the consumable-gated mf.dataset.version.created event + watcher notifies.
pub async fn internal_append_version(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> ApiResult<Response> {
    require_service(&state, &headers)?;
    let v = parse_body(&body)?;
    let m = as_object(v)?;
    let created_by = req_str(&m, "createdBy")?;

    let dataset: Option<DatasetRow> = sqlx::query_as(&format!(
        "SELECT {DATASET_COLS} FROM datasets WHERE id = $1"
    ))
    .bind(&id)
    .fetch_optional(&state.db)
    .await?;
    let Some(dataset) = dataset else {
        return Err(ApiError::not_found(format!("Dataset '{id}' not found")));
    };

    let rows = opt_rows_array(&m, "rows")?.unwrap_or_default();
    if rows.len() > state.max_rows {
        return Err(ApiError::bad_request(format!(
            "Dataset version has {} rows; the current storage limit is {}. No rows were written.",
            rows.len(),
            state.max_rows
        )));
    }

    // outputJobId idempotency — on conflict return the EXISTING version.
    let output_job_id = m
        .get("outputJobId")
        .and_then(|v| v.as_str())
        .map(String::from);
    if let Some(job_id) = &output_job_id {
        let existing: Option<VersionRow> = sqlx::query_as(&format!(
            "SELECT {VERSION_COLS} FROM dataset_versions WHERE output_job_id = $1"
        ))
        .bind(job_id)
        .fetch_optional(&state.db)
        .await?;
        if let Some(existing) = existing {
            return Ok(json_ok(json!({
                "datasetId": existing.dataset_id,
                "versionNumber": existing.version_number,
                "rowCount": existing.row_count,
            })));
        }
    }

    let normalized = normalize_rows(&rows);
    let schema = match m.get("schema") {
        Some(Value::Array(arr)) => {
            let mut cols = Vec::with_capacity(arr.len());
            for item in arr {
                let name = item
                    .get("name")
                    .and_then(|n| n.as_str())
                    .ok_or_else(|| {
                        ApiError::bad_request("schema: Invalid input: expected { name, type }")
                    })?
                    .to_string();
                let type_str = item
                    .get("type")
                    .and_then(|t| t.as_str())
                    .unwrap_or("string");
                let column_type = match type_str {
                    "string" => ColumnType::String,
                    "number" => ColumnType::Number,
                    "boolean" => ColumnType::Boolean,
                    other => {
                        return Err(ApiError::bad_request(format!(
                            "schema: invalid column type '{other}'"
                        )))
                    }
                };
                cols.push(SchemaColumn { name, column_type });
            }
            cols
        }
        None | Some(Value::Null) => crate::rows::infer_schema(&normalized),
        Some(_) => {
            return Err(ApiError::bad_request(
                "schema: Invalid input: expected array",
            ))
        }
    };

    let branch = m
        .get("branch")
        .and_then(|b| b.as_str())
        .filter(|b| !b.is_empty())
        .unwrap_or("main")
        .to_string();
    let lifecycle = match m.get("lifecycle").and_then(|l| l.as_str()) {
        None => {
            if dataset.quality_gate {
                "draft".to_string()
            } else {
                "published".to_string()
            }
        }
        Some("draft") | Some("published") => m["lifecycle"].as_str().unwrap().to_string(),
        Some(other) => {
            return Err(ApiError::bad_request(format!(
                "lifecycle: Invalid option: expected one of \"draft\"|\"published\" (got '{other}')"
            )))
        }
    };
    let parent_version = m
        .get("parentVersion")
        .and_then(|p| p.as_i64())
        .map(|p| p as i32);
    let run_id = m.get("runId").and_then(|v| v.as_str()).map(String::from);
    let pipeline_id = m
        .get("pipelineId")
        .and_then(|v| v.as_str())
        .map(String::from);
    let transform_run_id = m
        .get("transformRunId")
        .and_then(|v| v.as_str())
        .map(String::from);
    let transform_id = m
        .get("transformId")
        .and_then(|v| v.as_str())
        .map(String::from);
    let source = m.get("source").and_then(|v| v.as_str()).map(String::from);
    let cascade_parent_run_id = m
        .get("cascadeParentRunId")
        .and_then(|v| v.as_str())
        .map(String::from);
    let cascade_depth = m
        .get("cascadeDepth")
        .and_then(|v| v.as_i64())
        .map(|d| d as i32);

    let data_json = crate::rows::data_json_string(&normalized);

    // Insert with a bounded retry on (dataset_id, version_number) races —
    // the counter is shared across branches, concurrent writers may collide.
    let mut version: Option<VersionRow> = None;
    for _attempt in 0..3 {
        let next = head_version_number(&state.db, &id).await? + 1;
        let result = sqlx::query_as(&format!(
            "INSERT INTO dataset_versions (id, dataset_id, version_number, schema_json, row_count, \
              data_json, created_by, output_job_id, branch, parent_version, lifecycle) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING {VERSION_COLS}"
        ))
        .bind(mf_db::new_id())
        .bind(&id)
        .bind(next)
        .bind(sqlx::types::Json(&schema))
        .bind(normalized.len() as i32)
        .bind(&data_json)
        .bind(created_by)
        .bind(&output_job_id)
        .bind(&branch)
        .bind(parent_version)
        .bind(&lifecycle)
        .fetch_optional(&state.db)
        .await;
        match result {
            Ok(Some(v)) => {
                version = Some(v);
                break;
            }
            Ok(None) => unreachable!(),
            Err(sqlx::Error::Database(db_err)) => {
                if db_err.is_unique_violation() {
                    // outputJobId race → the winner's version is the answer.
                    if let Some(job_id) = &output_job_id {
                        let existing: Option<VersionRow> = sqlx::query_as(&format!(
                            "SELECT {VERSION_COLS} FROM dataset_versions WHERE output_job_id = $1"
                        ))
                        .bind(job_id)
                        .fetch_optional(&state.db)
                        .await?;
                        if let Some(existing) = existing {
                            return Ok(json_ok(json!({
                                "datasetId": existing.dataset_id,
                                "versionNumber": existing.version_number,
                                "rowCount": existing.row_count,
                            })));
                        }
                    }
                    continue; // version-number race → recompute head and retry
                }
                return Err(ApiError::from(sqlx::Error::Database(db_err)));
            }
            Err(e) => return Err(ApiError::from(e)),
        }
    }
    let Some(version) = version else {
        return Err(ApiError::internal(
            "could not allocate a version number (concurrent writers); retry",
        ));
    };
    let next = version.version_number;

    // Dataset touch + consumer pointer (gate off → immediately consumable).
    if dataset.quality_gate {
        sqlx::query("UPDATE datasets SET updated_at = now() WHERE id = $1")
            .bind(&id)
            .execute(&state.db)
            .await?;
    } else {
        sqlx::query("UPDATE datasets SET updated_at = now(), published_version = $2 WHERE id = $1")
            .bind(&id)
            .bind(next)
            .execute(&state.db)
            .await?;
    }

    // Indexed row storage for paged reads.
    crate::rows::write_version_rows(&state.db, &id, next, &normalized).await?;

    // Lineage from `inputs`: dataset-level edges (deduped) + version-level
    // edges (first per dataset wins — engine semantics).
    let inputs: Vec<(String, Option<i32>)> = match m.get("inputs") {
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(|i| {
                i.get("datasetId").and_then(|d| d.as_str()).map(|d| {
                    (
                        d.to_string(),
                        i.get("versionNumber")
                            .and_then(|v| v.as_i64())
                            .map(|v| v as i32),
                    )
                })
            })
            .collect(),
        _ => Vec::new(),
    };
    let mut seen_datasets: HashSet<String> = HashSet::new();
    for (from_id, _) in &inputs {
        if seen_datasets.insert(from_id.clone()) {
            if let Err(e) =
                ensure_lineage_edge(&state.db, from_id, &id, pipeline_id.as_deref()).await
            {
                tracing::warn!(error = %e, "lineage edge upsert failed (swallowed)");
            }
        }
    }
    let mut seen_version_inputs: HashSet<String> = HashSet::new();
    let mut version_edges: Vec<VersionLineageInput> = Vec::new();
    for (from_id, from_version) in &inputs {
        let Some(from_version) = from_version else {
            continue;
        };
        if !seen_version_inputs.insert(from_id.clone()) {
            continue;
        }
        version_edges.push(VersionLineageInput {
            run_id: run_id.clone(),
            pipeline_id: pipeline_id.clone(),
            transform_run_id: transform_run_id.clone(),
            transform_id: transform_id.clone(),
            from_dataset_id: from_id.clone(),
            from_version_number: *from_version,
            to_dataset_id: id.clone(),
            to_version_number: next,
        });
    }
    write_version_lineage_edges(&state.db, &version_edges).await;

    // Retention (createDatasetFromRows semantics).
    prune_dataset_versions(&state.db, &id, dataset.keep_last_n).await?;

    // Quality auto-eval + consumable-gated version event + watcher notifies.
    let trigger_source = source.clone().or_else(|| {
        pipeline_id
            .as_ref()
            .map(|p| format!("pipeline:{p}"))
            .or_else(|| transform_run_id.as_ref().map(|t| format!("transform:{t}")))
    });
    emit_version_created(
        &state,
        VersionCreatedInput {
            dataset_id: id.clone(),
            version_number: next,
            source: trigger_source,
            cascade_parent_run_id,
            cascade_depth,
            consumable: !dataset.quality_gate || lifecycle == "published",
        },
    )
    .await;

    Ok(json_created(json!({
        "datasetId": id,
        "versionNumber": next,
        "rowCount": normalized.len(),
    })))
}

/// POST /internal/datasets/{id}/publish-approved {versionNumber} — governance
/// callback after an approval decision: idempotent draft→published flip plus
/// the version event (see publication.rs).
pub async fn internal_publish_approved(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> ApiResult<Response> {
    require_service(&state, &headers)?;
    let v = parse_body(&body)?;
    let m = as_object(v)?;
    let version_number = m
        .get("versionNumber")
        .and_then(|n| n.as_i64())
        .filter(|n| *n >= 1)
        .ok_or_else(|| {
            ApiError::bad_request("versionNumber: Invalid input: expected positive integer")
        })? as i32;
    let approval_id = m.get("approvalId").and_then(|v| v.as_str());
    let decided_by = m.get("decidedBy").and_then(|v| v.as_str());

    let outcome = publish_approved(&state, &id, version_number, approval_id, decided_by)
        .await
        .map_err(|e| e.into_api_error())?;
    Ok(json_ok(json!({
        "datasetId": outcome.dataset_id,
        "datasetName": outcome.dataset_name,
        "versionNumber": outcome.version_number,
        "qualityState": outcome.quality_state,
        "publishedVersion": outcome.published_version,
    })))
}

// ─── Lineage / health / search / stats / curriculum / reset ─────────────

/// GET /internal/lineage/dataset/{id} — downstream edges for impact fan-out.
pub async fn internal_lineage_dataset(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    require_service(&state, &headers)?;
    let edges: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT from_dataset_id, to_dataset_id, pipeline_id FROM lineage_edges \
         WHERE from_dataset_id = $1 ORDER BY created_at ASC, id ASC",
    )
    .bind(&id)
    .fetch_all(&state.db)
    .await?;
    Ok(json_ok(json!({
        "edges": edges.iter().map(|(f, t, p)| json!({
            "fromDatasetId": f,
            "toDatasetId": t,
            "pipelineId": p,
        })).collect::<Vec<_>>(),
    })))
}

/// GET /internal/health/datasets — freshness list for platform health.
pub async fn internal_health_datasets(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    require_service(&state, &headers)?;
    #[derive(sqlx::FromRow)]
    struct HealthRow {
        id: String,
        name: String,
        updated_at: chrono::DateTime<chrono::Utc>,
        row_count: Option<i32>,
    }
    let datasets: Vec<HealthRow> = sqlx::query_as(
        "SELECT d.id, d.name, d.updated_at, \
                (SELECT v.row_count FROM dataset_versions v WHERE v.dataset_id = d.id \
                 ORDER BY v.version_number DESC LIMIT 1) AS row_count \
         FROM datasets d ORDER BY d.updated_at DESC, d.id ASC",
    )
    .fetch_all(&state.db)
    .await?;
    let now = chrono::Utc::now();
    let out: Vec<Value> = datasets
        .iter()
        .map(|d| {
            let age_minutes = (now - d.updated_at).num_milliseconds() as f64 / 60_000.0;
            json!({
                "id": d.id,
                "name": d.name,
                "rowCount": d.row_count.unwrap_or(0),
                "updatedAt": crate::state::ts(&d.updated_at),
                "freshnessMinutes": js_max0(js_round_ms(age_minutes)),
            })
        })
        .collect();
    Ok(json_ok(json!(out)))
}

fn js_round_ms(age_minutes: f64) -> i64 {
    crate::jsval::js_round(age_minutes)
}

fn js_max0(n: i64) -> i64 {
    n.max(0)
}

fn like_pattern(q: &str) -> String {
    let mut out = String::with_capacity(q.len() + 2);
    out.push('%');
    for c in q.chars() {
        match c {
            '%' | '_' | '\\' => {
                out.push('\\');
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out.push('%');
    out
}

/// GET /internal/search?q= — dataset/project/connector matches in the public
/// SearchResultItem shape (governance merges the fan-out).
pub async fn internal_search(
    State(state): State<AppState>,
    headers: HeaderMap,
    query: axum::extract::Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    require_service(&state, &headers)?;
    let q = query.get("q").map(|s| s.trim()).unwrap_or("").to_string();
    if q.is_empty() {
        return Ok(json_ok(json!({ "results": [] })));
    }
    let pattern = like_pattern(&q);

    let datasets: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT id, name, description FROM datasets \
         WHERE name ILIKE $1 OR description ILIKE $1 ORDER BY updated_at DESC, id ASC LIMIT 10",
    )
    .bind(&pattern)
    .fetch_all(&state.db)
    .await?;
    let projects: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT id, name, description FROM projects \
         WHERE name ILIKE $1 ORDER BY created_at ASC, id ASC LIMIT 10",
    )
    .bind(&pattern)
    .fetch_all(&state.db)
    .await?;
    let connectors: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT id, name, type FROM connectors WHERE name ILIKE $1 ORDER BY name ASC, id ASC LIMIT 10",
    )
    .bind(&pattern)
    .fetch_all(&state.db)
    .await?;

    let mut results: Vec<Value> = Vec::new();
    for (id, name, description) in datasets {
        results.push(json!({
            "type": "dataset",
            "id": id,
            "title": name,
            "subtitle": description,
            "href": format!("/datasets/{id}"),
        }));
    }
    for (id, name, description) in projects {
        results.push(json!({
            "type": "project",
            "id": id,
            "title": name,
            "subtitle": description,
            "href": "/projects",
        }));
    }
    for (id, name, ctype) in connectors {
        results.push(json!({
            "type": "connector",
            "id": id,
            "title": name,
            "subtitle": ctype,
            "href": "/connectors",
        }));
    }
    results.truncate(20);
    Ok(json_ok(json!({ "results": results })))
}

/// GET /internal/stats — counts for the governance stats merge (plus the
/// additive totalRows/recentDatasets the public /api/stats fixture needs).
pub async fn internal_stats(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    require_service(&state, &headers)?;
    let (projects, datasets, dataset_versions, connectors, ingestions): (i64, i64, i64, i64, i64) =
        sqlx::query_as(
            "SELECT (SELECT count(*) FROM projects), (SELECT count(*) FROM datasets), \
                    (SELECT count(*) FROM dataset_versions), (SELECT count(*) FROM connectors), \
                    (SELECT count(*) FROM ingestions)",
        )
        .fetch_one(&state.db)
        .await?;
    let total_rows: Option<i64> = sqlx::query_scalar(
        "SELECT sum(v.row_count) FROM dataset_versions v \
         JOIN (SELECT dataset_id, max(version_number) AS mv FROM dataset_versions GROUP BY dataset_id) m \
           ON m.dataset_id = v.dataset_id AND m.mv = v.version_number",
    )
    .fetch_one(&state.db)
    .await?;

    #[derive(sqlx::FromRow)]
    struct RecentRow {
        id: String,
        name: String,
        updated_at: chrono::DateTime<chrono::Utc>,
        row_count: Option<i32>,
    }
    let recent: Vec<RecentRow> = sqlx::query_as(
        "SELECT d.id, d.name, d.updated_at, \
                (SELECT v.row_count FROM dataset_versions v WHERE v.dataset_id = d.id \
                 ORDER BY v.version_number DESC LIMIT 1) AS row_count \
         FROM datasets d ORDER BY d.updated_at DESC, d.id ASC LIMIT 5",
    )
    .fetch_all(&state.db)
    .await?;

    Ok(json_ok(json!({
        "projects": projects,
        "datasets": datasets,
        "datasetVersions": dataset_versions,
        "connectors": connectors,
        "ingestions": ingestions,
        // additive (public /api/stats needs these from the catalog domain):
        "totalRows": total_rows.unwrap_or(0),
        "recentDatasets": recent.iter().map(|d| json!({
            "id": d.id,
            "name": d.name,
            "rowCount": d.row_count.unwrap_or(0),
            "updatedAt": crate::state::ts(&d.updated_at),
        })).collect::<Vec<_>>(),
    })))
}

/// GET /internal/curriculum-state — flags/counts for the curriculum verifier.
pub async fn internal_curriculum_state(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    require_service(&state, &headers)?;
    macro_rules! count {
        ($q:expr) => {
            sqlx::query_scalar::<_, i64>($q)
                .fetch_one(&state.db)
                .await?
        };
    }
    Ok(json_ok(json!({
        "projects": count!("SELECT count(*) FROM projects"),
        "connectors": count!("SELECT count(*) FROM connectors"),
        "ingestions": count!("SELECT count(*) FROM ingestions"),
        "ingestionsSuccess": count!("SELECT count(*) FROM ingestions WHERE status = 'success'"),
        "datasets": count!("SELECT count(*) FROM datasets"),
        "datasetVersions": count!("SELECT count(*) FROM dataset_versions"),
        "publishedVersions": count!("SELECT count(*) FROM dataset_versions WHERE lifecycle = 'published'"),
        "draftVersions": count!("SELECT count(*) FROM dataset_versions WHERE lifecycle = 'draft'"),
        "gatedDatasets": count!("SELECT count(*) FROM datasets WHERE quality_gate"),
        "branches": count!("SELECT count(*) FROM dataset_branches"),
        "mergedBranches": count!("SELECT count(*) FROM dataset_branches WHERE merged_at IS NOT NULL"),
        "qualityRules": count!("SELECT count(*) FROM quality_rules"),
        "qualityResults": count!("SELECT count(*) FROM quality_results"),
        "comments": count!("SELECT count(*) FROM dataset_comments"),
        "watchers": count!("SELECT count(*) FROM dataset_watchers"),
        "lineageEdges": count!("SELECT count(*) FROM lineage_edges"),
        "versionLineageEdges": count!("SELECT count(*) FROM version_lineage_edges"),
    })))
}

/// POST /internal/reset — wipe every catalog table (governance settings/reset
/// fan-out). Returns legacy-keyed per-table counts + resetAt.
pub async fn internal_reset(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    require_service(&state, &headers)?;
    let mut tx = state.db.begin().await?;
    macro_rules! del {
        ($table:expr) => {{
            let r = sqlx::query(&format!("DELETE FROM {}", $table))
                .execute(&mut *tx)
                .await?;
            r.rows_affected() as i64
        }};
    }
    // FK-safe order; explicit deletes so every table can be counted
    // (legacy resetWorkspace semantics).
    let quality_results = del!("quality_results");
    let quality_rules = del!("quality_rules");
    let dataset_branches = del!("dataset_branches");
    let dataset_comments = del!("dataset_comments");
    let dataset_watchers = del!("dataset_watchers");
    let dataset_version_rows = del!("dataset_version_rows");
    let dataset_versions = del!("dataset_versions");
    let lineage_edges = del!("lineage_edges");
    let version_lineage_edges = del!("version_lineage_edges");
    let datasets = del!("datasets");
    let ingestions = del!("ingestions");
    let connectors = del!("connectors");
    let projects = del!("projects");
    tx.commit().await?;

    Ok(json_ok(json!({
        "resetAt": mf_types::ts::format(&chrono::Utc::now()),
        "counts": {
            "qualityResults": quality_results,
            "qualityRules": quality_rules,
            "datasetBranches": dataset_branches,
            "datasetComments": dataset_comments,
            "datasetWatchers": dataset_watchers,
            "datasetVersionRows": dataset_version_rows,
            "datasetVersions": dataset_versions,
            "lineageEdges": lineage_edges,
            "versionLineageEdges": version_lineage_edges,
            "datasets": datasets,
            "ingestions": ingestions,
            "connectors": connectors,
            "projects": projects,
        },
    })))
}

// ─── helpers used by main.rs (approval consumer) ────────────────────────

/// Shared entry for the mf.approval.decided consumer (idempotent).
pub async fn handle_approval_decided(
    state: &AppState,
    target_id: &str,
    version_number: i32,
    approval_id: &str,
    decided_by: &str,
) -> Result<(), String> {
    publish_approved(
        state,
        target_id,
        version_number,
        Some(approval_id),
        Some(decided_by),
    )
    .await
    .map(|_| ())
    .map_err(|e| e.message)
}
