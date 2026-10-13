//! /internal/* — service-to-service endpoints (contracts/INTERNAL_API.md,
//! governance section). Guarded by the shared service token, exactly like
//! the auth service's internal routes.

use axum::body::Bytes;
use axum::extract::{Path, Query};
use axum::http::HeaderMap;
use axum::response::Response;
use mf_web::TenantState as State;
use mf_web::{json_ok, ApiError, ApiResult};
use serde_json::Value;
use std::collections::HashMap;

use crate::state::{
    audit_local, create_notification, AppState, ApprovalRow, AuditOptions, NotificationInput,
    APPROVAL_COLS,
};

/// Internal endpoints require the shared service token (both runtime modes);
/// compose always provisions MF_SERVICE_TOKEN. (Copy of the auth service's
/// require_service.)
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

/// GET /internal/markings/dataset/{id} — `[{columnName, markingName,
/// minRole, color}]` joined with the marking record (columnName asc). Used
/// by the catalog rows endpoints to compute masking.
pub async fn dataset_markings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    require_service(&state, &headers)?;

    let rows: Vec<(String, String, String, String)> = sqlx::query_as(
        "SELECT cm.column_name, m.name, m.min_role, m.color \
         FROM column_markings cm JOIN markings m ON m.id = cm.marking_id \
         WHERE cm.dataset_id = $1 ORDER BY cm.column_name ASC",
    )
    .bind(&id)
    .fetch_all(&state.db)
    .await?;

    Ok(json_ok(
        rows.iter()
            .map(|(column_name, marking_name, min_role, color)| {
                serde_json::json!({
                    "columnName": column_name,
                    "markingName": marking_name,
                    "minRole": min_role,
                    "color": color,
                })
            })
            .collect::<Vec<_>>(),
    ))
}

/// GET /internal/acl/check?resourceType=&resourceId=&email= — the stored
/// per-resource elevation `{level: viewer|editor|owner|null}` (callers
/// combine it with their own role baseline; admin bypass stays theirs).
pub async fn acl_check(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    require_service(&state, &headers)?;

    let resource_type = params.get("resourceType").map(|s| s.as_str()).unwrap_or("");
    let resource_id = params.get("resourceId").map(|s| s.as_str()).unwrap_or("");
    let email = params.get("email").map(|s| s.as_str()).unwrap_or("");

    let mut level: Value = Value::Null;
    if !resource_type.is_empty() && !resource_id.is_empty() && !email.is_empty() {
        let row: Option<(String,)> = sqlx::query_as(
            "SELECT level FROM resource_acls \
             WHERE resource_type = $1 AND resource_id = $2 AND user_email = $3",
        )
        .bind(resource_type)
        .bind(resource_id)
        .bind(email)
        .fetch_optional(&state.db)
        .await?;
        if let Some((l,)) = row {
            level = Value::String(l);
        }
    }
    Ok(json_ok(serde_json::json!({ "level": level })))
}

