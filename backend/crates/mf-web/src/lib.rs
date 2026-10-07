//! MiniFoundry — axum web glue shared by every service.
//!
//! Contract rules ported from `src/lib/api-utils.ts` + `src/lib/governance.ts`:
//! - Every error is `{ "error": "<msg>" }` (+ optional `"detail"`), with the
//!   exact status codes the old routes used.
//! - Role guards 403 with `requires <min> role (current: <role>)`.
//! - Actors come from gateway-injected `X-Mf-Actor-*` headers; services trust
//!   these on the internal network (the gateway strips client-supplied copies).

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use mf_auth::Actor;

pub mod cookie;

// ─── Tracing ────────────────────────────────────────────────────────────

/// Initialize tracing-subscriber for a service (RUST_LOG honored, JSON off by
/// default; set `MF_LOG_FORMAT=json` for structured logs).
pub fn init_tracing(service: &str) {
    use tracing_subscriber::{fmt, prelude::*, EnvFilter};
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,sqlx=warn,tower_http=warn"));
    if std::env::var("MF_LOG_FORMAT").map(|v| v == "json").unwrap_or(false) {
        tracing_subscriber::registry()
            .with(filter)
            .with(fmt::layer().json().with_target(true).with_current_thread(true))
            .init();
    } else {
        tracing_subscriber::registry()
            .with(filter)
            .with(fmt::layer().with_target(true))
            .init();
    }
    tracing::info!(service, "tracing initialized");
}

// ─── Error envelope ─────────────────────────────────────────────────────

/// API error → `{ error, detail? }` with the correct status. Mirrors
/// `jsonError(status, error, detail?)`.
#[derive(Debug, thiserror::Error)]
#[error("{status}: {message}")]
pub struct ApiError {
    pub status: StatusCode,
    pub message: String,
    pub detail: Option<serde_json::Value>,
}

impl ApiError {
    pub fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self { status, message: message.into(), detail: None }
    }
    pub fn with_detail(mut self, detail: serde_json::Value) -> Self {
        self.detail = Some(detail);
        self
    }

    pub fn bad_request(message: impl Into<String>) -> Self { Self::new(StatusCode::BAD_REQUEST, message) }
    pub fn unauthorized(message: impl Into<String>) -> Self { Self::new(StatusCode::UNAUTHORIZED, message) }
    pub fn forbidden(message: impl Into<String>) -> Self { Self::new(StatusCode::FORBIDDEN, message) }
    pub fn not_found(message: impl Into<String>) -> Self { Self::new(StatusCode::NOT_FOUND, message) }
    pub fn conflict(message: impl Into<String>) -> Self { Self::new(StatusCode::CONFLICT, message) }
    pub fn too_many(status: StatusCode, message: impl Into<String>, detail: Option<serde_json::Value>) -> Self {
        Self { status, message: message.into(), detail }
    }
    pub fn internal(message: impl Into<String>) -> Self { Self::new(StatusCode::INTERNAL_SERVER_ERROR, message) }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut body = serde_json::json!({ "error": self.message });
        if let Some(detail) = self.detail {
            body["detail"] = detail;
        }
        (self.status, Json(body)).into_response()
    }
}

/// Every fallible handler returns `ApiResult<T>`.
pub type ApiResult<T> = Result<T, ApiError>;

/// Catch-all: unexpected errors become 500 `{ error: "<msg>" }` (the old
/// `serverError(err.message)` behavior).
impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self { ApiError::internal(e.to_string()) }
}

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        match e {
            sqlx::Error::RowNotFound => ApiError::not_found("not found"),
            other => ApiError::internal(other.to_string()),
        }
    }
}

// ─── Actor extraction ───────────────────────────────────────────────────

/// Extracts the gateway-resolved [`Actor`] from `X-Mf-Actor-*` headers.
/// When the gateway did not run (direct internal hit) the actor is
/// `anonymous` — role guards then deny, which is the safe default.
impl<S: Send + Sync> FromRequestParts<S> for Actor {
    type Rejection = ApiError;

    fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> impl std::future::Future<Output = Result<Self, Self::Rejection>> + Send {
        let role = header_str(parts, mf_auth::HEADER_ACTOR_ROLE)
            .unwrap_or_else(|| mf_auth::ROLE_ANONYMOUS.to_string());
        let email = header_str(parts, mf_auth::HEADER_ACTOR_EMAIL).map(|e| mf_auth::hdr_decode(&e));
        let uid = header_str(parts, mf_auth::HEADER_ACTOR_UID);
        let name = header_str(parts, mf_auth::HEADER_ACTOR_NAME).map(|n| mf_auth::hdr_decode(&n));
        let real_role = header_str(parts, mf_auth::HEADER_ACTOR_REAL_ROLE);
        let is_service = header_str(parts, mf_auth::HEADER_IS_SERVICE).as_deref() == Some("1");
        async move {
            Ok(Actor { role, email, uid, name, real_role, is_service })
        }
    }
}

fn header_str(parts: &Parts, name: &str) -> Option<String> {
    parts
        .headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
}

