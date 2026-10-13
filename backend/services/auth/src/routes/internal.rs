//! /internal/* — service-to-service endpoints (gateway refresh, public-api
//! token verification + rate limiting). Guarded by the shared service token.

use axum::body::Bytes;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::Response;
use chrono::Utc;
use mf_web::{json_ok, ApiError, ApiResult};
use sha2::{Digest, Sha256};

use crate::ratelimit::TOKEN_RATE_LIMIT;
use crate::routes::{as_object, auth_routes::active_membership, parse_body, req_str};
use crate::state::{serialize_auth_user, AppState, RefreshRow, TokenRow, UserRow};
use crate::tokens_common::{build_access_token, new_refresh_token, refresh_ttl};

/// Internal endpoints require the shared service token (both runtime modes);
/// compose always provisions MF_SERVICE_TOKEN.
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

/// Grace window for concurrent refresh rotation (multiple gateway replicas):
/// a token revoked within this window still yields a fresh ACCESS token
/// (without another rotation) instead of a hard 401.
const REFRESH_GRACE_SECONDS: i64 = 30;

const REFRESH_COLS: &str =
    "id, user_id, organization_id, token_hash, impersonated_role, expires_at, revoked_at";
const USER_COLS: &str =
    "id, email, name, role, password_hash, is_active, last_login_at, created_at";

/// Resolve current membership on every authenticated gateway request. Access
/// JWTs establish identity; the database establishes current authorization.
pub async fn validate_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    require_service(&state, &headers)?;
    let m = as_object(parse_body(&body)?)?;
    let uid = req_str(&m, "userId")?;
    let organization_id = req_str(&m, "organizationId")?;
    let active: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE id = $1 AND is_active)")
            .bind(uid)
            .fetch_one(&state.db)
            .await?;
    if !active {
        return Err(ApiError::unauthorized("account is inactive"));
    }
    let membership = active_membership(&state, uid, Some(organization_id)).await?;
    let current = crate::tokens_common::platform_role(&membership.role);
    let requested = m.get("effectiveRole").and_then(|value| value.as_str());
    let effective = if state.mode.demo && current == "admin" {
        requested
            .filter(|role| matches!(*role, "admin" | "editor" | "viewer"))
            .unwrap_or(current)
    } else {
        current
    };
    Ok(json_ok(
        serde_json::json!({ "role": effective, "organizationRole": membership.role, "realRole": if effective != current { Some(current) } else { None } }),
    ))
}

/// POST /internal/auth/refresh — rotate a refresh token, return a new access
/// JWT (+ new refresh plaintext when rotated). Called by the gateway.
pub async fn refresh(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    require_service(&state, &headers)?;

    let v = parse_body(&body)?;
    let m = as_object(v)?;
    let token = req_str(&m, "refreshToken")?;
    let hash = hex::encode(Sha256::digest(token.as_bytes()));

    let row: Option<RefreshRow> = sqlx::query_as(&format!(
        "SELECT {REFRESH_COLS} FROM refresh_tokens WHERE token_hash = $1"
    ))
    .bind(&hash)
    .fetch_optional(&state.db)
    .await?;
    let Some(row) = row else {
        return Err(ApiError::unauthorized("invalid or expired refresh token"));
    };

    let user: Option<UserRow> =
        sqlx::query_as(&format!("SELECT {USER_COLS} FROM users WHERE id = $1"))
            .bind(&row.user_id)
            .fetch_optional(&state.db)
            .await?;
    let Some(user) = user.filter(|u| u.is_active) else {
        return Err(ApiError::unauthorized("invalid or expired refresh token"));
    };
    let membership = active_membership(&state, &user.id, row.organization_id.as_deref()).await?;

    if let Some(revoked_at) = row.revoked_at {
        // Recently rotated (concurrent gateways): issue an access token only,
        // keep the winner's refresh cookie in place.
        if Utc::now() - revoked_at <= chrono::Duration::seconds(REFRESH_GRACE_SECONDS) {
            let (payload, access) =
                build_access_token(&state, &user, &membership, row.impersonated_role.as_deref())?;
            return Ok(json_ok(serde_json::json!({
                "accessToken": access,
                "user": serialize_auth_user(&user, &membership, Some(&payload.role)),
            })));
        }
        return Err(ApiError::unauthorized("invalid or expired refresh token"));
    }
    if row.expires_at < Utc::now() {
        return Err(ApiError::unauthorized("invalid or expired refresh token"));
    }

    // Rotate: revoke the presented token, persist its successor.
    sqlx::query("UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1")
        .bind(&row.id)
        .execute(&state.db)
        .await?;
    let (plain, new_hash) = new_refresh_token();
    sqlx::query(
        "INSERT INTO refresh_tokens (id, user_id, organization_id, token_hash, impersonated_role, expires_at) \
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))",
    )
    .bind(mf_db::new_id())
    .bind(&row.user_id)
    .bind(&membership.organization_id)
    .bind(&new_hash)
    .bind(&row.impersonated_role)
    .bind(refresh_ttl())
    .execute(&state.db)
    .await?;

    let (payload, access) =
        build_access_token(&state, &user, &membership, row.impersonated_role.as_deref())?;
    Ok(json_ok(serde_json::json!({
        "accessToken": access,
        "refreshToken": plain,
        "user": serialize_auth_user(&user, &membership, Some(&payload.role)),
    })))
}

