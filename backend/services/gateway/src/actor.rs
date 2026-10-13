//! Actor resolution — the gateway's core auth logic.
//!
//! Precedence (ports `getActor()` in governance.ts + middleware.ts, plus the
//! new transparent refresh):
//!
//! 1. valid access JWT (`foundry-session` cookie or `Authorization: Bearer`)
//!    → session actor (role/email/uid/name/realRole from claims);
//! 2. no valid access JWT but a `foundry-refresh` cookie → single-flight
//!    refresh through the auth service; on success the request proceeds as
//!    the refreshed session and the response carries the new cookies;
//! 3. demo mode only: the `foundry-role` simulator cookie (valid roles
//!    only) + `foundry-learner-id` → `learner:<uuid>` email;
//! 4. else: demo → trusted `admin` (machine callers the sandbox was built
//!    around); shared → `anonymous` (every role guard 403s).
//!
//! A valid `x-service-token` additionally marks the actor `is_service`
//! (bypasses role guards exactly like `isServiceAuthorized()` did).

use axum::http::HeaderMap;
use mf_auth::{Actor, SessionPayload};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex};

use crate::state::GatewayState;

/// Result of a successful transparent refresh.
#[derive(Debug, Clone)]
pub struct Refreshed {
    pub access: String,
    /// New refresh plaintext when the auth service rotated the token.
    pub refresh: Option<String>,
    pub payload: SessionPayload,
}

pub type InflightMap = Arc<Mutex<HashMap<String, broadcast::Sender<Result<Refreshed, ()>>>>>;

pub fn new_inflight() -> InflightMap {
    Arc::new(Mutex::new(HashMap::new()))
}

pub struct ResolvedActor {
    pub organization_role: Option<String>,
    pub actor: Actor,
    /// Present when this request triggered a transparent refresh — the
    /// handler attaches the new cookies to the proxied response.
    pub refreshed: Option<Refreshed>,
    /// True when a valid access JWT was present (or restored via refresh) —
    /// the shared-mode wall's "hasSession" check.
    pub has_session: bool,
}

pub async fn resolve(state: &GatewayState, headers: &HeaderMap) -> ResolvedActor {
    let is_service = state.mode.is_service_authorized(
        headers
            .get(mf_auth::SERVICE_TOKEN_HEADER)
            .and_then(|v| v.to_str().ok()),
    );

    // 1) access JWT from cookie or bearer header
    let cookie_token = get_cookie(headers, mf_auth::SESSION_COOKIE);
    let bearer = authorization_bearer(headers);
    let mut payload = cookie_token
        .as_deref()
        .and_then(|t| mf_auth::verify_token(t, &state.secret).ok())
        .or_else(|| {
            bearer
                .as_deref()
                .and_then(|t| mf_auth::verify_token(t, &state.secret).ok())
        });

    let mut refreshed = None;

    // 1b) transparent refresh (single-flight per refresh token)
    if payload.is_none() {
        if let Some(rt) = get_cookie(headers, mf_auth::REFRESH_COOKIE) {
            match single_flight_refresh(state, &rt).await {
                Ok(r) => {
                    payload = Some(r.payload.clone());
                    refreshed = Some(r);
                }
                Err(e) => {
                    tracing::debug!(error = %e, "transparent refresh failed");
                }
            }
        }
    }

    let mut organization_role = None;
    // Recheck live membership so demotions and disabled accounts take effect
    // immediately, including for previously issued access tokens.
    if let Some(p) = &mut payload {
        let result = state.http
            .post(format!("{}/internal/auth/validate", state.auth_url.trim_end_matches('/')))
            .header(mf_auth::SERVICE_TOKEN_HEADER, state.mode.service_token.as_deref().unwrap_or_default())
            .json(&serde_json::json!({ "userId": p.uid, "organizationId": p.organization_id, "effectiveRole": p.role }))
            .send().await;
        let validated = match result {
            Ok(response) if response.status().is_success() => {
                response.json::<serde_json::Value>().await.ok()
            }
            _ => None,
        };
        if let Some(value) = validated {
            organization_role = value
                .get("organizationRole")
                .and_then(|value| value.as_str())
                .map(str::to_string);
            if let Some(role) = value.get("role").and_then(|value| value.as_str()) {
                p.role = role.to_string();
                p.real_role = value
                    .get("realRole")
                    .and_then(|value| value.as_str())
                    .map(str::to_string);
            } else {
                payload = None;
                refreshed = None;
            }
        } else {
            payload = None;
            refreshed = None;
        }
    }
    let has_session = payload.is_some();

    // 2/3) cookie-less fallbacks per mode
    let actor = match payload {
        Some(p) => Actor {
            role: p.role,
            email: Some(p.email),
            uid: Some(p.uid),
            name: Some(p.name),
            real_role: p.real_role,
            organization_id: Some(p.organization_id),
            organization_role: organization_role.clone(),
            is_service,
        },
        None => {
            if state.mode.demo {
                let sim = get_cookie(headers, mf_auth::LEGACY_ROLE_COOKIE);
                let role = match sim.as_deref() {
                    Some("viewer") | Some("editor") | Some("admin") => sim.unwrap(),
                    _ => "admin".to_string(),
                };
                let email = get_cookie(headers, mf_auth::LEARNER_COOKIE)
                    .filter(|v| is_legacy_learner_id(v))
                    .map(|v| format!("learner:{v}"));
                Actor {
                    role,
                    email,
                    uid: None,
                    name: None,
                    real_role: None,
                    organization_id: None,
                    organization_role: None,
                    is_service,
                }
            } else {
                Actor {
                    is_service,
                    ..Actor::anonymous()
                }
            }
        }
    };

    ResolvedActor {
        organization_role,
        actor,
        refreshed,
        has_session,
    }
}

