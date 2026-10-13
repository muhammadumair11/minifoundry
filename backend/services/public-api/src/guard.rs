//! M10 auth + guard chain for the public /api/foundry/v1/* routes — exact
//! port of `withApiToken` in src/lib/api-v1.ts:
//!
//! (1) 401 `{ error: 'invalid or missing API token' }` when the Bearer token
//! is missing/unknown/revoked — NO usage log (no token identity), NO
//! rate-limit headers;
//!
//! (2) 429 `{ error: 'rate limit exceeded', retryAfterSeconds }` with
//! Retry-After and X-RateLimit-* headers when over the sliding window — the
//! token id IS known, so this request IS logged (M10.1);
//!
//! (3) otherwise the handler runs, its response gets the X-RateLimit-*
//! headers, and the request is logged with the response's status.
//!
//! Token verify + rate limiting live in the auth service (shared counters
//! across public-api replicas); usage rows are logged as mf.apiusage events
//! (fire-and-forget, consumed by auth).

use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use mf_web::ApiResult;
use serde_json::Value;
use std::future::Future;
use std::time::Instant;

use crate::fanout::FanOutError;
use crate::state::AppState;

/// Requests per minute per token (legacy TOKEN_RATE_LIMIT).
pub const TOKEN_RATE_LIMIT: i64 = 60;

/// Verified token identity (from auth's /internal/tokens/verify).
#[derive(Debug, Clone)]
pub struct TokenInfo {
    pub organization_id: String,
    pub id: String,
    pub name: String,
    pub prefix: String,
    /// Pre-touch request count (verify returns the count BEFORE the
    /// fire-and-forget increment, exactly like the legacy touchToken race).
    pub request_count: Value,
}

/// Sliding-window decision from auth's /internal/tokens/rate-limit.
#[derive(Debug, Clone)]
pub struct RateInfo {
    pub allowed: bool,
    pub remaining: i64,
    pub reset_ms: i64,
    pub retry_after_seconds: i64,
}

/// Port of `extractBearerToken` — case-insensitive scheme, `^Bearer\s+(.+)$`
/// over the TRIMMED header, captured secret trimmed.
pub fn extract_bearer_token(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(header::AUTHORIZATION)?.to_str().ok()?.trim();
    let (scheme, rest) = raw.split_at(raw.len().min("Bearer".len()));
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let rest = rest.strip_prefix(char::is_whitespace)?;
    let secret = rest.trim();
    if secret.is_empty() {
        None
    } else {
        Some(secret.to_string())
    }
}

/// Port of `templateRoute` — collapse the pathname into a stable route
/// template so usage aggregates group by SHAPE, not by id.
pub fn template_route(pathname: &str) -> String {
    const V1_PREFIX: &str = "/api/foundry/v1";
    const MAX_ROUTE_LENGTH: usize = 64;
    if pathname != V1_PREFIX && !pathname.starts_with(&format!("{V1_PREFIX}/")) {
        return if pathname.chars().count() > MAX_ROUTE_LENGTH {
            pathname.chars().take(MAX_ROUTE_LENGTH).collect()
        } else {
            pathname.to_string()
        };
    }
    let parts: Vec<&str> = pathname[V1_PREFIX.len()..]
        .split('/')
        .filter(|s| !s.is_empty())
        .collect();
    let mut out: Vec<&str> = Vec::with_capacity(parts.len());
    for i in 0..parts.len() {
        let prev = if i > 0 { Some(parts[i - 1]) } else { None };
        if prev == Some("datasets") || prev == Some("pipelines") {
            out.push(":id");
        } else if prev == Some("objects") {
            out.push(":type");
        } else if i >= 2 && parts[i - 2] == "objects" {
            out.push(":pk");
        } else {
            out.push(parts[i]);
        }
    }
    format!("/{}", out.join("/"))
}

