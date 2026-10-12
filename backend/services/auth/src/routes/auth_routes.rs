//! /api/auth/* — login, logout, me (ports of the legacy auth routes).

use axum::body::Bytes;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::Response;
use sha2::{Digest, Sha256};

use crate::audit::{self, AuditOptions};
use crate::cookies;
use crate::routes::{as_object, get_cookie, parse_body, req_str_min1, with_cookies};
use crate::state::{serialize_auth_user, AppState, MembershipRow, UserRow};
use crate::tokens_common::issue_session_pair;
use mf_web::{actor_from_headers, json_ok, ApiError, ApiResult};

/// POST /api/auth/login — real password login.
/// Same 401 message for unknown email, inactive account and wrong password
/// (no user enumeration). Sets access JWT + refresh + legacy role cookies.
pub async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let v = parse_body(&body)?;
    let m = as_object(v)?;
    // zod collects ALL issues (schema field order, '; '-joined) — the legacy
    // zodErrorMessage behavior pinned by the login-invalid-body fixture.
    let mut issues: Vec<String> = Vec::new();
    if let Err(e) = crate::routes::str_min1_issue(&m, "email") {
        issues.push(e);
    }
    if let Err(e) = crate::routes::str_min1_issue(&m, "password") {
        issues.push(e);
    }
    if !issues.is_empty() {
        return Err(ApiError::bad_request(issues.join("; ")));
    }
    let email_in = req_str_min1(&m, "email")?;
    let password = req_str_min1(&m, "password")?;

    let email = email_in.trim().to_lowercase();
    let user: Option<UserRow> = sqlx::query_as(
        "SELECT id, email, name, role, password_hash, is_active, last_login_at, created_at, default_organization_id \
         FROM users WHERE email = $1",
    )
    .bind(&email)
    .fetch_optional(&state.db)
    .await?;

    // Identical response for unknown / inactive / bad password.
    let authed = match &user {
        Some(u) => u.is_active && mf_auth::verify_password(password, &u.password_hash),
        None => false,
    };
    if !authed {
        return Err(ApiError::unauthorized("invalid email or password"));
    }
    let user = user.unwrap();

    let updated: UserRow = sqlx::query_as(
        "UPDATE users SET last_login_at = now() WHERE id = $1 \
         RETURNING id, email, name, role, password_hash, is_active, last_login_at, created_at, default_organization_id",
    )
    .bind(&user.id)
    .fetch_one(&state.db)
    .await?;

    let membership = active_membership(
        &state,
        &updated.id,
        updated.default_organization_id.as_deref(),
    )
    .await?;
    let actor = actor_from_headers(&headers);
    audit::audit(
        &state,
        &actor,
        AuditOptions::new("auth.login", "user")
            .actor_role(&membership.role)
            .actor_email(Some(&updated.email))
            .resource_id(Some(&updated.id))
            .resource_name(Some(&updated.email))
            .detail(Some(&format!(
                "email={} role={}",
                updated.email, membership.role
            ))),
    )
    .await;

    let (specs, _refresh_plain) = issue_session_pair(&state, &updated, &membership, None).await?;
    let user_json = serialize_auth_user(&updated, &membership, None);
    let resp = json_ok(serde_json::json!({ "user": user_json }));
    Ok(with_cookies(resp, specs))
}

/// POST /api/auth/logout — clear the session; audits when one was present.
pub async fn logout(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let _ = body; // logout ignores the body
    let actor = actor_from_headers(&headers);

    if let Some(uid) = &actor.uid {
        let detail = format!(
            "email={} role={}",
            actor.email.clone().unwrap_or_default(),
            actor.role
        );
        audit::audit(
            &state,
            &actor,
            AuditOptions::new("auth.logout", "user")
                .resource_id(Some(uid))
                .resource_name(actor.email.as_deref())
                .detail(Some(&detail)),
        )
        .await;
    }

    // Revoke the presented refresh token (best effort).
    if let Some(rt) = get_cookie(&headers, mf_auth::REFRESH_COOKIE) {
        let hash = hex::encode(Sha256::digest(rt.as_bytes()));
        let _ = sqlx::query("UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL")
            .bind(&hash)
            .execute(&state.db)
            .await;
    }

    let resp = json_ok(serde_json::json!({ "ok": true }));
    Ok(with_cookies(
        resp,
        vec![
            cookies::expire(mf_auth::SESSION_COOKIE, state.cookie_secure),
            cookies::expire(mf_auth::LEGACY_ROLE_COOKIE, state.cookie_secure),
            cookies::expire(mf_auth::REFRESH_COOKIE, state.cookie_secure),
        ],
    ))
}

