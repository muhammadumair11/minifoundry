//! /api/datasets — catalog listing + dataset detail/update/delete (ports
//! datasets/route.ts and datasets/[id]/route.ts). The detail payload builder
//! is shared with the internal datasets endpoints.

use axum::body::Bytes;
use axum::extract::Path;
use axum::http::HeaderMap;
use axum::response::Response;
use mf_web::TenantState as State;
use mf_web::{actor_from_headers, json_ok, require_role, ApiError, ApiResult};
use serde_json::{json, Value};
use sqlx::PgPool;

use crate::audit::{audit, AuditOptions};
use crate::masking::{fetch_markings, mask_schema};
use crate::provenance::resolve_provenance_many;
use crate::publication::set_quality_gate;
use crate::state::{
    serialize_dataset_summary, AppState, DatasetRow, VersionHeadRow, VersionMetaRow, DATASET_COLS,
};
use crate::validate::{
    as_object, coerce_int_param, finish_query_issues, opt_bool, opt_int_bounded, opt_str_nullish,
    parse_body, req_str_min1_custom, Nullish,
};
use std::collections::HashMap;

/// Shared list implementation (public GET /api/datasets and internal
/// GET /internal/datasets use the SAME contract).
pub async fn list_datasets(pool: &PgPool, limit: i64, offset: i64) -> Result<Value, sqlx::Error> {
    let datasets: Vec<DatasetRow> = sqlx::query_as(&format!(
        "SELECT {DATASET_COLS} FROM datasets ORDER BY updated_at DESC, id ASC LIMIT $1 OFFSET $2"
    ))
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;
    let total: i64 = sqlx::query_scalar("SELECT count(*) FROM datasets")
        .fetch_one(pool)
        .await?;

    // Per-dataset MAIN version count + head version number (one groupBy).
    let stats: Vec<(String, i64, Option<i32>)> = sqlx::query_as(
        "SELECT dataset_id, count(*), max(version_number) FROM dataset_versions \
         WHERE branch = 'main' GROUP BY dataset_id",
    )
    .fetch_all(pool)
    .await?;
    let stat_by_id: HashMap<String, (i64, i32)> = stats
        .into_iter()
        .map(|(id, count, head)| (id, (count, head.unwrap_or(0))))
        .collect();

    // Head rows for the current page (single targeted query).
    let page_ids: Vec<String> = datasets.iter().map(|d| d.id.clone()).collect();
    let heads: Vec<VersionHeadRow> = if page_ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as(
            "SELECT v.dataset_id, v.version_number, v.row_count, v.schema_json \
             FROM dataset_versions v \
             JOIN (SELECT dataset_id, max(version_number) AS mv FROM dataset_versions \
                   WHERE branch = 'main' AND dataset_id = ANY($1) GROUP BY dataset_id) m \
               ON m.dataset_id = v.dataset_id AND m.mv = v.version_number \
             WHERE v.dataset_id = ANY($1)",
        )
        .bind(&page_ids)
        .fetch_all(pool)
        .await?
    };
    let head_by_dataset: HashMap<String, VersionHeadRow> = heads
        .into_iter()
        .map(|h| (h.dataset_id.clone(), h))
        .collect();

    let drafts: Vec<(String, i32)> = sqlx::query_as(
        "SELECT dataset_id, max(version_number) FROM dataset_versions \
         WHERE dataset_id = ANY($1) AND branch = 'main' AND lifecycle = 'draft' GROUP BY dataset_id",
    )
    .bind(&page_ids)
    .fetch_all(pool)
    .await?;
    let draft_by_dataset: HashMap<String, i32> = drafts.into_iter().collect();

    let items: Vec<Value> = datasets
        .iter()
        .map(|d| {
            let head = head_by_dataset.get(&d.id);
            let versions_count = stat_by_id.get(&d.id).map(|s| s.0).unwrap_or(0);
            let mut summary = serialize_dataset_summary(
                d,
                head.map(|h| (&h.version_number, &h.row_count, &h.schema_json.0[..])),
                versions_count,
            );
            summary["latestDraftVersion"] = draft_by_dataset
                .get(&d.id)
                .map(|n| json!(n))
                .unwrap_or(Value::Null);
            summary
        })
        .collect();

    Ok(json!({
        "datasets": items,
        "meta": { "total": total, "limit": limit, "offset": offset },
    }))
}

/// GET /api/datasets — bounded listing; versionsCount = MAIN-branch count,
/// currentVersion = main head (legacy P5 aggregate reads).
pub async fn get_datasets(
    State(state): State<AppState>,
    query: axum::extract::Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    let mut issues = Vec::new();
    let limit = coerce_int_param(
        query.get("limit").map(|s| s.as_str()),
        "limit",
        1,
        200,
        100,
        &mut issues,
    );
    let offset = coerce_int_param(
        query.get("offset").map(|s| s.as_str()),
        "offset",
        0,
        10_000,
        0,
        &mut issues,
    );
    finish_query_issues(issues)?;
    let body = list_datasets(&state.db, limit, offset).await?;
    Ok(json_ok(body))
}