/// Port of `v1PageFrom` — ?page= (1-based, default 1), ?pageSize= (default
/// 50, max 200), JS `Number(x) || fallback` + floor + clamp semantics.
pub fn v1_page_from(params: &std::collections::HashMap<String, String>) -> (i64, i64) {
    let num_or = |key: &str, fallback: f64| -> f64 {
        match params.get(key) {
            Some(raw) => {
                let n = js_number(raw);
                if n.is_nan() || n == 0.0 {
                    fallback
                } else {
                    n
                }
            }
            None => fallback,
        }
    };
    let page = num_or("page", 1.0).floor().max(1.0) as i64;
    let page_size = num_or("pageSize", 50.0).floor().clamp(1.0, 200.0) as i64;
    (page, page_size)
}

/// JS `Number(str)` for the query-param cases that matter ('' → 0 handled by
/// the || fallback; garbage → NaN).
fn js_number(raw: &str) -> f64 {
    let s = raw.trim();
    if s.is_empty() {
        return 0.0;
    }
    s.parse::<f64>().unwrap_or(f64::NAN)
}

/// Port of `v1Pagination` — 1-based block; totalPages 0 when empty.
pub fn v1_pagination(page: i64, page_size: i64, total: i64) -> Value {
    // JS Math.ceil(total / pageSize) without unstable int_roundings.
    let total_pages = if page_size > 0 && total > 0 {
        (total + page_size - 1) / page_size
    } else {
        0
    };
    serde_json::json!({
        "page": page,
        "pageSize": page_size,
        "total": total,
        "totalPages": total_pages,
    })
}

/// Guard-chain outcome handed to route handlers.
pub struct GuardCtx {
    pub token: TokenInfo,
    #[allow(dead_code)] // handlers may surface rate info; headers come from the guard
    pub rate: RateInfo,
}

/// Where the token-verify step left the chain.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum VerifyState {
    /// No Authorization bearer header at all.
    NoBearer,
    /// Auth answered 401 — unknown/revoked secret.
    Invalid,
    /// Auth unreachable (transport) — cannot decide identity.
    Upstream,
    Verified,
}

/// The guard's response decision.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum GuardDecision {
    Unauthorized,
    UpstreamUnavailable,
    RateLimited,
    Proceed,
}

/// PURE ordering core of `withApiToken` (unit-tested below):
/// - 401 STRICTLY precedes the rate-limit call (legacy: requireApiToken ran
///   before checkRateLimit — an invalid token never burns window budget);
/// - usage logging happens ONLY once a token identity exists: 401s are
///   never logged, 429s ARE (M10.1);
/// - an unavailable rate decision fails OPEN (legacy checkRateLimit was
///   in-memory and could not fail).
pub fn guard_plan(verify: VerifyState, rate_allowed: Option<bool>) -> (GuardDecision, bool) {
    match verify {
        VerifyState::NoBearer | VerifyState::Invalid => (GuardDecision::Unauthorized, false),
        VerifyState::Upstream => (GuardDecision::UpstreamUnavailable, false),
        VerifyState::Verified => match rate_allowed {
            Some(false) => (GuardDecision::RateLimited, true),
            _ => (GuardDecision::Proceed, true),
        },
    }
}

fn fallback_rate() -> RateInfo {
    RateInfo {
        allowed: true,
        remaining: 0,
        reset_ms: chrono::Utc::now().timestamp_millis() + 60_000,
        retry_after_seconds: 0,
    }
}

