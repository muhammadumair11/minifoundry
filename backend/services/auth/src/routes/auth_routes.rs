//! /api/auth/* — login, logout, me (ports of the legacy auth routes).

use axum::body::Bytes;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::Response;
use sha2::{Digest, Sha256};

use crate::audit::{self, AuditOptions};
use crate::cookies;
use crate::routes::{as_object, get_cookie, parse_body, req_str_min1, with_cookies};
use crate::state::{serialize_auth_user, AppState, UserRow};
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
        "SELECT id, email, name, role, password_hash, is_active, last_login_at, created_at \
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
         RETURNING id, email, name, role, password_hash, is_active, last_login_at, created_at",
    )
    .bind(&user.id)
    .fetch_one(&state.db)
    .await?;

    let actor = actor_from_headers(&headers);
    audit::audit(
        &state,
        &actor,
        AuditOptions::new("auth.login", "user")
            .actor_role(&updated.role)
            .actor_email(Some(&updated.email))
            .resource_id(Some(&updated.id))
            .resource_name(Some(&updated.email))
            .detail(Some(&format!(
                "email={} role={}",
                updated.email, updated.role
            ))),
    )
    .await;

    let (specs, _refresh_plain) = issue_session_pair(&state, &updated, None).await?;
    let resp = json_ok(serde_json::json!({ "user": serialize_auth_user(&updated) }));
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
        Some(u) if u.is_active => Ok(json_ok(
            serde_json::json!({ "authenticated": true, "user": serialize_auth_user(&u) }),
        )),
        _ => Ok(json_ok(serde_json::json!({ "authenticated": false }))),
    }
}
