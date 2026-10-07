//! Shared service state + DB row models.

use chrono::{DateTime, Utc};
use mf_auth::RuntimeMode;
use sqlx::PgPool;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub nats: async_nats::Client,
    pub mode: Arc<RuntimeMode>,
    /// JWT signing secret (resolved per runtime-mode rules at boot).
    pub secret: Arc<String>,
    /// Cookie `Secure` flag. Mirrors the legacy `NODE_ENV === 'production'`
    /// rule; overridable via MF_COOKIE_SECURE=0/1 for LAN http access.
    pub cookie_secure: bool,
    /// Sliding-window rate limiter for public API tokens (shared by all
    /// public-api replicas through the internal verify/rate-limit calls).
    pub rate_limiter: Arc<crate::ratelimit::RateLimiter>,
}

// ─── DB rows ────────────────────────────────────────────────────────────

#[derive(Debug, sqlx::FromRow)]
pub struct UserRow {
    pub id: String,
    pub email: String,
    pub name: String,
    pub role: String,
    pub password_hash: String,
    pub is_active: bool,
    pub last_login_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, sqlx::FromRow)]
pub struct TokenRow {
    pub id: String,
    pub name: String,
    /// Selected for completeness; never exposed by any serializer.
    #[allow(dead_code)]
    pub token_hash: String,
    pub prefix: String,
    pub request_count: i32,
    pub last_used_at: Option<DateTime<Utc>>,
    pub revoked_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, sqlx::FromRow)]
pub struct RequestLogRow {
    pub id: String,
    pub token_id: String,
    pub route: String,
    pub status: i32,
    pub duration_ms: i32,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, sqlx::FromRow)]
pub struct RefreshRow {
    pub id: String,
    pub user_id: String,
    /// Lookup key; kept on the row for auditability, never serialized.
    #[allow(dead_code)]
    pub token_hash: String,
    pub impersonated_role: Option<String>,
    pub expires_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
}

// ─── Serializers (exact legacy shapes) ──────────────────────────────────

/// Login/me shape: { id, email, name, role, lastLoginAt } — NEVER passwordHash.
pub fn serialize_auth_user(u: &UserRow) -> serde_json::Value {
    serde_json::json!({
        "id": u.id,
        "email": u.email,
        "name": u.name,
        "role": u.role,
        "lastLoginAt": u.last_login_at.map(|d| mf_types::ts::format(&d)),
    })
}

/// Admin users-list shape: adds isActive + createdAt.
pub fn serialize_admin_user(u: &UserRow) -> serde_json::Value {
    serde_json::json!({
        "id": u.id,
        "email": u.email,
        "name": u.name,
        "role": u.role,
        "lastLoginAt": u.last_login_at.map(|d| mf_types::ts::format(&d)),
        "isActive": u.is_active,
        "createdAt": mf_types::ts::format(&u.created_at),
    })
}

/// Token list shape (GET /api/tokens).
pub fn serialize_token(t: &TokenRow) -> serde_json::Value {
    serde_json::json!({
        "id": t.id,
        "name": t.name,
        "prefix": t.prefix,
        "requestCount": t.request_count,
        "lastUsedAt": t.last_used_at.map(|d| mf_types::ts::format(&d)),
        "revokedAt": t.revoked_at.map(|d| mf_types::ts::format(&d)),
        "createdAt": mf_types::ts::format(&t.created_at),
    })
}
