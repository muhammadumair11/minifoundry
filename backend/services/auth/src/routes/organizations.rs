//! Organization memberships and copyable invite links.

use axum::body::Bytes;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::Response;
use chrono::{Duration, Utc};
use mf_web::{actor_from_headers, json_created, json_ok, ApiError, ApiResult};
use rand::RngCore;
use sha2::{Digest, Sha256};

use crate::routes::{as_object, parse_body, req_enum, req_str};
use crate::state::AppState;

const INVITABLE: &[&str] = &["org_admin", "access_manager", "auditor", "editor", "viewer"];

fn can_manage_members(role: &str) -> bool {
    matches!(role, "admin" | "owner" | "org_admin" | "access_manager")
}

fn can_grant(actor_role: &str, target: &str) -> bool {
    match actor_role {
        "admin" | "owner" => INVITABLE.contains(&target),
        "org_admin" => INVITABLE.contains(&target),
        "access_manager" => matches!(target, "editor" | "viewer"),
        _ => false,
    }
}

/// GET /api/organizations — organizations visible to the signed-in user.
pub async fn list(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    let uid = actor
        .uid
        .ok_or_else(|| ApiError::unauthorized("authentication required"))?;
    let rows: Vec<(String, String, String, String)> = sqlx::query_as(
        "SELECT o.id, o.name, o.slug, m.role FROM organizations o JOIN organization_memberships m \
         ON m.organization_id = o.id WHERE m.user_id = $1 AND m.is_active ORDER BY o.created_at",
    )
    .bind(uid)
    .fetch_all(&state.db)
    .await?;
    Ok(json_ok(
        serde_json::json!({ "organizations": rows.into_iter().map(|(id,name,slug,role)| serde_json::json!({"id":id,"name":name,"slug":slug,"role":role})).collect::<Vec<_>>() }),
    ))
}

/// GET /api/organization/members — active membership roster for current organization.
pub async fn members(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    let org = actor
        .organization_id
        .ok_or_else(|| ApiError::unauthorized("active organization required"))?;
    if !can_manage_members(&actor.role) && actor.role != "auditor" {
        return Err(ApiError::forbidden(
            "member access requires organization administration",
        ));
    }
    let rows: Vec<(String,String,String,bool,String)> = sqlx::query_as(
        "SELECT u.id, u.email, u.name, m.is_active, m.role FROM organization_memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 ORDER BY m.created_at",
    ).bind(org).fetch_all(&state.db).await?;
    Ok(json_ok(
        serde_json::json!({ "members": rows.into_iter().map(|(id,email,name,is_active,role)| serde_json::json!({"id":id,"email":email,"name":name,"isActive":is_active,"role":role})).collect::<Vec<_>>() }),
    ))
}

/// POST /api/organization/invitations — returns a one-time, seven-day copyable link.
pub async fn invite(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    let org = actor
        .organization_id
        .clone()
        .ok_or_else(|| ApiError::unauthorized("active organization required"))?;
    let uid = actor
        .uid
        .clone()
        .ok_or_else(|| ApiError::unauthorized("authentication required"))?;
    if !can_manage_members(&actor.role) {
        return Err(ApiError::forbidden(
            "member management requires organization administration",
        ));
    }
    let m = as_object(parse_body(&body)?)?;
    let email = req_str(&m, "email")?.trim().to_lowercase();
    let role = req_enum(&m, "role", INVITABLE)?;
    if !can_grant(&actor.role, role) {
        return Err(ApiError::forbidden("cannot grant that organization role"));
    }
    let mut raw = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut raw);
    let token = hex::encode(raw);
    let hash = hex::encode(Sha256::digest(token.as_bytes()));
    let id = mf_db::new_id();
    sqlx::query("INSERT INTO organization_invitations (id, organization_id, email, role, token_hash, expires_at, created_by_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7)")
        .bind(&id).bind(&org).bind(&email).bind(role).bind(hash).bind(Utc::now() + Duration::days(7)).bind(uid).execute(&state.db).await?;
    Ok(json_created(
        serde_json::json!({ "invitation": { "id": id, "email": email, "role": role, "acceptUrl": format!("/invite/{token}") } }),
    ))
}
