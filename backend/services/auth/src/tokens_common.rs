//! Session issuance helpers shared by login and the internal refresh flow.

use crate::cookies::{self, CookieSpec};
use crate::state::{AppState, UserRow};
use mf_auth::{SessionPayload, build_session, sign_token};
use rand::RngCore;
use sha2::{Digest, Sha256};

/// Access-JWT lifetime (legacy session TTL was 7d; short access + rotating
/// refresh preserves the UX while bounding stolen-token exposure).
pub fn access_ttl() -> i64 {
    std::env::var("MF_ACCESS_TTL_SECONDS").ok().and_then(|v| v.parse().ok()).unwrap_or(15 * 60)
}

/// Refresh-token lifetime — matches the legacy 7-day session TTL.
pub fn refresh_ttl() -> i64 {
    std::env::var("MF_REFRESH_TTL_SECONDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(mf_auth::SESSION_TTL_SECONDS)
}

// Legacy aliases used by route code.
pub fn ACCESS_TTL() -> i64 { access_ttl() }
pub fn REFRESH_TTL() -> i64 { refresh_ttl() }

/// Generate a refresh token: (plaintext 64-hex, sha256 hash).
pub fn new_refresh_token() -> (String, String) {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let plain = hex::encode(bytes);
    let hash = hex::encode(Sha256::digest(plain.as_bytes()));
    (plain, hash)
}

/// Build the access JWT for a user (optionally impersonating `role_override`).
pub fn build_access_token(
    state: &AppState,
    user: &UserRow,
    role_override: Option<&str>,
) -> Result<(SessionPayload, String), mf_web::ApiError> {
    let override_role = role_override.filter(|r| *r != user.role);
    let payload = build_session(
        &user.id,
        &user.email,
        &user.name,
        override_role.unwrap_or(&user.role),
        override_role.map(|_| user.role.clone()),
        access_ttl(),
    );
    let token = sign_token(&payload, &state.secret)
        .map_err(|_| mf_web::ApiError::internal("failed to sign session token"))?;
    Ok((payload, token))
}

/// Issue the full cookie set for an authenticated user: access JWT +
/// rotating refresh token (persisted hashed) + legacy JS-readable role cookie.
/// `role_override` implements admin impersonation (payload carries effective
/// role + realRole, mirroring `createSessionToken(user, { roleOverride })`).
pub async fn issue_session_pair(
    state: &AppState,
    user: &UserRow,
    role_override: Option<&str>,
) -> Result<(Vec<CookieSpec>, String), mf_web::ApiError> {
    let (payload, access) = build_access_token(state, user, role_override)?;

    let (refresh_plain, refresh_hash) = new_refresh_token();
    let id = mf_db::new_id();
    sqlx::query(
        "INSERT INTO refresh_tokens (id, user_id, token_hash, impersonated_role, expires_at) \
         VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))",
    )
    .bind(&id)
    .bind(&user.id)
    .bind(&refresh_hash)
    .bind(role_override.filter(|r| *r != user.role))
    .bind(refresh_ttl())
    .execute(&state.db)
    .await
    .map_err(|e| mf_web::ApiError::internal(e.to_string()))?;

    let specs = vec![
        cookies::session_cookie(access, state.cookie_secure, access_ttl()),
        cookies::refresh_cookie(refresh_plain.clone(), state.cookie_secure, refresh_ttl()),
        cookies::role_cookie(payload.role.clone(), state.cookie_secure, refresh_ttl()),
    ];
    Ok((specs, refresh_plain))
}
