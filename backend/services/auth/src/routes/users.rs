//! /api/users — admin user management (ports of the legacy users routes).

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::Response;
use mf_web::{actor_from_headers, json_ok, require_role, ApiError, ApiResult};

use crate::audit::{self, AuditOptions};
use crate::routes::{as_object, opt_bool, opt_enum, parse_body};
use crate::state::{AppState, UserRow, serialize_admin_user};

const ROLES: &[&str] = &["viewer", "editor", "admin"];

const USER_COLS: &str =
    "id, email, name, role, password_hash, is_active, last_login_at, created_at";

/// GET /api/users — list platform users (ADMIN ONLY), createdAt asc.
/// The passwordHash is NEVER returned.
pub async fn list_users(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "admin")?;

    let users: Vec<UserRow> =
        sqlx::query_as(&format!("SELECT {USER_COLS} FROM users ORDER BY created_at ASC"))
            .fetch_all(&state.db)
            .await?;
    let out: Vec<serde_json::Value> = users.iter().map(serialize_admin_user).collect();
    Ok(json_ok(serde_json::json!({ "users": out })))
}

/// PATCH /api/users/{id} — update role / isActive (ADMIN ONLY).
/// A session-admin cannot demote or deactivate their OWN account; the demo
/// simulator admin (no session) may change anyone.
pub async fn update_user(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "admin")?;

    let user: Option<UserRow> =
        sqlx::query_as(&format!("SELECT {USER_COLS} FROM users WHERE id = $1"))
            .bind(&id)
            .fetch_optional(&state.db)
            .await?;
    let Some(user) = user else {
        return Err(ApiError::not_found(format!("User '{id}' not found")));
    };

    let v = parse_body(&body)?;
    let m = as_object(v)?;
    let role = opt_enum(&m, "role", ROLES)?;
    let is_active = opt_bool(&m, "isActive")?;

    // Guard: a logged-in admin cannot demote/deactivate their own account
    // (which would lock them out). Simulator admin (no session) is allowed.
    if actor.uid.as_deref() == Some(id.as_str()) {
        let role_change = role.is_some_and(|r| r != user.role);
        let self_deactivate = is_active == Some(false);
        if role_change || self_deactivate {
            return Err(ApiError::bad_request("cannot change your own account"));
        }
    }

    let new_role = role.unwrap_or(&user.role).to_string();
    let new_active = is_active.unwrap_or(user.is_active);
    let updated: UserRow = sqlx::query_as(&format!(
        "UPDATE users SET role = $1, is_active = $2 WHERE id = $3 RETURNING {USER_COLS}"
    ))
    .bind(&new_role)
    .bind(new_active)
    .bind(&id)
    .fetch_one(&state.db)
    .await?;

    audit::audit(
        &state,
        &actor,
        AuditOptions::new("user.update", "user")
            .resource_id(Some(&updated.id))
            .resource_name(Some(&updated.email))
            .detail(&format!("role={} isActive={}", updated.role, updated.is_active)),
    )
    .await;

    Ok(json_ok(serde_json::json!({ "user": serialize_admin_user(&updated) })))
}
