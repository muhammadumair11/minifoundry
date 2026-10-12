//! /api/acl* — R14 per-resource ACL grants + effective-level checks.
//!
//! SEMANTICS (elevation-only, ported from src/lib/acl.ts): global roles give
//! a baseline (admin→owner, editor→editor, else viewer); a ResourceAcl row
//! ELEVATES one user on one resource; admin always resolves to owner.

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::response::Response;
use mf_web::{actor_from_headers, json_created, json_ok, require_role, ApiError, ApiResult};
use serde_json::Value;
use std::collections::HashMap;

use crate::fanout::service_admin_actor;
use crate::state::{audit_local, serialize_acl, AclRow, AppState, AuditOptions, ACL_COLS};

const RESOURCE_TYPES: [&str; 3] = ["dataset", "pipeline", "dashboard"];
const LEVELS: [&str; 3] = ["viewer", "editor", "owner"];

/// Numeric ACL level order (viewer < editor < owner); unknown → below all.
/// Kept as the canonical ordering primitives (unit-tested below; sibling
/// services re-implement the baseline+elevation combination on top of
/// /internal/acl/check).
#[allow(dead_code)]
pub fn level_order(level: &str) -> i8 {
    match level {
        "viewer" => 0,
        "editor" => 1,
        "owner" => 2,
        _ => -1,
    }
}

/// Port of `levelAtLeast`.
#[allow(dead_code)]
pub fn level_at_least(level: &str, need: &str) -> bool {
    let l = level_order(level);
    l >= 0 && l >= level_order(need)
}

/// Port of `effectiveResourceLevel` — strongest level the actor holds.
/// `acl_level` is the stored row level for (resourceType, resourceId, email),
/// None when no row exists (callers fetch it; keeps this pure + testable).
pub fn effective_level(role: &str, email: Option<&str>, acl_level: Option<&str>) -> String {
    if role == "admin" {
        return "owner".to_string();
    }
    if role == "editor" {
        return "editor".to_string();
    }
    let Some(email) = email.filter(|e| !e.is_empty()) else {
        return "viewer".to_string();
    };
    let _ = email;
    acl_level.unwrap_or("viewer").to_string()
}

/// GET /api/acl?resourceType=&resourceId= — list grants (any role).
pub async fn list_acls(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    let resource_type = params.get("resourceType").cloned().unwrap_or_default();
    let resource_id = params.get("resourceId").cloned().unwrap_or_default();
    if !RESOURCE_TYPES.contains(&resource_type.as_str()) {
        return Err(ApiError::bad_request(format!(
            "resourceType must be one of: {}",
            RESOURCE_TYPES.join(", ")
        )));
    }
    if resource_id.is_empty() {
        return Err(ApiError::bad_request("resourceId is required"));
    }

    let acls: Vec<AclRow> = sqlx::query_as(&format!(
        "SELECT {ACL_COLS} FROM resource_acls WHERE resource_type = $1 AND resource_id = $2 \
         ORDER BY created_at ASC, user_email ASC"
    ))
    .bind(&resource_type)
    .bind(&resource_id)
    .fetch_all(&state.db)
    .await?;

    Ok(json_ok(serde_json::json!({
        "acls": acls.iter().map(serialize_acl).collect::<Vec<_>>(),
    })))
}

/// POST /api/acl — upsert one grant (ADMIN). Grantee must be a real platform
/// user (checked through the auth service; transport failure degrades to
/// granting without the check, warn-logged).
pub async fn grant_acl(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "admin")?;

    let v = crate::routes::parse_body(&body)?;
    let m = crate::routes::as_object(v)?;
    let resource_type = crate::routes::req_enum(&m, "resourceType", &RESOURCE_TYPES)?;
    let resource_id = crate::routes::req_str_min1(&m, "resourceId", "resourceId is required")?;
    let user_email = crate::routes::req_str_min1(&m, "userEmail", "userEmail is required")?;
    if user_email.chars().count() < 3 {
        return Err(ApiError::bad_request("userEmail is required"));
    }
    if !crate::routes::is_email(user_email) {
        return Err(ApiError::bad_request("userEmail must be an email"));
    }
    let level = crate::routes::req_enum(&m, "level", &LEVELS)?;

    // The grantee must be a real platform user (auth owns the users table).
    match user_exists(&state, user_email).await {
        Ok(true) => {}
        Ok(false) => return Err(ApiError::bad_request("unknown user")),
        Err(e) => {
            tracing::warn!(error = %e, "auth unreachable; skipping user-existence check for ACL grant");
        }
    }

    let id = mf_db::new_id();
    let acl: AclRow = sqlx::query_as(&format!(
        "INSERT INTO resource_acls (id, resource_type, resource_id, user_email, level, granted_by) \
         VALUES ($1,$2,$3,$4,$5,$6) \
         ON CONFLICT (resource_type, resource_id, user_email) \
         DO UPDATE SET level = $5, granted_by = $6 \
         RETURNING {ACL_COLS}"
    ))
    .bind(&id)
    .bind(resource_type)
    .bind(resource_id)
    .bind(user_email)
    .bind(level)
    .bind(&actor.email)
    .fetch_one(&state.db)
    .await?;

    audit_local(
        &state,
        &actor,
        AuditOptions::new("acl.grant", resource_type)
            .resource_id(Some(resource_id))
            .resource_name(Some(user_email))
            .detail(Some(&format!("level={level}"))),
    )
    .await;

    Ok(json_created(serialize_acl(&acl)))
}