/// Port of `withApiToken`. `handler` errors become `{ error }` responses that
/// are still usage-logged with their own status and still carry rate headers.
pub async fn with_api_token<F, Fut>(
    state: &AppState,
    headers: &HeaderMap,
    path: &str,
    handler: F,
) -> Response
where
    F: FnOnce(GuardCtx) -> Fut,
    Fut: Future<Output = ApiResult<Response>>,
{
    let started_at = Instant::now();

    // 1) Bearer extraction + verify (401s are NEVER logged — no identity).
    let mut token: Option<TokenInfo> = None;
    let verify_state = match extract_bearer_token(headers) {
        None => VerifyState::NoBearer,
        Some(secret) => match verify_token(state, &secret).await {
            Ok(t) => {
                token = Some(t);
                VerifyState::Verified
            }
            Err(GuardFail::Unauthorized) => VerifyState::Invalid,
            Err(GuardFail::Upstream) => VerifyState::Upstream,
            // Non-401 callee contract errors pass through unlogged (closest
            // legacy analog: an unhandled throw BEFORE the logging wrapper).
            Err(GuardFail::Response(resp)) => return *resp,
        },
    };

    // 2) Sliding-window rate limit — only reached with a verified identity.
    let (rate, rate_allowed) = if verify_state == VerifyState::Verified {
        let token_id = &token.as_ref().expect("verified implies token").id;
        match rate_limit(state, token_id).await {
            Ok(r) => {
                let allowed = r.allowed;
                (r, Some(allowed))
            }
            Err(_) => {
                tracing::warn!("rate-limit call failed; failing open");
                (fallback_rate(), None)
            }
        }
    } else {
        (fallback_rate(), None)
    };

    // 3) Decision (pure, unit-tested) → response + usage logging.
    let (decision, log) = guard_plan(verify_state, rate_allowed);
    match decision {
        GuardDecision::Unauthorized => unauthorized(),
        GuardDecision::UpstreamUnavailable => crate::fanout::upstream_unavailable().into_response(),
        GuardDecision::RateLimited => {
            let t = token.expect("rate limited implies verified");
            if log {
                mf_events::with_organization(Some(t.organization_id.clone()), async {
                    log_usage(state, &t.id, path, 429, started_at);
                })
                .await;
            }
            rate_limit_exceeded(&rate)
        }
        GuardDecision::Proceed => {
            let t = token.expect("proceed implies verified");
            mf_events::with_organization(Some(t.organization_id.clone()), async {
                let ctx = GuardCtx {
                    token: t.clone(),
                    rate: rate.clone(),
                };
                let resp = match handler(ctx).await {
                    Ok(r) => r,
                    Err(e) => e.into_response(),
                };
                let status = resp.status().as_u16();
                if log {
                    log_usage(state, &t.id, path, status, started_at);
                }
                with_rate_limit_headers(resp, &rate)
            })
            .await
        }
    }
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        axum::Json(serde_json::json!({ "error": "invalid or missing API token" })),
    )
        .into_response()
}

/// 429 body + Retry-After + rate headers (port of `rateLimitExceeded`).
fn rate_limit_exceeded(rate: &RateInfo) -> Response {
    let mut resp = (
        StatusCode::TOO_MANY_REQUESTS,
        axum::Json(serde_json::json!({
            "error": "rate limit exceeded",
            "retryAfterSeconds": rate.retry_after_seconds,
        })),
    )
        .into_response();
    set_header(
        &mut resp,
        header::HeaderName::from_static("retry-after"),
        rate.retry_after_seconds.to_string(),
    );
    with_rate_limit_headers(resp, rate)
}

/// Attach X-RateLimit-Limit / -Remaining / -Reset (epoch ms).
pub fn with_rate_limit_headers(mut resp: Response, rate: &RateInfo) -> Response {
    set_header(
        &mut resp,
        header::HeaderName::from_static("x-ratelimit-limit"),
        TOKEN_RATE_LIMIT.to_string(),
    );
    set_header(
        &mut resp,
        header::HeaderName::from_static("x-ratelimit-remaining"),
        rate.remaining.to_string(),
    );
    set_header(
        &mut resp,
        header::HeaderName::from_static("x-ratelimit-reset"),
        rate.reset_ms.to_string(),
    );
    resp
}

fn set_header(resp: &mut Response, name: header::HeaderName, value: String) {
    if let Ok(v) = HeaderValue::from_str(&value) {
        resp.headers_mut().insert(name, v);
    }
}

enum GuardFail {
    Unauthorized,
    Upstream,
    Response(Box<Response>),
}

