//! Tolerant internal fan-out client (same local wrapper as the governance
//! service): the frozen `mf_internal::ServiceClient` cannot attach custom
//! headers, but every v1 data call must forward a VIEWER actor so catalog /
//! ontology apply column-marking masking (legacy: "an ApiToken acts with
//! VIEWER role"). Env resolution mirrors `ServiceClient::from_env`.

use mf_auth::Actor;
use serde_json::Value;
use std::time::Duration;

#[derive(Debug, thiserror::Error)]
pub enum FanOutError {
    #[error("service unavailable: {0}")]
    Transport(String),
    #[error("{status}: {message}")]
    Api {
        status: u16,
        message: String,
        detail: Option<Value>,
    },
}

impl FanOutError {
    #[allow(dead_code)] // parity with the governance wrapper; pass_through covers the routes
    pub fn is_transport(&self) -> bool {
        matches!(self, FanOutError::Transport(_))
    }
}

/// 502 with the documented public-api degradation body (closest legacy
/// analog for an unreachable dependency; legacy had in-process DB access).
pub fn upstream_unavailable() -> mf_web::ApiError {
    mf_web::ApiError::new(
        axum::http::StatusCode::BAD_GATEWAY,
        "upstream service unavailable",
    )
}

/// Pass a callee API error through unchanged (status + { error, detail? }) —
/// the owning services produce the exact legacy messages (404s etc.).
pub fn pass_through(err: FanOutError) -> mf_web::ApiError {
    match err {
        FanOutError::Transport(_) => upstream_unavailable(),
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

/// Map any fan-out failure onto an ApiError (transport → 502).
pub fn fanout_err(err: FanOutError) -> mf_web::ApiError {
    pass_through(err)
}

#[derive(Clone)]
pub struct FanOut {
    pub service: &'static str,
    base_url: String,
    service_token: Option<String>,
    http: reqwest::Client,
}

impl FanOut {
    pub fn from_env(service: &'static str, env_var: &str, default_port: u16) -> Self {
        let base_url =
            std::env::var(env_var).unwrap_or_else(|_| format!("http://{service}:{default_port}"));
        let service_token = std::env::var("MF_SERVICE_TOKEN")
            .ok()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty());
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
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

    pub async fn get(&self, path: &str) -> Result<Value, FanOutError> {
        let rb = self.base_headers(self.http.get(self.url(path)));
        self.send(rb).await
    }

    /// GET with `X-Mf-Actor-*` forwarded (masking-dependent reads).
    pub async fn get_as(&self, path: &str, actor: &Actor) -> Result<Value, FanOutError> {
        let rb = with_actor(self.base_headers(self.http.get(self.url(path))), actor);
        self.send(rb).await
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
            return serde_json::from_str(&text)
                .map_err(|e| FanOutError::Transport(format!("bad JSON from {}: {e}", self.service)));
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

/// Attach `X-Mf-Actor-*` headers exactly like the gateway does.
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

/// API tokens act as VIEWER (legacy api-v1.ts). Forwarded so catalog/ontology
/// internal endpoints mask marked columns.
pub fn viewer_actor() -> Actor {
    Actor {
        role: mf_auth::ROLE_VIEWER.to_string(),
        ..Actor::anonymous()
    }
}

/// Trusted service actor for auth's admin-only public routes (whoami
/// enrichment reads /api/tokens; auth exposes no internal equivalent).
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

/// Lenient items-array extraction: `{key:[…]}`, a well-known sibling key
/// (`results/data/items/rows/objects`) or a bare array.
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

/// Unwrap a `{dataset:…}` / `{version:…}` / `{pipeline:…}` envelope.
pub fn payload_root<'a>(v: &'a Value, keys: &[&str]) -> &'a Value {
    for k in keys {
        if let Some(inner) = v.get(*k) {
            if inner.is_object() {
                return inner;
            }
        }
    }
    v
}

/// Minimal percent-encoding for query values / path segments.
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