/// GET /api/auth/me — valid session + active user → { authenticated, user }.
pub async fn me(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    let Some(uid) = actor.uid else {
        return Ok(json_ok(serde_json::json!({ "authenticated": false })));
    };
    let user: Option<UserRow> = sqlx::query_as(
        "SELECT id, email, name, role, password_hash, is_active, last_login_at, created_at \
         FROM users WHERE id = $1",
    )
    .bind(&uid)
    .fetch_optional(&state.db)
    .await?;
    match user {
        Some(u) if u.is_active => {
            let membership = active_membership(&state, &u.id, actor.organization_id.as_deref()).await?;
            let user_json = serialize_auth_user(&u, &membership, Some(&actor.role));
            Ok(json_ok(
                serde_json::json!({ "authenticated": true, "user": user_json }),
            ))
        }
        _ => Ok(json_ok(serde_json::json!({ "authenticated": false }))),
    }
}

/// POST /api/auth/signup — public self-registration.
///
/// Contract:
/// - body { organizationName, name, email, password } — zod-v4-style
///   all-issues validation (all names ≥1 char, valid email shape, password
///   ≥8 chars);
/// - email is normalized (trim + lowercase) and unique → 409
///   { error: "an account with this email already exists" };
/// - each signup creates an organization and an `owner` membership; the
///   compatibility user role is `admin` so existing platform surfaces grant
///   the owner full access;
/// - auto-login: same cookie set as /api/auth/login (access JWT + rotating
///   refresh + legacy role cookie) and the same { user } response at 201;
/// - audits `auth.signup`.
///
/// No email verification at learning scale (documented trade-off); accounts
/// are active immediately. Shared-mode gateway allowlist already covers
/// /api/auth/* so registration works when anonymous access is locked out.
pub async fn signup(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let v = parse_body(&body)?;
    let m = as_object(v)?;
    let (organization_name, name, email, password) = crate::routes::validate_signup(&m)?;

    // Serialize the bootstrap decision. A transaction by itself is not
    // sufficient under PostgreSQL's default Read Committed isolation: two
    // concurrent signups could both observe an empty table and both become
    // admins. This transaction-scoped advisory lock covers only the very
    // short count-and-insert critical section and is released on commit (or
    // rollback).
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(7_189_430_221_i64)
        .execute(&mut *tx)
        .await?;
    let password_hash = mf_auth::hash_password(&password).map_err(ApiError::internal)?;
    let id = mf_db::new_id();
    let organization_id = mf_db::new_id();
    sqlx::query("INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)")
        .bind(&organization_id)
        .bind(&organization_name)
        .bind(format!("org-{}", &organization_id[..8]))
        .execute(&mut *tx)
        .await?;
    let insert = sqlx::query_as(
        "INSERT INTO users (id, email, name, role, password_hash, last_login_at) \
         VALUES ($1, $2, $3, 'admin', $4, now()) \
         RETURNING id, email, name, role, password_hash, is_active, last_login_at, created_at",
    )
    .bind(&id)
    .bind(&email)
    .bind(&name)
    .bind(&password_hash)
    .fetch_one(&mut *tx)
    .await;
    let user: UserRow = match insert {
        Ok(u) => u,
        Err(sqlx::Error::Database(e)) if e.code().as_deref() == Some("23505") => {
            return Err(ApiError::new(
                axum::http::StatusCode::CONFLICT,
                "an account with this email already exists",
            ))
        }
        Err(e) => return Err(e.into()),
    };
    sqlx::query("INSERT INTO organization_memberships (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'owner')")
        .bind(mf_db::new_id()).bind(&organization_id).bind(&user.id).execute(&mut *tx).await?;
    sqlx::query("UPDATE users SET default_organization_id = $1 WHERE id = $2")
        .bind(&organization_id)
        .bind(&user.id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    let actor = actor_from_headers(&headers);
    audit::audit(
        &state,
        &actor,
        AuditOptions::new("auth.signup", "user")
            .actor_role("owner")
            .actor_email(Some(&user.email))
            .resource_id(Some(&user.id))
            .resource_name(Some(&user.email))
            .detail(Some(&format!(
                "email={} organization={} role=owner",
                user.email, organization_name
            ))),
    )
    .await;

    // Auto-login: identical cookie set to /api/auth/login.
    let membership = active_membership(&state, &user.id, Some(&organization_id)).await?;
    let (specs, _refresh) = issue_session_pair(&state, &user, &membership, None).await?;
    let resp = axum::response::IntoResponse::into_response((
        axum::http::StatusCode::CREATED,
        axum::Json(serde_json::json!({ "user": serialize_auth_user(&user, &membership, None) })),
    ));
    Ok(with_cookies(resp, specs))
}

pub(crate) async fn active_membership(
    state: &AppState,
    user_id: &str,
    preferred_org: Option<&str>,
) -> ApiResult<MembershipRow> {
    let m: Option<MembershipRow> = sqlx::query_as(
        "SELECT id, organization_id, user_id, role, is_active, created_at FROM organization_memberships \
         WHERE user_id = $1 AND is_active AND ($2::text IS NULL OR organization_id = $2) \
         ORDER BY created_at ASC LIMIT 1",
    ).bind(user_id).bind(preferred_org).fetch_optional(&state.db).await?;
    m.ok_or_else(|| ApiError::unauthorized("no active organization membership"))
}

/// POST /api/auth/password — change the signed-in user's password.
///
/// Contract:
/// - requires a real session (gateway-resolved uid) → else 401
///   { error: "authentication required" };
/// - body { currentPassword, newPassword (≥8) } — all-issues validation;
/// - wrong currentPassword → 400 { error: "current password is incorrect" };
/// - revokes the user's OTHER refresh tokens (the presented one survives, so
///   this session stays alive); other devices' access JWTs expire naturally
///   within the 15-minute access TTL — stateless tokens cannot be pulled
///   earlier without a denylist (documented trade-off);
/// - audits `auth.password_change`; response { ok: true }.
pub async fn change_password(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    let Some(uid) = actor.uid.clone() else {
        return Err(ApiError::unauthorized("authentication required"));
    };

    let v = parse_body(&body)?;
    let m = as_object(v)?;
    let (current, new) = crate::routes::validate_password_change(&m)?;

    let user: Option<UserRow> = sqlx::query_as(
        "SELECT id, email, name, role, password_hash, is_active, last_login_at, created_at \
         FROM users WHERE id = $1",
    )
    .bind(&uid)
    .fetch_optional(&state.db)
    .await?;
    let Some(user) = user.filter(|u| u.is_active) else {
        return Err(ApiError::unauthorized("authentication required"));
    };

    if !mf_auth::verify_password(&current, &user.password_hash) {
        return Err(ApiError::bad_request("current password is incorrect"));
    }

    let new_hash = mf_auth::hash_password(&new).map_err(ApiError::internal)?;
    sqlx::query("UPDATE users SET password_hash = $1 WHERE id = $2")
        .bind(&new_hash)
        .bind(&user.id)
        .execute(&state.db)
        .await?;

    // Revoke every OTHER refresh token of this user (keep the presented one).
    let current_hash = get_cookie(&headers, mf_auth::REFRESH_COOKIE)
        .map(|rt| hex::encode(Sha256::digest(rt.as_bytes())));
    match current_hash {
        Some(keep) => {
            sqlx::query(
                "UPDATE refresh_tokens SET revoked_at = now() \
                 WHERE user_id = $1 AND token_hash != $2 AND revoked_at IS NULL",
            )
            .bind(&user.id)
            .bind(&keep)
            .execute(&state.db)
            .await?;
        }
        None => {
            sqlx::query(
                "UPDATE refresh_tokens SET revoked_at = now() \
                 WHERE user_id = $1 AND revoked_at IS NULL",
            )
            .bind(&user.id)
            .execute(&state.db)
            .await?;
        }
    }

    audit::audit(
        &state,
        &actor,
        AuditOptions::new("auth.password_change", "user")
            .resource_id(Some(&user.id))
            .resource_name(Some(&user.email))
            .detail(Some("password updated")),
    )
    .await;

    Ok(json_ok(serde_json::json!({ "ok": true })))
}
