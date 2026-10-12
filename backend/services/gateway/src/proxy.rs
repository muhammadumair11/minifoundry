//! Reverse-proxy forwarding to domain services.
//!
//! Request path: original headers minus hop-by-hop / identity headers, plus
//! the gateway-resolved `X-Mf-*` actor headers. Response path: status +
//! headers (minus hop-by-hop; content-length recomputed) + body bytes, with
//! transparent-refresh cookies appended.

use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, Uri};
use axum::response::Response;

use crate::state::GatewayState;

/// Headers never forwarded in either direction (hop-by-hop + identity).
const STRIP_REQUEST_HEADERS: [&str; 8] = [
    "host",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "upgrade",
    "te",
    "trailer",
    "content-length",
];

const STRIP_RESPONSE_HEADERS: [&str; 4] = [
    "connection",
    "keep-alive",
    "transfer-encoding",
    "content-length",
];

/// Everything needed to forward one client request to a domain service.
pub struct ForwardRequest {
    pub base_url: String,
    pub method: Method,
    pub uri: Uri,
    pub headers: HeaderMap,
    pub body: Bytes,
    pub actor_headers: Vec<(HeaderName, HeaderValue)>,
    pub extra_set_cookies: Vec<String>,
}

pub async fn forward(state: &GatewayState, req: ForwardRequest) -> Response {
    let ForwardRequest {
        base_url,
        method,
        uri,
        headers,
        body,
        actor_headers,
        extra_set_cookies,
    } = req;
    let path_and_query = uri
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or(uri.path());
    let url = format!("{}{}", base_url.trim_end_matches('/'), path_and_query);

    // Build forwarded headers: keep client headers, strip hop-by-hop and any
    // client-supplied identity headers (they are re-derived below).
    let mut fwd = HeaderMap::new();
    for (name, value) in headers.iter() {
        let n = name.as_str();
        if STRIP_REQUEST_HEADERS.contains(&n) {
            continue;
        }
        if n.starts_with("x-mf-") || n == mf_auth::SERVICE_TOKEN_HEADER {
            continue; // clients can never inject identity
        }
        fwd.append(name.clone(), value.clone());
    }
    for (name, value) in actor_headers {
        fwd.append(name, value);
    }
    let result = state
        .http
        .request(method, &url)
        .headers(fwd)
        .body(body.to_vec())
        .send()
        .await;

    let upstream = match result {
        Ok(r) => r,
        Err(e) => {
            tracing::error!(url = %url, error = %e, "upstream request failed");
            let is_timeout = e.is_timeout();
            let is_connect = e.is_connect();
            let (status, msg) = if is_timeout {
                (
                    axum::http::StatusCode::GATEWAY_TIMEOUT,
                    "upstream service timed out",
                )
            } else if is_connect {
                (
                    axum::http::StatusCode::SERVICE_UNAVAILABLE,
                    "upstream service unavailable",
                )
            } else {
                (
                    axum::http::StatusCode::BAD_GATEWAY,
                    "upstream request failed",
                )
            };
            return error_response(status, msg, extra_set_cookies);
        }
    };

    let status = upstream.status();
    let resp_headers = upstream.headers().clone();
    let bytes = match upstream.bytes().await {
        Ok(b) => b,
        Err(e) => {
            tracing::error!(url = %url, error = %e, "upstream body read failed");
            return error_response(
                axum::http::StatusCode::BAD_GATEWAY,
                "upstream body read failed",
                extra_set_cookies,
            );
        }
    };

    let mut builder = Response::builder().status(status);
    {
        let h = builder.headers_mut().unwrap();
        for (name, value) in resp_headers.iter() {
            if STRIP_RESPONSE_HEADERS.contains(&name.as_str()) {
                continue;
            }
            h.append(name.clone(), value.clone());
        }
        h.insert(
            axum::http::header::CONTENT_LENGTH,
            HeaderValue::from(bytes.len()),
        );
        for cookie in &extra_set_cookies {
            if let Ok(v) = HeaderValue::from_str(cookie) {
                h.append(axum::http::header::SET_COOKIE, v);
            }
        }
    }
    builder.body(Body::from(bytes)).unwrap_or_else(|_| {
        error_response(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "response build failed",
            vec![],
        )
    })
}

fn error_response(
    status: axum::http::StatusCode,
    message: &str,
    extra_set_cookies: Vec<String>,
) -> Response {
    let body = serde_json::json!({ "error": message }).to_string();
    let mut builder = Response::builder().status(status);
    {
        let h = builder.headers_mut().unwrap();
        h.insert(
            axum::http::header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        for cookie in &extra_set_cookies {
            if let Ok(v) = HeaderValue::from_str(cookie) {
                h.append(axum::http::header::SET_COOKIE, v);
            }
        }
    }
    builder.body(Body::from(body)).unwrap()
}