// ─── Detail payload (GET + PATCH share loadDetail) ──────────────────────

pub enum DetailError {
    NotFound,
    UnknownBranch(String),
}

/// Shared detail payload (legacy loadDetail) — governance-aware schema
/// (markedWith) + per-version provenance + optional branch resolution.
pub async fn load_detail(
    state: &AppState,
    id: &str,
    branch_param: Option<&str>,
) -> Result<Value, DetailError> {
    let dataset: Option<DatasetRow> = sqlx::query_as(&format!(
        "SELECT {DATASET_COLS} FROM datasets WHERE id = $1"
    ))
    .bind(id)
    .fetch_optional(&state.db)
    .await
    .map_err(|_| DetailError::NotFound)?;
    let Some(dataset) = dataset else {
        return Err(DetailError::NotFound);
    };
    let versions: Vec<VersionMetaRow> = sqlx::query_as(
        "SELECT id, version_number, row_count, created_by, created_at, schema_json, branch, \
                lifecycle, quality_state \
         FROM dataset_versions WHERE dataset_id = $1 ORDER BY version_number DESC",
    )
    .bind(id)
    .fetch_all(&state.db)
    .await
    .map_err(|_| DetailError::NotFound)?;

    let created_by: Vec<Option<String>> = versions.iter().map(|v| v.created_by.clone()).collect();
    let provenance_list = resolve_provenance_many(&state.db, &created_by).await;

    // R14: resolve the head version for the requested branch.
    let mut head_idx: Option<usize> = versions.iter().position(|v| v.branch == "main");
    let mut resolved_branch: Option<String> = None;
    if let Some(b) = branch_param {
        if b != "main" {
            let branch: Option<(String, i32)> = sqlx::query_as(
                "SELECT name, head_version FROM dataset_branches WHERE dataset_id = $1 AND name = $2",
            )
            .bind(id)
            .bind(b)
            .fetch_optional(&state.db)
            .await
            .map_err(|_| DetailError::NotFound)?;
            let Some((name, head_version)) = branch else {
                return Err(DetailError::UnknownBranch(b.to_string()));
            };
            resolved_branch = Some(name);
            head_idx = versions
                .iter()
                .position(|v| v.version_number == head_version);
        }
    }

    let markings = fetch_markings(state, id).await;

    let mut dataset_json = json!({
        "id": dataset.id,
        "name": dataset.name,
        "description": dataset.description,
        "projectId": dataset.project_id,
        "sourceConnectorId": dataset.source_connector_id,
        "tags": dataset.tags.0,
        "createdAt": crate::state::ts(&dataset.created_at),
        "updatedAt": crate::state::ts(&dataset.updated_at),
        "versionsCount": versions.len(),
        "keepLastN": dataset.keep_last_n,
        "qualityGate": dataset.quality_gate,
        "publishedVersion": dataset.published_version,
    });
    if let Some(b) = &resolved_branch {
        dataset_json["branch"] = json!(b);
    }

    let versions_json: Vec<Value> = versions
        .iter()
        .enumerate()
        .map(|(idx, v)| {
            json!({
                "id": v.id,
                "versionNumber": v.version_number,
                "rowCount": v.row_count,
                "createdBy": v.created_by,
                "createdAt": crate::state::ts(&v.created_at),
                "branch": v.branch,
                "lifecycle": v.lifecycle,
                "qualityState": v.quality_state,
                "provenance": provenance_list.get(idx).cloned().unwrap_or(Value::Null),
            })
        })
        .collect();

    let current = match head_idx {
        Some(i) => {
            let head = &versions[i];
            json!({
                "id": head.id,
                "versionNumber": head.version_number,
                "schema": mask_schema(&head.schema_json.0, &markings),
                "rowCount": head.row_count,
            })
        }
        None => Value::Null,
    };

    Ok(json!({
        "dataset": dataset_json,
        "versions": versions_json,
        "current": current,
    }))
}

/// GET /api/datasets/{id} — detail; audited as dataset.view (the curriculum's
/// 'datasets' step watches this audit action).
pub async fn get_dataset(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    query: axum::extract::Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    let branch_param = query.get("branch").map(|s| s.as_str());
    let detail = match load_detail(&state, &id, branch_param).await {
        Ok(d) => d,
        Err(DetailError::NotFound) => {
            return Err(ApiError::not_found(format!("Dataset '{id}' not found")))
        }
        Err(DetailError::UnknownBranch(b)) => {
            return Err(ApiError::bad_request(format!(
                "Unknown branch '{b}' on dataset '{id}'"
            )))
        }
    };
    let name = detail["dataset"]["name"].as_str().unwrap_or("").to_string();
    audit(
        &state,
        &actor,
        AuditOptions::new("dataset.view", "dataset")
            .resource_id(Some(&id))
            .resource_name(Some(&name)),
    )
    .await;
    Ok(json_ok(detail))
}

