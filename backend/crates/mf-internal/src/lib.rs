//! MiniFoundry — internal service-to-service HTTP client.
//!
//! Sync cross-domain calls go over `/internal/*` endpoints on the Docker
//! internal network (never routed by the gateway). Callers authenticate with
//! the shared `x-service-token` so the callee can trust the caller as the
//! `system` actor — same mechanism as the old scheduler mini-service.
//!
//! Error handling: a non-2xx internal response becomes [`InternalError::Api`]
//! carrying the callee's `{ error }` message so the caller can surface the
//! exact contract error to its own client.

use serde::de::DeserializeOwned;
use serde::Serialize;
use std::time::Duration;

#[derive(Debug, thiserror::Error)]
pub enum InternalError {
    #[error("service unavailable: {0}")]
    Transport(String),
    #[error("{status}: {message}")]
    Api { status: u16, message: String },
}

/// Client for one downstream service.
#[derive(Clone)]
pub struct ServiceClient {
    http: reqwest::Client,
    base_url: String,
    service_token: Option<String>,
    pub service: &'static str,
}

impl ServiceClient {
    /// Build from an env var holding the service base URL
    /// (e.g. `CATALOG_INTERNAL_URL`, default `http://catalog:8082`).
    pub fn from_env(service: &'static str, env_var: &str, default_port: u16) -> Self {
        let base_url =
            std::env::var(env_var).unwrap_or_else(|_| format!("http://{service}:{default_port}"));
        let service_token = std::env::var("MF_SERVICE_TOKEN")
            .ok()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty());
        Self::new(service, base_url, service_token)
    }

    pub fn new(service: &'static str, base_url: String, service_token: Option<String>) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .connect_timeout(Duration::from_secs(5))
            .build()
            .expect("reqwest client");
        Self {
            http,
            base_url: base_url.trim_end_matches('/').to_string(),
            service_token,
            service,
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

    fn authed(&self, rb: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        let rb = rb.header("accept", "application/json");
        match &self.service_token {
            Some(token) => rb.header(mf_auth::SERVICE_TOKEN_HEADER, token),
            None => rb,
        }
    }

    pub async fn get_json<T: DeserializeOwned>(&self, path: &str) -> Result<T, InternalError> {
        let resp = self
            .authed(self.http.get(self.url(path)))
            .send()
            .await
            .map_err(|e| InternalError::Transport(e.to_string()))?;
        Self::parse(resp).await
    }

    pub async fn post_json<B: Serialize, T: DeserializeOwned>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<T, InternalError> {
        let resp = self
            .authed(self.http.post(self.url(path)).json(body))
            .send()
            .await
            .map_err(|e| InternalError::Transport(e.to_string()))?;
        Self::parse(resp).await
    }

    pub async fn post_empty<T: DeserializeOwned>(&self, path: &str) -> Result<T, InternalError> {
        let resp = self
            .authed(self.http.post(self.url(path)))
            .send()
            .await
            .map_err(|e| InternalError::Transport(e.to_string()))?;
        Self::parse(resp).await
    }

    pub async fn delete(&self, path: &str) -> Result<(), InternalError> {
        let resp = self
            .authed(self.http.delete(self.url(path)))
            .send()
            .await
            .map_err(|e| InternalError::Transport(e.to_string()))?;
        let status = resp.status().as_u16();
        if resp.status().is_success() {
            return Ok(());
        }
        let message = Self::error_message(resp).await;
        Err(InternalError::Api { status, message })
    }

    async fn parse<T: DeserializeOwned>(resp: reqwest::Response) -> Result<T, InternalError> {
        let status = resp.status().as_u16();
        if resp.status().is_success() {
            if status == 204 {
                // No body — deserialize from "null" only for Option-ish T.
                return serde_json::from_value(serde_json::Value::Null).map_err(|e| {
                    InternalError::Api {
                        status,
                        message: format!("empty response decode: {e}"),
                    }
                });
            }
            return resp
                .json::<T>()
                .await
                .map_err(|e| InternalError::Transport(e.to_string()));
        }
        let message = Self::error_message(resp).await;
        Err(InternalError::Api { status, message })
    }

    async fn error_message(resp: reqwest::Response) -> String {
        let text = resp.text().await.unwrap_or_default();
        serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(String::from))
            .unwrap_or_else(|| {
                if text.is_empty() {
                    "internal call failed".into()
                } else {
                    text
                }
            })
    }
}

/// Map an [`InternalError::Api`] onto an mf-web `ApiError` with the same
/// status (so contract errors pass through unchanged across hops).
pub fn to_api_error(err: InternalError) -> mf_web_types::ApiErrorLike {
    mf_web_types::ApiErrorLike::from(err)
}

/// Tiny shim so mf-internal does not depend on axum (mf-web depends on
/// mf-internal consumers instead): services convert via `into()`.
pub mod mf_web_types {
    use super::InternalError;

    #[derive(Debug)]
    pub struct ApiErrorLike {
        pub status: u16,
        pub message: String,
    }

    impl From<InternalError> for ApiErrorLike {
        fn from(e: InternalError) -> Self {
            match e {
                InternalError::Transport(m) => ApiErrorLike {
                    status: 502,
                    message: m,
                },
                InternalError::Api { status, message } => ApiErrorLike { status, message },
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_joining() {
        let c = ServiceClient::new("catalog", "http://catalog:8082/".into(), None);
        assert_eq!(c.url("/internal/x"), "http://catalog:8082/internal/x");
        assert_eq!(c.url("internal/x"), "http://catalog:8082/internal/x");
    }

    #[test]
    fn error_mapping() {
        let e: mf_web_types::ApiErrorLike = InternalError::Api {
            status: 404,
            message: "nope".into(),
        }
        .into();
        assert_eq!(e.status, 404);
        let e: mf_web_types::ApiErrorLike = InternalError::Transport("down".into()).into();
        assert_eq!(e.status, 502);
    }
}
