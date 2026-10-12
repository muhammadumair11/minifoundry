//! Gateway shared state.

use mf_auth::RuntimeMode;
use std::sync::Arc;
use std::time::Duration;

use crate::actor::{InflightMap, Refreshed};
use crate::routing::RouteRule;

#[allow(unused_imports)]
use Refreshed as _RefreshedAlias;

#[derive(Clone)]
pub struct GatewayState {
    pub http: reqwest::Client,
    pub routes: Arc<Vec<RouteRule>>,
    pub mode: Arc<RuntimeMode>,
    /// JWT verification secret (same AUTH_SECRET the auth service signs with).
    pub secret: Arc<String>,
    pub cookie_secure: bool,
    pub inflight: InflightMap,
    /// Auth service base URL (transparent refresh).
    pub auth_url: String,
}

impl GatewayState {
    pub fn new(secret: String, mode: Arc<RuntimeMode>) -> Self {
        let timeout = std::env::var("GATEWAY_PROXY_TIMEOUT_SECONDS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(120);
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(timeout))
            .connect_timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .http1_only()
            .build()
            .expect("reqwest client");
        let cookie_secure = std::env::var("MF_COOKIE_SECURE")
            .map(|v| v != "0" && v != "false")
            .unwrap_or(true);
        Self {
            http,
            routes: Arc::new(crate::routing::build_routes()),
            mode,
            secret: Arc::new(secret),
            cookie_secure,
            inflight: crate::actor::new_inflight(),
            auth_url: std::env::var("AUTH_INTERNAL_URL")
                .unwrap_or_else(|_| "http://auth:8081".to_string()),
        }
    }
}