/// PATCH /api/datasets/{id} — editor+; name/description/keepLastN/projectId/
/// qualityGate (gate-off requires admin and no outstanding drafts).
pub async fn update_dataset(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;

    let v = parse_body(&body)?;
    let m = as_object(v)?;
    let name = match m.get("name") {
        None => None,
        Some(_) => Some(req_str_min1_custom(&m, "name", "name is required")?.to_string()),
    };
    let description = opt_str_nullish(&m, "description")?;
    let keep_last_n = opt_int_bounded(&m, "keepLastN", 0, 1000)?;
    let project_id = opt_str_nullish(&m, "projectId")?;
    let quality_gate = opt_bool(&m, "qualityGate")?;

    if quality_gate == Some(false) {
        require_role(&actor, "admin")?;
    }

    let existing: Option<(String, String)> =
        sqlx::query_as("SELECT id, name FROM datasets WHERE id = $1")
            .bind(&id)
            .fetch_optional(&state.db)
            .await?;
    let Some((existing_id, existing_name)) = existing else {
        return Err(ApiError::not_found(format!("Dataset '{id}' not found")));
    };

    if quality_gate == Some(false) {
        let drafts: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM dataset_versions \
             WHERE dataset_id = $1 AND branch = 'main' AND lifecycle = 'draft'",
        )
        .bind(&id)
        .fetch_one(&state.db)
        .await?;
        if drafts > 0 {
            return Err(ApiError::conflict(
                "Resolve or remove all drafts before disabling the quality gate",
            ));
        }
    }

    // Validate the target project exists when assigning (null = unassign).
    if let Nullish::Value(pid) = &project_id {
        if !pid.is_empty() {
            let project: Option<(String,)> =
                sqlx::query_as("SELECT id FROM projects WHERE id = $1")
                    .bind(*pid)
                    .fetch_optional(&state.db)
                    .await?;
            if project.is_none() {
                return Err(ApiError::bad_request(format!("Project '{pid}' not found")));
            }
        }
    }

    sqlx::query(
        "UPDATE datasets SET \
         name = CASE WHEN $2::boolean THEN $3 ELSE name END, \
         description = CASE WHEN $4::boolean THEN $5 ELSE description END, \
         keep_last_n = CASE WHEN $6::boolean THEN $7 ELSE keep_last_n END, \
         project_id = CASE WHEN $8::boolean THEN $9 ELSE project_id END, \
         updated_at = now() \
         WHERE id = $1",
    )
    .bind(&id)
    .bind(name.is_some())
    .bind(name.clone().unwrap_or_default())
    .bind(!matches!(description, Nullish::Absent))
    .bind(match description {
        Nullish::Value(s) => Some(s.to_string()),
        _ => None,
    })
    .bind(keep_last_n.is_some())
    .bind(keep_last_n.unwrap_or(0))
    .bind(!matches!(project_id, Nullish::Absent))
    .bind(match project_id {
        Nullish::Value(s) => Some(s.to_string()),
        _ => None,
    })
    .execute(&state.db)
    .await?;

    // P2: gate toggle is a separate write (backfills the consumer pointer).
    if let Some(enabled) = quality_gate {
        if let Err(e) = set_quality_gate(&state.db, &id, enabled).await {
            return Err(e.into_api_error());
        }
    }

    let detail_msg = if let Some(gate) = quality_gate {
        Some(format!("qualityGate={gate}"))
    } else if let Nullish::Value(pid) = &project_id {
        Some(format!("projectId={pid}"))
    } else if matches!(project_id, Nullish::Null) {
        Some("projectId=null".to_string())
    } else {
        keep_last_n.map(|n| format!("keepLastN={n}"))
    };
    audit(
        &state,
        &actor,
        AuditOptions::new("dataset.update", "dataset")
            .resource_id(Some(&existing_id))
            .resource_name(Some(name.as_deref().unwrap_or(&existing_name)))
            .detail(detail_msg.as_deref()),
    )
    .await;

    let detail = load_detail(&state, &id, None)
        .await
        .map_err(|_| ApiError::not_found(format!("Dataset '{id}' not found")))?;
    Ok(json_ok(detail))
}

/// DELETE /api/datasets/{id} — editor+; manual lineage-edge cleanup, then the
/// dataset (versions/rows/branches/rules/comments/watchers cascade).
pub async fn delete_dataset(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;

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

    audit(
        &state,
        &actor,
        AuditOptions::new("dataset.delete", "dataset")
            .resource_id(Some(&dataset_id))
            .resource_name(Some(&dataset_name)),
    )
    .await;

    Ok(json_ok(
        json!({ "ok": true, "deleted": dataset_id, "name": dataset_name }),
    ))
}
