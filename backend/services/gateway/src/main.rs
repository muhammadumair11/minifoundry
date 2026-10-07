//! MiniFoundry — API gateway.
//!
//! The platform's single public edge (besides the frontend's nginx):
//! - longest-prefix routing of /api/* to the domain services;
//! - actor resolution (JWT session → transparent refresh → demo simulator →
//!   mode fallback) with identity forwarded as `X-Mf-Actor-*` headers;
//! - the legacy shared-mode auth wall (401 without session/service token,
//!   allowlist: /api/auth, /api/session, /api/health, /api/foundry/v1);
//! - edge hygiene: client-supplied `X-Mf-*` / `x-service-token` headers are
//!   never forwarded, `/internal/*` is never routable;
//! - CORS for direct (non-nginx) API access.

mod actor;
mod proxy;
mod routing;
mod state;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use std::sync::Arc;
use tower_http::cors::{Any, AllowOrigin, CorsLayer};

use state::GatewayState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    mf_web::init_tracing("gateway");

    let mode = Arc::new(mf_auth::RuntimeMode::from_env());
    let secret = mf_auth::resolve_auth_secret(&mode).map_err(anyhow::Error::msg)?;
    tracing::info!(mode = mode.mode_label(), "runtime mode resolved");

    let state = GatewayState::new(secret, mode);

    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::mirror_request())
        .allow_credentials(true)
        .allow_methods(Any)
        .allow_headers(Any)
        .expose_headers([
            HeaderName::from_static("x-ratelimit-limit"),
            HeaderName::from_static("x-ratelimit-remaining"),
            HeaderName::from_static("x-ratelimit-reset"),
            HeaderName::from_static("retry-after"),
        ]);

    let app = Router::new()
        .route("/healthz", get(mf_web::healthz))
        .fallback(gateway_handler)
        .layer(DefaultBodyLimit::max(64 * 1024 * 1024))
        .layer(cors)
        .with_state(state);

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(8080);
    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(port, "gateway listening");
    axum::serve(listener, app).await?;
    Ok(())
}

/// Exact 401 body of the legacy shared-mode middleware.
const SHARED_MODE_401: &str = "Authentication required. MiniFoundry is running in shared mode — sign in at /login (machine callers: x-service-token header).";

async fn gateway_handler(
    State(state): State<GatewayState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let path = uri.path().to_string();

    // Legacy GET /api — platform hello.
    if path == "/api" || path == "/api/" {
        if method == Method::GET {
            return (StatusCode::OK, Json(serde_json::json!({ "message": "Hello, world!" })))
                .into_response();
        }
        return not_found();
    }

    // The gateway only serves /api/*. (The SPA is served by the frontend
    // container's nginx; /internal/* is unreachable here by design.)
    if !path.starts_with("/api/") || path.starts_with("/api/internal") {
        return not_found();
    }

    let Some(rule) = routing::resolve(&path, &state.routes) else {
        return not_found();
    };

    // Resolve the actor (may transparently refresh the session).
    let resolved = actor::resolve(&state, &headers).await;

    // Shared-mode auth wall (legacy middleware.ts): every /api/* route except
    // the allowlist requires a session or a valid service token.
    if !state.mode.demo
        && !routing::is_allowlisted(&path)
        && !resolved.has_session
        && !resolved.actor.is_service
    {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": SHARED_MODE_401 })),
        )
            .into_response();
    }

    // Refresh cookies to append to the proxied response.
    let mut extra_cookies: Vec<String> = Vec::new();
    if let Some(r) = &resolved.refreshed {
        extra_cookies.push(
            mf_web::cookie::session_cookie(
                r.access.clone(),
                state.cookie_secure,
                actor::access_ttl(),
            )
            .to_header(),
        );
        if let Some(rt) = &r.refresh {
            extra_cookies.push(
                mf_web::cookie::refresh_cookie(rt.clone(), state.cookie_secure, actor::refresh_ttl())
                    .to_header(),
            );
        }
    }

    let actor_headers = build_actor_headers(&resolved.actor, state.mode.demo);
    proxy::forward(
        &state,
        &rule.base_url,
        method,
        uri,
        headers,
        body,
        actor_headers,
        extra_cookies,
    )
    .await
}

/// Identity headers every downstream service trusts (inbound client copies
/// were stripped in proxy::forward before these are appended).
fn build_actor_headers(actor: &mf_auth::Actor, demo: bool) -> Vec<(HeaderName, HeaderValue)> {
    let mut out: Vec<(HeaderName, HeaderValue)> = Vec::with_capacity(7);
    let mut push = |out: &mut Vec<_>, name: &'static str, value: String| {
        if let Ok(v) = HeaderValue::from_str(&value) {
            out.push((HeaderName::from_static(name), v));
        }
    };
    push(&mut out, mf_auth::HEADER_ACTOR_ROLE, actor.role.clone());
    push(
        &mut out,
        mf_auth::HEADER_DEMO_MODE,
        (if demo { "1" } else { "0" }).to_string(),
    );
    if let Some(email) = &actor.email {
        push(&mut out, mf_auth::HEADER_ACTOR_EMAIL, mf_auth::hdr_encode(email));
    }
    if let Some(uid) = &actor.uid {
        push(&mut out, mf_auth::HEADER_ACTOR_UID, uid.clone());
    }
    if let Some(name) = &actor.name {
        push(&mut out, mf_auth::HEADER_ACTOR_NAME, mf_auth::hdr_encode(name));
    }
    if let Some(real_role) = &actor.real_role {
        push(&mut out, mf_auth::HEADER_ACTOR_REAL_ROLE, real_role.clone());
    }
    if actor.is_service {
        push(&mut out, mf_auth::HEADER_IS_SERVICE, "1".to_string());
    }
    out
}

fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({ "error": "not found" })),
    )
        .into_response()
}
