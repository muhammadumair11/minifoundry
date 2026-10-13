//! /api/datasets/{id}/publish + /prune.
//!
//! PUBLISH — the legacy route answered a flat 409 migration error pointing at
//! /api/approvals. In the microservice split the catalog side owns the draft
//! validation (exact publication.ts reasons in a `detail.reasons` payload) and
//! asks GOVERNANCE to create the approval request (POST /internal/approvals).
//! Governance decides it and calls back via
//! POST /internal/datasets/{id}/publish-approved (or mf.approval.decided).
//! Tolerant contract: governance unreachable → 502 { error } and NO state
//! change; governance rejections pass through with their status/message.

use axum::body::Bytes;
use axum::extract::Path;
use axum::http::HeaderMap;
use axum::response::Response;
use mf_web::TenantState as State;
use mf_web::{actor_from_headers, json_created, json_ok, require_role, ApiError, ApiResult};
use serde_json::{json, Value};

use crate::audit::{audit, AuditOptions};
use crate::dataset_service::prune_dataset_versions;
use crate::publication::{latest_draft_version, validate_publication};
use crate::routes::require_dataset;
use crate::state::AppState;
use crate::validate::{as_object, opt_int_bounded, parse_body_or_empty};

/// POST /api/datasets/{id}/publish — editor+; body {versionNumber?, note?}.
/// Validates the draft against the publication gate rules, then requests the
/// approval from governance (201 { approval }).
pub async fn publish_dataset(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;
    let (dataset_id, dataset_name) = require_dataset(&state.db, &id).await?;

    let v = parse_body_or_empty(&body)?;
    let m = as_object(v)?;
    let version_number = match opt_int_bounded(&m, "versionNumber", 1, i64::MAX)? {
        Some(n) => n as i32,
        None => match latest_draft_version(&state.db, &dataset_id).await? {
            Some(n) => n,
            None => {
                return Err(ApiError::bad_request(
                    "No draft version exists to request publication",
                ))
            }
        },
    };
    let note = m.get("note").and_then(|n| n.as_str());

    // Exact publication.ts validation (status codes + detail.reasons).
    validate_publication(&state.db, &dataset_id, version_number)
        .await
        .map_err(|e| e.into_api_error())?;

    // Create the approval request in governance (the legacy flow created it
    // via POST /api/approvals; that route moved to governance).
    let requested_by = mf_web::audit_role(&actor);
    let payload = json!({
        "kind": "publish_dataset",
        "targetId": dataset_id,
        "versionNumber": version_number,
        "targetName": dataset_name,
        "requestedBy": requested_by,
        "note": note,
    });
    let approval: Value = state
        .governance
        .post_json("/internal/approvals", &payload)
        .await
        .map_err(|e| match e {
            mf_internal::InternalError::Transport(msg) => {
                // Tolerant contract: unreachable → 502 and NO state change.
                ApiError::new(axum::http::StatusCode::BAD_GATEWAY, msg)
            }
            mf_internal::InternalError::Api { status, message } => ApiError::new(
                axum::http::StatusCode::from_u16(status)
                    .unwrap_or(axum::http::StatusCode::BAD_GATEWAY),
                message,
            ),
        })?;

    Ok(json_created(json!({ "approval": approval })))
}

/// POST /api/datasets/{id}/prune — editor+; manual M2 retention pruning.
/// Body { keepLastN? } defaults to the dataset's stored window (0 = unlimited).
pub async fn prune_versions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;

    let dataset: Option<(String, String, i32)> =
        sqlx::query_as("SELECT id, name, keep_last_n FROM datasets WHERE id = $1")
            .bind(&id)
            .fetch_optional(&state.db)
            .await?;
    let Some((dataset_id, dataset_name, stored_keep)) = dataset else {
        return Err(ApiError::not_found(format!("Dataset '{id}' not found")));
    };

    let v = parse_body_or_empty(&body)?;
    let m = as_object(v)?;
    let keep_last_n = opt_int_bounded(&m, "keepLastN", 0, 1000)?
        .map(|n| n as i32)
        .unwrap_or(stored_keep);

    let pruned = prune_dataset_versions(&state.db, &id, keep_last_n).await?;
    let remaining: i64 =
        sqlx::query_scalar("SELECT count(*) FROM dataset_versions WHERE dataset_id = $1")
            .bind(&id)
            .fetch_one(&state.db)
            .await?;

    audit(
        &state,
        &actor,
        AuditOptions::new("dataset.prune", "dataset")
            .resource_id(Some(&dataset_id))
            .resource_name(Some(&dataset_name))
            .detail(Some(&format!("keepLastN={keep_last_n} pruned={pruned}"))),
    )
    .await;

    Ok(json_ok(json!({ "pruned": pruned, "remaining": remaining })))
}