/// POST /internal/approvals — create an approval request on behalf of a
/// sibling service (catalog's publication gate). Idempotent: a pending
/// request for the same kind+targetId is RETURNED instead of duplicated.
pub async fn create_approval(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    require_service(&state, &headers)?;

    let v = crate::routes::parse_body(&body)?;
    let m = crate::routes::as_object(v)?;
    let kind = crate::routes::req_enum(&m, "kind", &["publish_dataset", "publish_pipeline"])?;
    let target_id = crate::routes::req_str_min1(&m, "targetId", "targetId is required")?;
    let target_name = crate::routes::req_str_min1(&m, "targetName", "targetName is required")?;
    let requested_by = crate::routes::req_str_min1(&m, "requestedBy", "requestedBy is required")?;
    let note = crate::routes::opt_str(&m, "note")?;
    let version_number = match m.get("versionNumber") {
        None | Some(Value::Null) => None,
        Some(Value::Number(n)) => n.as_i64().map(|n| n as i32),
        Some(other) => {
            return Err(ApiError::bad_request(format!(
                "versionNumber: Invalid input: expected number, received {}",
                crate::routes::kind_of(other)
            )))
        }
    };

    // Idempotent on the pending duplicate (the public route 400s; internal
    // callers — the catalog gate — retry and must not stack requests).
    let existing: Option<ApprovalRow> = sqlx::query_as(&format!(
        "SELECT {APPROVAL_COLS} FROM approval_requests \
         WHERE kind = $1 AND target_id = $2 AND status = 'pending' \
         ORDER BY created_at ASC LIMIT 1"
    ))
    .bind(kind)
    .bind(target_id)
    .fetch_optional(&state.db)
    .await?;
    if let Some(a) = existing {
        return Ok(json_ok(
            serde_json::json!({ "id": a.id, "status": a.status }),
        ));
    }

    let id = mf_db::new_id();
    sqlx::query(
        "INSERT INTO approval_requests (id, kind, target_id, version_number, target_name, requested_by, note) \
         VALUES ($1,$2,$3,$4,$5,$6,$7)",
    )
    .bind(&id)
    .bind(kind)
    .bind(target_id)
    .bind(version_number)
    .bind(target_name)
    .bind(requested_by)
    .bind(note)
    .execute(&state.db)
    .await?;

    // Same side effects as the public create route (bell + audit), attributed
    // to the requesting role since no interactive actor exists here.
    let system_actor = mf_auth::Actor {
        role: requested_by.to_string(),
        ..mf_auth::Actor::service()
    };
    audit_local(
        &state,
        &system_actor,
        AuditOptions::new("approval.request", "approval")
            .actor_role(requested_by)
            .resource_id(Some(&id))
            .resource_name(Some(&format!("{kind}: {target_name}")))
            .detail(note),
    )
    .await;
    create_notification(
        &state,
        NotificationInput {
            user_email: None,
            notif_type: "approval_requested",
            title: &format!("Approval requested: {target_name}"),
            body: Some(&format!("{kind} by {requested_by}")),
            resource_type: Some("approval"),
            resource_id: Some(&id),
            href: Some("/governance"),
        },
    )
    .await;

    Ok(json_ok(
        serde_json::json!({ "id": id, "status": "pending" }),
    ))
}

/// GET /internal/stats — `{markings, approvals, approvalsPending,
/// auditEntries, notifications}` (settings/overview fan-in).
pub async fn stats(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    require_service(&state, &headers)?;

    let (markings, approvals, approvals_pending, audit_entries, notifications): (
        i64,
        i64,
        i64,
        i64,
        i64,
    ) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM markings), \
                    (SELECT count(*) FROM approval_requests), \
                    (SELECT count(*) FROM approval_requests WHERE status = 'pending'), \
                    (SELECT count(*) FROM audit_entries), \
                    (SELECT count(*) FROM notifications)",
    )
    .fetch_one(&state.db)
    .await?;

    Ok(json_ok(serde_json::json!({
        "markings": markings,
        "approvals": approvals,
        "approvalsPending": approvals_pending,
        "auditEntries": audit_entries,
        "notifications": notifications,
    })))
}

/// POST /internal/reset — wipe the governance tables ONLY (never users —
/// auth owns those). Returns per-table deleted counts. The single
/// workspace.reset audit row is written by the /api/settings/reset
/// orchestrator AFTER every service's reset (legacy transaction order).
pub async fn reset(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    require_service(&state, &headers)?;

    let mut tx = state.db.begin().await?;
    let tables: [(&str, &str); 7] = [
        ("column_markings", "columnMarkings"),
        ("markings", "markings"),
        ("approval_requests", "approvalRequests"),
        ("resource_acls", "resourceAcls"),
        ("notifications", "notifications"),
        ("curriculum_progress", "curriculumProgress"),
        ("audit_entries", "auditEntries"),
    ];
    let mut counts = serde_json::Map::new();
    for (table, key) in tables {
        // Data-modifying CTE (Postgres forbids DELETE in a FROM subquery).
        let n: i64 = sqlx::query_scalar(&format!(
            "WITH deleted AS (DELETE FROM {table} RETURNING id) SELECT count(*) FROM deleted"
        ))
        .fetch_one(&mut *tx)
        .await?;
        counts.insert(key.to_string(), Value::Number(n.into()));
    }
    tx.commit().await?;

    Ok(json_ok(Value::Object(counts)))
}