/// Legacy learner-id shape: /^[a-f0-9-]{36}$/.
fn is_legacy_learner_id(v: &str) -> bool {
    v.len() == 36 && v.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

fn get_cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    let raw = headers.get(axum::http::header::COOKIE)?.to_str().ok()?;
    for part in raw.split(';') {
        let part = part.trim();
        if let Some((k, v)) = part.split_once('=') {
            if k.trim() == name {
                return Some(v.trim().to_string());
            }
        }
    }
    None
}

fn authorization_bearer(headers: &HeaderMap) -> Option<String> {
    let header = headers
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .trim();
    let rest = header.strip_prefix("Bearer ").or_else(|| {
        header
            .to_lowercase()
            .strip_prefix("bearer ")
            .map(|_| &header["bearer ".len()..])
    })?;
    let t = rest.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

/// Single-flight refresh: concurrent requests carrying the SAME refresh token
/// (TanStack Query fires bursts) share one auth-service call; the winner's
/// tokens are reused by every waiter so rotation never races itself out.
async fn single_flight_refresh(
    state: &GatewayState,
    refresh_token: &str,
) -> Result<Refreshed, String> {
    let key = hex::encode(Sha256::digest(refresh_token.as_bytes()));

    enum Role {
        Leader(broadcast::Sender<Result<Refreshed, ()>>),
        Follower(broadcast::Receiver<Result<Refreshed, ()>>),
    }

    let role = {
        let mut map = state.inflight.lock().await;
        if let Some(tx) = map.get(&key) {
            Role::Follower(tx.subscribe())
        } else {
            let (tx, _rx) = broadcast::channel(1);
            map.insert(key.clone(), tx.clone());
            Role::Leader(tx)
        }
    };

    match role {
        Role::Follower(mut rx) => rx
            .recv()
            .await
            .map_err(|_| "refresh leader gone".to_string())?
            .map_err(|()| "refresh failed".to_string()),
        Role::Leader(tx) => {
            let outcome = call_refresh(state, refresh_token).await;
            let _ = tx.send(outcome.clone());
            state.inflight.lock().await.remove(&key);
            outcome.map_err(|()| "refresh failed".to_string())
        }
    }
}

async fn call_refresh(state: &GatewayState, refresh_token: &str) -> Result<Refreshed, ()> {
    let url = format!("{}/internal/auth/refresh", state.auth_url);
    let mut rb = state
        .http
        .post(&url)
        .json(&serde_json::json!({ "refreshToken": refresh_token }));
    if let Some(token) = &state.mode.service_token {
        rb = rb.header(mf_auth::SERVICE_TOKEN_HEADER, token);
    }
    let resp = rb.send().await.map_err(|e| {
        tracing::warn!(error = %e, "refresh call transport failed");
    })?;
    if !resp.status().is_success() {
        return Err(());
    }
    let body: serde_json::Value = resp.json().await.map_err(|_| ())?;
    let access = body
        .get("accessToken")
        .and_then(|v| v.as_str())
        .ok_or(())?
        .to_string();
    let refresh = body
        .get("refreshToken")
        .and_then(|v| v.as_str())
        .map(String::from);
    // Decode the freshly issued access token for the actor claims (never trust
    // the body's user object for authorization data).
    let payload = mf_auth::verify_token(&access, &state.secret).map_err(|_| ())?;
    Ok(Refreshed {
        access,
        refresh,
        payload,
    })
}

/// Access-JWT cookie TTL — must match the auth service (same env knob).
pub fn access_ttl() -> i64 {
    std::env::var("MF_ACCESS_TTL_SECONDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(15 * 60)
}

/// Refresh cookie TTL — must match the auth service.
pub fn refresh_ttl() -> i64 {
    std::env::var("MF_REFRESH_TTL_SECONDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(mf_auth::SESSION_TTL_SECONDS)
}