/// DELETE /api/acl/{aclId} — revoke one grant (ADMIN).
pub async fn revoke_acl(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(acl_id): Path<String>,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "admin")?;

    let acl: Option<AclRow> = sqlx::query_as(&format!(
        "SELECT {ACL_COLS} FROM resource_acls WHERE id = $1"
    ))
    .bind(&acl_id)
    .fetch_optional(&state.db)
    .await?;
    let Some(acl) = acl else {
        return Err(ApiError::not_found(format!(
            "ACL grant '{acl_id}' not found"
        )));
    };

    sqlx::query("DELETE FROM resource_acls WHERE id = $1")
        .bind(&acl_id)
        .execute(&state.db)
        .await?;

    audit_local(
        &state,
        &actor,
        AuditOptions::new("acl.revoke", &acl.resource_type)
            .resource_id(Some(&acl.resource_id))
            .resource_name(Some(&acl.user_email))
            .detail(Some(&format!("removed level={}", acl.level))),
    )
    .await;

    Ok(json_ok(serde_json::json!({ "ok": true, "id": acl_id })))
}

/// GET /api/acl/check?resourceType=&resourceId= — the caller's EFFECTIVE
/// per-resource level (any role).
pub async fn check_acl(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    let resource_type = params.get("resourceType").cloned().unwrap_or_default();
    let resource_id = params.get("resourceId").cloned().unwrap_or_default();

    if resource_type.is_empty() || resource_id.is_empty() {
        // No resource context → the bare global baseline is the honest answer.
        let level = baseline_level(&actor.role);
        return Ok(json_ok(serde_json::json!({ "level": level })));
    }

    let acl_level =
        stored_level(&state, &resource_type, &resource_id, actor.email.as_deref()).await;
    let level = effective_level(&actor.role, actor.email.as_deref(), acl_level.as_deref());
    Ok(json_ok(serde_json::json!({ "level": level })))
}

/// Role-only baseline (the no-resource-context answer).
pub fn baseline_level(role: &str) -> &'static str {
    match role {
        "admin" => "owner",
        "editor" => "editor",
        _ => "viewer",
    }
}

/// Stored ACL row level for one (type, id, email); None on no row, no email,
/// or DB error (legacy swallowed errors → viewer baseline).
pub async fn stored_level(
    state: &AppState,
    resource_type: &str,
    resource_id: &str,
    email: Option<&str>,
) -> Option<String> {
    let email = email?;
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT level FROM resource_acls \
         WHERE resource_type = $1 AND resource_id = $2 AND user_email = $3",
    )
    .bind(resource_type)
    .bind(resource_id)
    .bind(email)
    .fetch_optional(&state.db)
    .await
    .unwrap_or(None);
    row.map(|(l,)| l)
}

/// Does this email belong to a real platform user? Ok(true/false) on a
/// definite auth answer (service-token + x-mf-service bypasses auth's admin
/// guard — auth exposes no internal user lookup); Err on transport failure.
async fn user_exists(state: &AppState, email: &str) -> Result<bool, String> {
    let resp: Value = state
        .clients
        .auth
        .get_as("/api/users", &service_admin_actor())
        .await
        .map_err(|e| e.to_string())?;
    let users = crate::fanout::items_array(&resp, "users");
    Ok(users.iter().any(|u| {
        u.get("email")
            .and_then(|v| v.as_str())
            .is_some_and(|e2| e2.eq_ignore_ascii_case(email))
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acl_level_ordering() {
        assert!(level_at_least("owner", "viewer"));
        assert!(level_at_least("owner", "editor"));
        assert!(level_at_least("owner", "owner"));
        assert!(level_at_least("editor", "viewer"));
        assert!(level_at_least("editor", "editor"));
        assert!(!level_at_least("editor", "owner"));
        assert!(!level_at_least("viewer", "editor"));
        assert!(level_at_least("viewer", "viewer"));
        // unknown stored levels never satisfy anything (legacy ORDER lookup)
        assert!(!level_at_least("bogus", "viewer"));
    }

    #[test]
    fn effective_level_matches_legacy() {
        // admin bypasses to owner regardless of rows
        assert_eq!(effective_level("admin", None, None), "owner");
        assert_eq!(
            effective_level("admin", Some("a@b.c"), Some("viewer")),
            "owner"
        );
        // editor baseline
        assert_eq!(effective_level("editor", None, None), "editor");
        // NOTE: legacy effectiveResourceLevel returns the BASELINE for editor
        // without consulting rows (rows can only matter below editor).
        assert_eq!(
            effective_level("editor", Some("a@b.c"), Some("owner")),
            "editor"
        );
        // viewer / anonymous: row elevates, absence → viewer
        assert_eq!(effective_level("viewer", None, None), "viewer");
        assert_eq!(effective_level("viewer", Some("a@b.c"), None), "viewer");
        assert_eq!(
            effective_level("viewer", Some("a@b.c"), Some("owner")),
            "owner"
        );
        assert_eq!(
            effective_level("anonymous", Some("a@b.c"), Some("editor")),
            "editor"
        );
    }

    #[test]
    fn baseline_levels() {
        assert_eq!(baseline_level("admin"), "owner");
        assert_eq!(baseline_level("editor"), "editor");
        assert_eq!(baseline_level("viewer"), "viewer");
        assert_eq!(baseline_level("anonymous"), "viewer");
    }
}