/// POST auth /internal/tokens/verify { secret } → TokenInfo.
async fn verify_token(state: &AppState, secret: &str) -> Result<TokenInfo, GuardFail> {
    let resp = state
        .auth
        .post(
            "/internal/tokens/verify",
            &serde_json::json!({ "secret": secret }),
        )
        .await;
    match resp {
        Ok(v) => {
            let t = v.get("token").unwrap_or(&v);
            let Some(id) = t.get("id").and_then(|x| x.as_str()) else {
                return Err(GuardFail::Unauthorized);
            };
            Ok(TokenInfo {
                organization_id: t
                    .get("organizationId")
                    .and_then(Value::as_str)
                    .filter(|id| mf_db::valid_organization_id(id))
                    .ok_or(GuardFail::Unauthorized)?
                    .to_string(),
                id: id.to_string(),
                name: t
                    .get("name")
                    .and_then(|x| x.as_str())
                    .unwrap_or_default()
                    .to_string(),
                prefix: t
                    .get("prefix")
                    .and_then(|x| x.as_str())
                    .unwrap_or_default()
                    .to_string(),
                request_count: t
                    .get("requestCount")
                    .cloned()
                    .unwrap_or(Value::Number(0.into())),
            })
        }
        Err(FanOutError::Api { status: 401, .. }) => Err(GuardFail::Unauthorized),
        Err(FanOutError::Api {
            status,
            message,
            detail,
        }) => {
            let code = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            let mut e = mf_web::ApiError::new(code, message);
            if let Some(d) = detail {
                e = e.with_detail(d);
            }
            Err(GuardFail::Response(Box::new(e.into_response())))
        }
        Err(e @ FanOutError::Transport(_)) => {
            tracing::warn!(error = %e, "auth unreachable for token verify");
            Err(GuardFail::Upstream)
        }
    }
}

/// POST auth /internal/tokens/rate-limit { tokenId } → RateInfo.
async fn rate_limit(state: &AppState, token_id: &str) -> Result<RateInfo, ()> {
    let v = state
        .auth
        .post(
            "/internal/tokens/rate-limit",
            &serde_json::json!({ "tokenId": token_id }),
        )
        .await
        .map_err(|_| ())?;
    Ok(RateInfo {
        allowed: v.get("allowed").and_then(|x| x.as_bool()).unwrap_or(true),
        remaining: v.get("remaining").and_then(|x| x.as_i64()).unwrap_or(0),
        reset_ms: v.get("resetMs").and_then(|x| x.as_i64()).unwrap_or(0),
        retry_after_seconds: v
            .get("retryAfterSeconds")
            .and_then(|x| x.as_i64())
            .unwrap_or(0),
    })
}

