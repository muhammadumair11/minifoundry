//! /api/datasets/{id}/branches[...] — R14 branch routes (ports of
//! branches/route.ts, branches/[branchId]/{route,commit,merge}.ts).

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::Response;
use mf_web::{actor_from_headers, json_created, json_ok, require_role, ApiError, ApiResult};
use serde_json::json;

use crate::audit::{audit, AuditOptions};
use crate::branching::{
    commit_branch_version, create_branch, delete_branch, list_branches, merge_branch,
    CreateBranchInput,
};
use crate::routes::require_dataset;
use crate::state::AppState;
use crate::validate::{
    as_object, opt_int_bounded, opt_str_trim_bounded, parse_body, req_int_positive, req_rows_array,
};

/// GET /api/datasets/{id}/branches — branches + main head (any role).
pub async fn get_branches(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    require_dataset(&state.db, &id).await?;
    let body = list_branches(&state.db, &id).await?;
    Ok(json_ok(body))
}

/// POST /api/datasets/{id}/branches — editor+; create from a main version
/// (default main head). 201 with the bare branch object (legacy jsonOk 201).
pub async fn post_branches(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;
    let (_dataset_id, dataset_name) = require_dataset(&state.db, &id).await?;

    let v = parse_body(&body)?;
    let m = as_object(v)?;
    let name =
        opt_str_trim_bounded(&m, "name", 1, Some("name is required"), 64)?.ok_or_else(|| {
            ApiError::bad_request("name: Invalid input: expected string, received undefined")
        })?;
    let description = opt_str_trim_bounded(&m, "description", 0, None, 500)?;
    let base_version = opt_int_bounded(&m, "baseVersion", 1, i64::MAX)?;

    let created_by = actor.email.clone().unwrap_or_else(|| actor.role.clone());
    let branch = create_branch(
        &state.db,
        &id,
        CreateBranchInput {
            name,
            description,
            base_version,
        },
        Some(&created_by),
    )
    .await
    .map_err(|e| e.into_api_error())?;

    audit(
        &state,
        &actor,
        AuditOptions::new("dataset.branch.create", "dataset")
            .resource_id(Some(&id))
            .resource_name(Some(&dataset_name))
            .detail(Some(&format!(
                "branch='{}' base=v{}",
                branch.name, branch.base_version
            ))),
    )
    .await;

    Ok(json_created(crate::state::serialize_branch(&branch)))
}

/// DELETE /api/datasets/{id}/branches/{branchId} — editor+; unmerged only.
pub async fn delete_branch_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, branch_id)): Path<(String, String)>,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;
    let (_dataset_id, dataset_name) = require_dataset(&state.db, &id).await?;

    let branch = delete_branch(&state.db, &id, &branch_id)
        .await
        .map_err(|e| e.into_api_error())?;

    audit(
        &state,
        &actor,
        AuditOptions::new("dataset.branch.delete", "dataset")
            .resource_id(Some(&id))
            .resource_name(Some(&dataset_name))
            .detail(Some(&format!(
                "branch='{}' (head was v{})",
                branch.name, branch.head_version
            ))),
    )
    .await;

    Ok(json_ok(
        json!({ "ok": true, "deleted": branch.id, "name": branch.name }),
    ))
}

/// POST /api/datasets/{id}/branches/{branchId}/commit — editor+; rows in the
/// body become a new DRAFT version on the branch (201).
pub async fn commit_branch(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, branch_id)): Path<(String, String)>,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;

    let v = parse_body(&body)?;
    let m = as_object(v)?;
    let expected_head = req_int_positive(&m, "expectedHeadVersion")?;
    let rows = req_rows_array(&m, "rows")?;

    let created_by = actor.email.clone().unwrap_or_else(|| actor.role.clone());
    let result = commit_branch_version(
        &state,
        &id,
        &branch_id,
        &rows,
        expected_head as i32,
        &created_by,
    )
    .await
    .map_err(|e| e.into_api_error())?;

    audit(
        &state,
        &actor,
        AuditOptions::new("dataset.branch.commit", "dataset")
            .resource_id(Some(&id))
            .detail(Some(&format!(
                "branch='{}' v{} ({} rows)",
                result.branch_name, result.version_number, result.row_count
            ))),
    )
    .await;

    Ok(json_created(json!({
        "branchName": result.branch_name,
        "versionNumber": result.version_number,
        "rowCount": result.row_count,
    })))
}

/// POST /api/datasets/{id}/branches/{branchId}/merge — editor+; branch head
/// becomes a NEW main version (200).
pub async fn merge_branch_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, branch_id)): Path<(String, String)>,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;
    let (_dataset_id, dataset_name) = require_dataset(&state.db, &id).await?;

    let result = merge_branch(&state, &id, &branch_id)
        .await
        .map_err(|e| e.into_api_error())?;

    // R14: announce the merged main version (consumable when the gate is off).
    let gate: Option<(bool,)> = sqlx::query_as("SELECT quality_gate FROM datasets WHERE id = $1")
        .bind(&id)
        .fetch_optional(&state.db)
        .await?;
    crate::version_events::emit_version_created(
        &state,
        crate::version_events::VersionCreatedInput {
            dataset_id: id.clone(),
            version_number: result.merged_version,
            source: Some(format!("branch-merge:{}", result.branch_name)),
            cascade_parent_run_id: None,
            cascade_depth: None,
            consumable: !gate.map(|g| g.0).unwrap_or(false),
        },
    )
    .await;

    audit(
        &state,
        &actor,
        AuditOptions::new("dataset.branch.merge", "dataset")
            .resource_id(Some(&id))
            .resource_name(Some(&dataset_name))
            .detail(Some(&format!(
                "branch='{}' \u{2192} v{} ({} rows)",
                result.branch_name, result.merged_version, result.rows_merged
            ))),
    )
    .await;

    Ok(json_ok(json!({
        "mergedVersion": result.merged_version,
        "rowsMerged": result.rows_merged,
        "branchName": result.branch_name,
    })))
}
