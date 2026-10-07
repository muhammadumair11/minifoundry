//! Tolerant internal fan-out client (local wrapper over the mf-internal
//! contract — the frozen `ServiceClient` cannot attach custom headers, and
//! governance must forward `X-Mf-Actor-*` on calls whose legacy behavior
//! depends on the caller, plus keep full `{ error, detail }` bodies for
//! exact pass-through of callee 4xx contracts).
//!
//! Env resolution mirrors `mf_internal::ServiceClient::from_env`.

use mf_auth::Actor;
use serde_json::Value;
use std::time::Duration;

#[derive(Debug, thiserror::Error)]
pub enum FanOutError {
    /// Callee unreachable / timed out — services DEGRADE on this (legacy
    /// in-process calls had no such failure mode; each call site picks the
    /// legacy-faithful fallback).
    #[error("service unavailable: {0}")]
    Transport(String),
    /// Non-2xx with the callee's body preserved (`{ error, detail? }`).
    #[error("{status}: {message}")]
    Api {
        status: u16,
        message: String,
        detail: Option<Value>,
    },
}

impl FanOutError {
    pub fn is_transport(&self) -> bool {
        matches!(self, FanOutError::Transport(_))
    }
}

/// Map any fan-out failure onto the platform 502 envelope used when a
/// downstream is REQUIRED (closest legacy analog: serverError; documented
/// per route).
pub fn upstream_unavailable() -> mf_web::ApiError {
    mf_web::ApiError::new(
        axum::http::StatusCode::BAD_GATEWAY,
        "upstream service unavailable",
    )
}

/// Pass a callee API error through unchanged (status + { error, detail? }).
pub fn pass_through(err: FanOutError) -> mf_web::ApiError {
    match err {
        FanOutError::Transport(m) => mf_web::ApiError::new(
            axum::http::StatusCode::BAD_GATEWAY,
            format!("upstream service unavailable: {m}"),
        ),
        FanOutError::Api {
            status,
            message,
            detail,
        } => {
            let code = axum::http::StatusCode::from_u16(status)
                .unwrap_or(axum::http::StatusCode::BAD_GATEWAY);
            let mut e = mf_web::ApiError::new(code, message);
            if let Some(d) = detail {
                e = e.with_detail(d);
            }
            e
        }
    }
}

#[derive(Clone)]
pub struct FanOut {
    pub service: &'static str,
    base_url: String,
    service_token: Option<String>,
    http: reqwest::Client,
}

impl FanOut {
    /// Same env contract as `mf_internal::ServiceClient::from_env`.
    pub fn from_env(service: &'static str, env_var: &str, default_port: u16) -> Self {
        let base_url =
            std::env::var(env_var).unwrap_or_else(|_| format!("http://{service}:{default_port}"));
        let service_token = std::env::var("MF_SERVICE_TOKEN")
            .ok()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty());
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(3))
            .build()
            .expect("reqwest client");
        Self {
            service,
            base_url: base_url.trim_end_matches('/').to_string(),
            service_token,
            http,
        }
    }

    fn url(&self, path: &str) -> String {
        format!(
            "{}{}",
            self.base_url,
            if path.starts_with('/') {
                path.to_string()
            } else {
                format!("/{path}")
            }
        )
    }

    fn base_headers(&self, mut rb: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        rb = rb.header("accept", "application/json");
        if let Some(token) = &self.service_token {
            rb = rb.header(mf_auth::SERVICE_TOKEN_HEADER, token);
        }
        rb
    }

    /// GET returning the parsed JSON body (`Value::Null` on 204/empty).
    pub async fn get(&self, path: &str) -> Result<Value, FanOutError> {
        let rb = self.base_headers(self.http.get(self.url(path)));
        self.send(rb).await
    }

    /// GET with the caller's identity forwarded (`X-Mf-Actor-*`) — for
    /// internal endpoints whose result depends on the actor (masking, ACL).
    pub async fn get_as(&self, path: &str, actor: &Actor) -> Result<Value, FanOutError> {
        let rb = self.base_headers(self.http.get(self.url(path)));
        self.send(with_actor(rb, actor)).await
    }

    pub async fn post(&self, path: &str, body: &Value) -> Result<Value, FanOutError> {
        let rb = self.base_headers(self.http.post(self.url(path)).json(body));
        self.send(rb).await
    }

    async fn send(&self, rb: reqwest::RequestBuilder) -> Result<Value, FanOutError> {
        let resp = rb
            .send()
            .await
            .map_err(|e| FanOutError::Transport(e.to_string()))?;
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        if (200..300).contains(&status) {
            if text.trim().is_empty() {
                return Ok(Value::Null);
            }
            return serde_json::from_str(&text).map_err(|e| {
                FanOutError::Transport(format!("bad JSON from {}: {e}", self.service))
            });
        }
        let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        let message = body
            .get("error")
            .and_then(|v| v.as_str())
            .map(String::from)
            .unwrap_or_else(|| {
                if text.is_empty() {
                    format!("{} returned {status}", self.service)
                } else {
                    text.chars().take(300).collect()
                }
            });
        let detail = body.get("detail").cloned();
        Err(FanOutError::Api {
            status,
            message,
            detail,
        })
    }
}