/// POST /internal/tokens/verify — resolve a public-API bearer secret to its
/// token record (401 body matches the legacy v1 guard exactly). Touch
/// (lastUsedAt/requestCount) is fire-and-forget, like the legacy `touchToken`.
pub async fn verify_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    require_service(&state, &headers)?;

    let v = parse_body(&body)?;
    let m = as_object(v)?;
    let secret = req_str(&m, "secret")?;
    let hash = mf_auth::token_sha256(secret);

    let token: Option<TokenRow> = sqlx::query_as(
        "SELECT id, name, token_hash, prefix, request_count, last_used_at, revoked_at, created_at \
         FROM api_tokens WHERE token_hash = $1",
    )
    .bind(&hash)
    .fetch_optional(&state.db)
    .await?;

    match token {
        Some(t) if t.revoked_at.is_none() => {
            let organization: Option<String> =
                sqlx::query_scalar("SELECT organization_id FROM api_tokens WHERE id = $1")
                    .bind(&t.id)
                    .fetch_one(&state.db)
                    .await?;
            let organization =
                organization.ok_or_else(|| ApiError::unauthorized("token has no organization"))?;
            // fire-and-forget usage tracking — must never delay the response
            let db = state.db.clone();
            let id = t.id.clone();
            tokio::spawn(async move {
                let _ = sqlx::query(
                    "UPDATE api_tokens SET last_used_at = now(), request_count = request_count + 1 \
                     WHERE id = $1",
                )
                .bind(&id)
                .execute(&db)
                .await;
            });
            Ok(json_ok(serde_json::json!({
                "token": {
                    "id": t.id,
                    "organizationId": organization,
                    "name": t.name,
                    "prefix": t.prefix,
                    "requestCount": t.request_count,
                    // Additive (governance/public-api request): saves the
                    // whoami enrichment hop through /api/tokens.
                    "createdAt": mf_types::ts::format(&t.created_at),
                    "lastUsedAt": t.last_used_at.map(|d| mf_types::ts::format(&d)),
                }
            })))
        }
        _ => Err(ApiError::unauthorized("invalid or missing API token")),
    }
}

/// POST /internal/tokens/rate-limit — record one public-API request against
/// the token's sliding window and return the decision + header values.
pub async fn rate_limit(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    require_service(&state, &headers)?;

    let v = parse_body(&body)?;
    let m = as_object(v)?;
    let token_id = req_str(&m, "tokenId")?;
    let result = state.rate_limiter.check(token_id, TOKEN_RATE_LIMIT);
    Ok(json_ok(serde_json::to_value(result).unwrap_or_default()))
}

/// GET /internal/stats — auth-domain counts for governance settings/overview.
pub async fn stats(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    require_service(&state, &headers)?;
    let organization = headers
        .get("x-mf-organization-id")
        .and_then(|v| v.to_str().ok())
        .filter(|id| mf_db::valid_organization_id(id))
        .ok_or_else(|| ApiError::forbidden("organization context required"))?;

    let (users, api_tokens, active_tokens, api_request_logs, refresh_tokens): (
        i64,
        i64,
        i64,
        i64,
        i64,
    ) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM organization_memberships WHERE organization_id = $1 AND is_active), \
                    (SELECT count(*) FROM api_tokens WHERE organization_id = $1), \
                    (SELECT count(*) FROM api_tokens WHERE organization_id = $1 AND revoked_at IS NULL), \
                    (SELECT count(*) FROM api_request_logs WHERE token_id IN (SELECT id FROM api_tokens WHERE organization_id = $1)), \
                    (SELECT count(*) FROM refresh_tokens WHERE organization_id = $1 AND revoked_at IS NULL)",
    )
    .bind(organization)
    .fetch_one(&state.db)
    .await?;

    Ok(json_ok(serde_json::json!({
        "users": users,
        "apiTokens": api_tokens,
        "activeTokens": active_tokens,
        "apiRequestLogs": api_request_logs,
        "refreshTokens": refresh_tokens,
    })))
}

/// POST /internal/reset — wipe tokens/usage/refresh (KEEP users: legacy
/// settings/reset preserved accounts). Called by governance's reset fan-out.
pub async fn reset(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    require_service(&state, &headers)?;
    let organization = headers
        .get("x-mf-organization-id")
        .and_then(|v| v.to_str().ok())
        .filter(|id| mf_db::valid_organization_id(id))
        .ok_or_else(|| ApiError::forbidden("organization context required"))?;

    let logs: i64 = sqlx::query_scalar(
        "WITH deleted AS (DELETE FROM api_request_logs WHERE token_id IN (SELECT id FROM api_tokens WHERE organization_id = $1) RETURNING id) SELECT count(*) FROM deleted",
    )
    .bind(organization)
    .fetch_one(&state.db)
    .await?;
    let tokens: i64 = sqlx::query_scalar(
        "WITH deleted AS (DELETE FROM api_tokens WHERE organization_id = $1 RETURNING id) SELECT count(*) FROM deleted",
    )
    .bind(organization)
    .fetch_one(&state.db)
    .await?;
    let refresh: i64 = sqlx::query_scalar(
        "WITH deleted AS (DELETE FROM refresh_tokens WHERE organization_id = $1 RETURNING id) SELECT count(*) FROM deleted",
    )
    .bind(organization)
    .fetch_one(&state.db)
    .await?;

    Ok(json_ok(serde_json::json!({
        "ok": true,
        "apiRequestLogs": logs,
        "apiTokens": tokens,
        "refreshTokens": refresh,
    })))
}