/// Fire-and-forget mf.apiusage emit (port of `logApiRequest`: templated
/// route, response status, duration from guard entry). Never delays or
/// breaks the response.
pub fn log_usage(state: &AppState, token_id: &str, path: &str, status: u16, started_at: Instant) {
    let duration_ms = started_at.elapsed().as_millis() as i64;
    let event = mf_events::ApiUsageEvent {
        token_id: token_id.to_string(),
        route: template_route(path),
        status,
        duration_ms,
    };
    let nats = state.nats.clone();
    let organization = mf_events::organization_id();
    tokio::spawn(async move {
        mf_events::with_organization(
            organization,
            mf_events::publish_json_quiet(&nats, mf_events::subject::API_USAGE, &event),
        )
        .await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers_with(entries: Vec<(&str, &str)>) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in entries {
            h.insert(
                header::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                HeaderValue::from_str(v).unwrap(),
            );
        }
        h
    }

    #[test]
    fn bearer_extraction_matches_legacy_regex() {
        // exact + case-insensitive scheme + extra whitespace
        let h = headers_with(vec![("authorization", "Bearer mf_live_abc123")]);
        assert_eq!(extract_bearer_token(&h).as_deref(), Some("mf_live_abc123"));
        let h = headers_with(vec![("authorization", "bearer   mf_live_x ")]);
        assert_eq!(extract_bearer_token(&h).as_deref(), Some("mf_live_x"));
        let h = headers_with(vec![("authorization", "BEARER\tmf_live_y")]);
        assert_eq!(extract_bearer_token(&h).as_deref(), Some("mf_live_y"));
        // no header / wrong scheme / empty secret
        assert_eq!(extract_bearer_token(&headers_with(vec![])), None);
        let h = headers_with(vec![("authorization", "Basic abc")]);
        assert_eq!(extract_bearer_token(&h), None);
        let h = headers_with(vec![("authorization", "Bearer")]);
        assert_eq!(extract_bearer_token(&h), None);
        let h = headers_with(vec![("authorization", "Bearer    ")]);
        assert_eq!(extract_bearer_token(&h), None);
    }

    #[test]
    fn template_route_matches_legacy() {
        assert_eq!(template_route("/api/foundry/v1/whoami"), "/whoami");
        assert_eq!(template_route("/api/foundry/v1/datasets"), "/datasets");
        assert_eq!(
            template_route("/api/foundry/v1/datasets/cmu123/rows"),
            "/datasets/:id/rows"
        );
        assert_eq!(
            template_route("/api/foundry/v1/datasets/cmu123/export"),
            "/datasets/:id/export"
        );
        assert_eq!(
            template_route("/api/foundry/v1/objects/supplier"),
            "/objects/:type"
        );
        assert_eq!(
            template_route("/api/foundry/v1/objects/supplier/SUP-001"),
            "/objects/:type/:pk"
        );
        assert_eq!(
            template_route("/api/foundry/v1/pipelines/p1"),
            "/pipelines/:id"
        );
        assert_eq!(template_route("/api/foundry/v1/ontology"), "/ontology");
        // non-v1 paths pass through (+ 64-char truncation)
        assert_eq!(template_route("/api/other"), "/api/other");
        let long = format!("/x/{}", "y".repeat(80));
        assert_eq!(template_route(&long).chars().count(), 64);
    }

    #[test]
    fn page_parsing_js_semantics() {
        let mut p = std::collections::HashMap::new();
        assert_eq!(v1_page_from(&p), (1, 50));
        p.insert("page".into(), "3".into());
        p.insert("pageSize".into(), "2.9".into());
        assert_eq!(v1_page_from(&p), (3, 2));
        p.insert("page".into(), "0".into());
        p.insert("pageSize".into(), "abc".into());
        assert_eq!(v1_page_from(&p), (1, 50));
        p.insert("page".into(), "-4".into());
        p.insert("pageSize".into(), "9999".into());
        assert_eq!(v1_page_from(&p), (1, 200));
    }

    #[test]
    fn pagination_block() {
        assert_eq!(
            v1_pagination(1, 50, 6),
            serde_json::json!({"page":1,"pageSize":50,"total":6,"totalPages":1})
        );
        assert_eq!(
            v1_pagination(2, 2, 5),
            serde_json::json!({"page":2,"pageSize":2,"total":5,"totalPages":3})
        );
        assert_eq!(
            v1_pagination(1, 50, 0),
            serde_json::json!({"page":1,"pageSize":50,"total":0,"totalPages":0})
        );
    }

    #[test]
    fn guard_chain_401_precedes_rate_limit() {
        // No bearer → 401, NOT logged, rate limit never consulted.
        assert_eq!(
            guard_plan(VerifyState::NoBearer, None),
            (GuardDecision::Unauthorized, false)
        );
        // Even a hypothetically-blocked window cannot override the 401 order.
        assert_eq!(
            guard_plan(VerifyState::NoBearer, Some(false)),
            (GuardDecision::Unauthorized, false)
        );
        // Invalid/revoked secret → 401, NOT logged (no token identity).
        assert_eq!(
            guard_plan(VerifyState::Invalid, Some(true)),
            (GuardDecision::Unauthorized, false)
        );
        // Auth transport failure → clean 502, NOT logged.
        assert_eq!(
            guard_plan(VerifyState::Upstream, None),
            (GuardDecision::UpstreamUnavailable, false)
        );
    }

    #[test]
    fn guard_chain_usage_logging_rules() {
        // Over the window → 429 IS logged (M10.1).
        assert_eq!(
            guard_plan(VerifyState::Verified, Some(false)),
            (GuardDecision::RateLimited, true)
        );
        // Allowed → proceeds and logs the handler's status.
        assert_eq!(
            guard_plan(VerifyState::Verified, Some(true)),
            (GuardDecision::Proceed, true)
        );
        // Rate decision unavailable → fails OPEN, still logged.
        assert_eq!(
            guard_plan(VerifyState::Verified, None),
            (GuardDecision::Proceed, true)
        );
    }
}