/// Attach the `X-Mf-Actor-*` identity headers (email/name base64url-encoded,
/// exactly like the gateway does).
pub fn with_actor(rb: reqwest::RequestBuilder, actor: &Actor) -> reqwest::RequestBuilder {
    let mut rb = rb.header(mf_auth::HEADER_ACTOR_ROLE, actor.role.as_str());
    if let Some(email) = &actor.email {
        rb = rb.header(mf_auth::HEADER_ACTOR_EMAIL, mf_auth::hdr_encode(email));
    }
    if let Some(uid) = &actor.uid {
        rb = rb.header(mf_auth::HEADER_ACTOR_UID, uid.as_str());
    }
    if let Some(name) = &actor.name {
        rb = rb.header(mf_auth::HEADER_ACTOR_NAME, mf_auth::hdr_encode(name));
    }
    if let Some(real) = &actor.real_role {
        rb = rb.header(mf_auth::HEADER_ACTOR_REAL_ROLE, real.as_str());
    }
    if actor.is_service {
        rb = rb.header(mf_auth::HEADER_IS_SERVICE, "1");
    }
    rb
}

/// A trusted machine actor that also satisfies admin-only PUBLIC routes on
/// sibling services (x-mf-service: 1 + service token → require_role bypass in
/// mf-web). Used for auth's /api/users + /api/tokens reads (settings
/// overview counts, ACL user-existence check) — auth exposes no internal
/// equivalents.
pub fn service_admin_actor() -> Actor {
    Actor {
        role: mf_auth::ROLE_ADMIN.to_string(),
        email: None,
        uid: None,
        name: None,
        real_role: None,
        is_service: true,
    }
}

/// Lenient extraction of an items array from a sibling-service response:
/// accepts `{key: [...]}`, `{results/data/items: [...]}` or a bare array.
pub fn items_array(v: &Value, key: &str) -> Vec<Value> {
    if let Some(arr) = v.get(key).and_then(|x| x.as_array()) {
        return arr.clone();
    }
    for k in ["results", "data", "items", "rows", "objects"] {
        if let Some(arr) = v.get(k).and_then(|x| x.as_array()) {
            return arr.clone();
        }
    }
    if let Some(arr) = v.as_array() {
        return arr.clone();
    }
    Vec::new()
}

/// Minimal percent-encoding for path segments/query values (encodes
/// everything outside the RFC 3986 unreserved set).
pub fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn items_array_is_lenient() {
        assert_eq!(
            items_array(&serde_json::json!({ "datasets": [1] }), "datasets"),
            vec![serde_json::json!(1)]
        );
        assert_eq!(
            items_array(&serde_json::json!({ "results": [2] }), "datasets"),
            vec![serde_json::json!(2)]
        );
        assert_eq!(
            items_array(&serde_json::json!([3]), "datasets"),
            vec![serde_json::json!(3)]
        );
        assert!(items_array(&serde_json::json!({}), "datasets").is_empty());
    }

    #[test]
    fn transport_vs_api_errors() {
        assert!(FanOutError::Transport("x".into()).is_transport());
        let e = FanOutError::Api {
            status: 404,
            message: "nope".into(),
            detail: None,
        };
        assert!(!e.is_transport());
        let api = pass_through(e);
        assert_eq!(api.status, axum::http::StatusCode::NOT_FOUND);
        assert_eq!(api.message, "nope");
        assert_eq!(
            pass_through(FanOutError::Transport("down".into())).status,
            axum::http::StatusCode::BAD_GATEWAY
        );
    }
}
