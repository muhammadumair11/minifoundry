//! Organization memberships and copyable invite links.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::Response;
use chrono::{Duration, Utc};
use mf_web::{actor_from_headers, json_created, json_ok, ApiError, ApiResult};
use rand::RngCore;
use sha2::{Digest, Sha256};

use crate::routes::auth_routes::active_membership;
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
    let uid = actor
        .uid
        .ok_or_else(|| ApiError::unauthorized("authentication required"))?;
    let membership = active_membership(&state, &uid, Some(&org)).await?;
    if !can_manage_members(&membership.role) && membership.role != "auditor" {
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
    let membership = active_membership(&state, &uid, Some(&org)).await?;
    if !can_manage_members(&membership.role) {
        return Err(ApiError::forbidden(
            "member management requires organization administration",
        ));
    }
    let m = as_object(parse_body(&body)?)?;
    let email = req_str(&m, "email")?.trim().to_lowercase();
    if !crate::routes::email_is_valid(&email) {
        return Err(ApiError::bad_request("enter a valid invitation email"));
    }
    let role = req_enum(&m, "role", INVITABLE)?;
    if !can_grant(&membership.role, role) {
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

/// PATCH /api/organization/members/{id} — change a member's organization role.
/// Owners are immutable here; ownership transfer needs an explicit audited flow.
pub async fn update_member_role(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(member_user_id): Path<String>,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    let organization_id = actor
        .organization_id
        .ok_or_else(|| ApiError::unauthorized("active organization required"))?;
    let uid = actor
        .uid
        .ok_or_else(|| ApiError::unauthorized("authentication required"))?;
    let membership = active_membership(&state, &uid, Some(&organization_id)).await?;
    if !can_manage_members(&membership.role) {
        return Err(ApiError::forbidden(
            "member management requires organization administration",
        ));
    }
    let m = as_object(parse_body(&body)?)?;
    let role = req_enum(&m, "role", INVITABLE)?;
    if !can_grant(&membership.role, role) {
        return Err(ApiError::forbidden("cannot grant that organization role"));
    }
    let mut tx = state.db.begin().await?;
    let current: Option<(String,)> = sqlx::query_as(
        "SELECT role FROM organization_memberships WHERE organization_id = $1 AND user_id = $2 AND is_active FOR UPDATE",
    )
    .bind(&organization_id)
    .bind(&member_user_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((current_role,)) = current else {
        return Err(ApiError::not_found("active organization member not found"));
    };
    if !can_grant(&membership.role, &current_role) {
        return Err(ApiError::forbidden(
            "cannot change that member's organization role",
        ));
    }
    if uid == member_user_id {
        return Err(ApiError::forbidden(
            "cannot change your own organization role",
        ));
    }
    sqlx::query("UPDATE organization_memberships SET role = $1 WHERE organization_id = $2 AND user_id = $3 AND is_active")
        .bind(role)
        .bind(&organization_id)
        .bind(&member_user_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(json_ok(
        serde_json::json!({ "member": { "id": member_user_id, "role": role } }),
    ))
}

/// GET /api/invitations/{token} — view invitation details (public, no auth required).
pub async fn view_invitation(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> ApiResult<Response> {
    let hash = hex::encode(Sha256::digest(token.as_bytes()));
    let inv: Option<(String, String, String, String, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(
        "SELECT id, organization_id, email, role, expires_at FROM organization_invitations WHERE token_hash = $1 AND revoked_at IS NULL AND accepted_at IS NULL",
    )
    .bind(&hash)
    .fetch_optional(&state.db)
    .await?;
    let Some((id, organization_id, email, role, expires_at)) = inv else {
        return Err(ApiError::not_found("invitation not found or already used"));
    };
    if expires_at < Utc::now() {
        return Err(ApiError::bad_request("invitation has expired"));
    }
    let org: Option<(String,)> = sqlx::query_as("SELECT name FROM organizations WHERE id = $1")
        .bind(&organization_id)
        .fetch_optional(&state.db)
        .await?;
    let org_name = org.map(|(n,)| n).unwrap_or_else(|| "Unknown".to_string());
    Ok(json_ok(
        serde_json::json!({ "invitation": { "id": id, "organizationId": organization_id, "organizationName": org_name, "email": email, "role": role, "expiresAt": expires_at } }),
    ))
}

/// POST /api/invitations/{token}/accept — accept an invitation (creates user + membership or adds membership to existing user).
pub async fn accept_invitation(
    State(state): State<AppState>,
    Path(token): Path<String>,
    body: Bytes,
) -> ApiResult<Response> {
    let hash = hex::encode(Sha256::digest(token.as_bytes()));
    let mut tx = state.db.begin().await?;

    // Lock and validate invitation
    let inv: Option<(String, String, String, String, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(
        "SELECT id, organization_id, email, role, expires_at FROM organization_invitations WHERE token_hash = $1 AND revoked_at IS NULL AND accepted_at IS NULL FOR UPDATE",
    )
    .bind(&hash)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((inv_id, organization_id, email, role, expires_at)) = inv else {
        return Err(ApiError::not_found("invitation not found or already used"));
    };
    if expires_at < Utc::now() {
        return Err(ApiError::bad_request("invitation has expired"));
    }

    let m = as_object(parse_body(&body)?)?;
    let name = req_str(&m, "name")?.trim().to_string();
    let password = req_str(&m, "password")?;
    if name.is_empty() {
        return Err(ApiError::bad_request("name must not be empty"));
    }
    if password.len() < 8 {
        return Err(ApiError::bad_request(
            "password must be at least 8 characters",
        ));
    }

    // Check if user already exists
    let existing_user: Option<(String, String, String, bool)> =
        sqlx::query_as("SELECT id, password_hash, name, is_active FROM users WHERE email = $1")
            .bind(&email)
            .fetch_optional(&mut *tx)
            .await?;

    let (user_id, user_name) = if let Some((existing_id, existing_hash, existing_name, is_active)) =
        existing_user
    {
        // User exists - verify password and add membership
        if !is_active || !mf_auth::verify_password(password, &existing_hash) {
            return Err(ApiError::unauthorized(
                "invalid password for existing account",
            ));
        }
        // Check if already a member
        let existing_membership: Option<(String,)> = sqlx::query_as(
            "SELECT id FROM organization_memberships WHERE organization_id = $1 AND user_id = $2 AND is_active",
        )
        .bind(&organization_id)
        .bind(&existing_id)
        .fetch_optional(&mut *tx)
        .await?;
        if existing_membership.is_some() {
            return Err(ApiError::bad_request(
                "already a member of this organization",
            ));
        }
        // Add membership
        sqlx::query("INSERT INTO organization_memberships (id, organization_id, user_id, role) VALUES ($1, $2, $3, $4)")
            .bind(mf_db::new_id())
            .bind(&organization_id)
            .bind(&existing_id)
            .bind(role)
            .execute(&mut *tx)
            .await?;
        // Update default org if not set
        sqlx::query("UPDATE users SET default_organization_id = COALESCE(default_organization_id, $1) WHERE id = $2")
            .bind(&organization_id)
            .bind(&existing_id)
            .execute(&mut *tx)
            .await?;
        (existing_id, existing_name)
    } else {
        // New user - create user + membership
        let password_hash = mf_auth::hash_password(password).map_err(ApiError::internal)?;
        let id = mf_db::new_id();
        sqlx::query("INSERT INTO users (id, email, name, role, password_hash, last_login_at) VALUES ($1, $2, $3, $4, $5, now())")
            .bind(&id)
            .bind(&email)
            .bind(&name)
            .bind(crate::tokens_common::platform_role(&role))
            .bind(&password_hash)
            .execute(&mut *tx)
            .await?;
        sqlx::query("INSERT INTO organization_memberships (id, organization_id, user_id, role) VALUES ($1, $2, $3, $4)")
            .bind(mf_db::new_id())
            .bind(&organization_id)
            .bind(&id)
            .bind(role)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE users SET default_organization_id = $1 WHERE id = $2")
            .bind(&organization_id)
            .bind(&id)
            .execute(&mut *tx)
            .await?;
        (id, name.clone())
    };

    // Mark invitation as accepted
    sqlx::query("UPDATE organization_invitations SET accepted_at = now() WHERE id = $1")
        .bind(&inv_id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;

    // Auto-login: issue session cookies
    let membership = active_membership(&state, &user_id, Some(&organization_id)).await?;
    let (specs, _refresh) = crate::tokens_common::issue_session_pair(
        &state,
        &crate::state::UserRow {
            id: user_id.clone(),
            email: email.clone(),
            name: user_name.clone(),
            role: "admin".to_string(),
            password_hash: String::new(),
            is_active: true,
            last_login_at: None,
            created_at: mf_db::now(),
            default_organization_id: Some(organization_id.clone()),
        },
        &membership,
        None,
    )
    .await?;

    let resp = axum::response::IntoResponse::into_response((
        axum::http::StatusCode::CREATED,
        axum::Json(
            serde_json::json!({ "user": { "id": user_id, "email": email, "name": user_name, "role": crate::tokens_common::platform_role(&membership.role), "organizationId": organization_id, "organizationRole": membership.role, "lastLoginAt": null } }),
        ),
    ));
    Ok(crate::routes::with_cookies(resp, specs))
}