/// Build an [`Actor`] directly from request headers (non-extractor contexts,
/// e.g. handlers that also need raw header access). Email/name travel
/// base64url-encoded (UTF-8 safety); decoding falls back to raw values.
pub fn actor_from_headers(headers: &axum::http::HeaderMap) -> mf_auth::Actor {
    let get = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty())
    };
    mf_auth::Actor {
        role: get(mf_auth::HEADER_ACTOR_ROLE).unwrap_or_else(|| mf_auth::ROLE_ANONYMOUS.to_string()),
        email: get(mf_auth::HEADER_ACTOR_EMAIL).map(|e| mf_auth::hdr_decode(&e)),
        uid: get(mf_auth::HEADER_ACTOR_UID),
        name: get(mf_auth::HEADER_ACTOR_NAME).map(|n| mf_auth::hdr_decode(&n)),
        real_role: get(mf_auth::HEADER_ACTOR_REAL_ROLE),
        is_service: get(mf_auth::HEADER_IS_SERVICE).as_deref() == Some("1"),
    }
}

/// Demo-mode flag as forwarded by the gateway.
pub fn demo_mode(parts: &Parts) -> bool {
    header_str(parts, mf_auth::HEADER_DEMO_MODE).as_deref() == Some("1")
}

// ─── Role guard ─────────────────────────────────────────────────────────

/// Port of `requireRole()`: service-token callers bypass; otherwise the
/// actor's role must satisfy `min`. Err carries the EXACT legacy 403 body
/// `requires <min> role (current: <role>)`.
pub fn require_role(actor: &Actor, min: &str) -> Result<(), ApiError> {
    if actor.is_service {
        return Ok(());
    }
    if mf_auth::role_at_least(&actor.role, min) {
        return Ok(());
    }
    Err(ApiError::forbidden(format!(
        "requires {min} role (current: {})",
        actor.role
    )))
}

/// Actor-or-service convenience used by routes that audit `actorRole`.
pub fn audit_role(actor: &Actor) -> &str {
    if actor.is_service { mf_auth::ROLE_SYSTEM } else { &actor.role }
}

// ─── Response helpers ───────────────────────────────────────────────────

/// 200 with a JSON body (mirrors `jsonOk(data)`).
pub fn json_ok<T: serde::Serialize>(data: T) -> Response {
    (StatusCode::OK, Json(serde_json::to_value(data).unwrap_or(serde_json::Value::Null))).into_response()
}

/// 201 with a JSON body.
pub fn json_created<T: serde::Serialize>(data: T) -> Response {
    (StatusCode::CREATED, Json(serde_json::to_value(data).unwrap_or(serde_json::Value::Null))).into_response()
}

/// 202 with a JSON body (queued jobs).
pub fn json_accepted<T: serde::Serialize>(data: T) -> Response {
    (StatusCode::ACCEPTED, Json(serde_json::to_value(data).unwrap_or(serde_json::Value::Null))).into_response()
}

/// 204 No Content (DELETE endpoints).
pub fn no_content() -> Response {
    StatusCode::NO_CONTENT.into_response()
}

/// `/healthz` liveness handler for every service.
pub async fn healthz() -> impl IntoResponse {
    Json(serde_json::json!({ "status": "ok" }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;

    fn parts_with(headers: Vec<(&str, &str)>) -> Parts {
        let mut req = Request::builder().uri("/");
        for (k, v) in headers {
            req = req.header(k, v);
        }
        req.body(Body::empty()).unwrap().into_parts().0
    }

    #[test]
    fn error_envelope_shape() {
        let e = ApiError::bad_request("nope").with_detail(serde_json::json!({ "reasons": [] }));
        let resp = e.into_response();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn role_guard_message_matches_legacy() {
        let actor = Actor { role: "viewer".into(), ..Actor::anonymous() };
        let err = require_role(&actor, "editor").unwrap_err();
        assert_eq!(err.message, "requires editor role (current: viewer)");
        assert_eq!(err.status, StatusCode::FORBIDDEN);
    }

    #[test]
    fn service_actor_bypasses_guard() {
        let actor = Actor::service();
        assert!(require_role(&actor, "admin").is_ok());
        assert_eq!(audit_role(&actor), "system");
    }

    #[test]
    fn actor_from_headers() {
        let mut parts = parts_with(vec![
            (mf_auth::HEADER_ACTOR_ROLE, "editor"),
            (mf_auth::HEADER_ACTOR_EMAIL, "a@b.c"),
            (mf_auth::HEADER_IS_SERVICE, "1"),
        ]);
        let role = header_str(&mut parts, mf_auth::HEADER_ACTOR_ROLE);
        assert_eq!(role.as_deref(), Some("editor"));
        let email = header_str(&mut parts, mf_auth::HEADER_ACTOR_EMAIL);
        assert_eq!(email.as_deref(), Some("a@b.c"));
        assert!(demo_mode(&parts_with(vec![(mf_auth::HEADER_DEMO_MODE, "1")])));
        assert!(!demo_mode(&parts_with(vec![])));
    }
}
