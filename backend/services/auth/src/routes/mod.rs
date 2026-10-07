//! Route modules + request helpers shared by the auth service.

use axum::http::{header, HeaderMap, HeaderValue};
use axum::response::Response;
use mf_web::ApiError;
use serde_json::{Map, Value};

pub mod auth_routes;
pub mod internal;
pub mod session;
pub mod tokens;
pub mod users;

/// Read a cookie value from the request's `Cookie` header.
pub fn get_cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
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

/// Append Set-Cookie headers to a response.
pub fn with_cookies(mut resp: Response, cookies: Vec<crate::cookies::CookieSpec>) -> Response {
    for c in cookies {
        if let Ok(v) = HeaderValue::from_str(&c.to_header()) {
            resp.headers_mut().append(header::SET_COOKIE, v);
        }
    }
    resp
}

// ─── Body parsing (legacy `await req.json()` semantics) ─────────────────

/// Parse a required JSON body. Non-JSON → 400 'Request body must be valid JSON'.
pub fn parse_body(bytes: &[u8]) -> Result<Value, ApiError> {
    serde_json::from_slice(bytes)
        .map_err(|_| ApiError::bad_request("Request body must be valid JSON"))
}

/// Parse an OPTIONAL JSON body (empty/absent → `{}`), like the usage-seed and
/// pipeline-run legacy routes.
pub fn parse_body_or_empty(bytes: &[u8]) -> Result<Value, ApiError> {
    let text = std::str::from_utf8(bytes).unwrap_or("").trim();
    if text.is_empty() {
        return Ok(Value::Object(Map::new()));
    }
    parse_body(bytes)
}

/// Body must be a JSON object (zod `.object()` rejection is approximated).
pub fn as_object(v: Value) -> Result<Map<String, Value>, ApiError> {
    match v {
        Value::Object(m) => Ok(m),
        _ => Err(ApiError::bad_request(
            "body: Invalid input: expected object",
        )),
    }
}

/// Required string field (zod `z.string()`): missing/wrong-type message shape
/// `<field>: Invalid input: expected string, received <kind>`.
pub fn req_str<'a>(m: &'a Map<String, Value>, field: &str) -> Result<&'a str, ApiError> {
    match m.get(field) {
        Some(Value::String(s)) => Ok(s),
        Some(other) => Err(ApiError::bad_request(format!(
            "{field}: Invalid input: expected string, received {}",
            kind_of(other)
        ))),
        None => Err(ApiError::bad_request(format!(
            "{field}: Invalid input: expected string, received undefined"
        ))),
    }
}

/// Required non-empty string (zod `z.string().min(1)` — exact v4 wording).
pub fn req_str_min1<'a>(m: &'a Map<String, Value>, field: &str) -> Result<&'a str, ApiError> {
    let s = req_str(m, field)?;
    if s.is_empty() {
        return Err(ApiError::bad_request(format!(
            "{field}: Too small: expected string to have >=1 characters"
        )));
    }
    Ok(s)
}

/// Single-field issue text for multi-issue collection (zod joins ALL issues
/// with '; ' in schema field order — the legacy zodErrorMessage behavior).
pub fn str_min1_issue(m: &Map<String, Value>, field: &str) -> Result<(), String> {
    match m.get(field) {
        Some(Value::String(s)) if !s.is_empty() => Ok(()),
        Some(Value::String(_)) => Err(format!(
            "{field}: Too small: expected string to have >=1 characters"
        )),
        Some(other) => Err(format!(
            "{field}: Invalid input: expected string, received {}",
            kind_of(other)
        )),
        None => Err(format!(
            "{field}: Invalid input: expected string, received undefined"
        )),
    }
}

/// Required enum string (zod `z.enum([...])`).
pub fn req_enum<'a>(
    m: &'a Map<String, Value>,
    field: &str,
    options: &[&str],
) -> Result<&'a str, ApiError> {
    let s = req_str(m, field)?;
    if options.contains(&s) {
        Ok(s)
    } else {
        Err(ApiError::bad_request(format!(
            "{field}: Invalid option: expected one of {}",
            options
                .iter()
                .map(|o| format!("\"{o}\""))
                .collect::<Vec<_>>()
                .join("|")
        )))
    }
}

/// Optional enum string.
pub fn opt_enum<'a>(
    m: &'a Map<String, Value>,
    field: &str,
    options: &[&str],
) -> Result<Option<&'a str>, ApiError> {
    match m.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(_) => req_enum(m, field, options).map(Some),
    }
}

/// Optional bool.
pub fn opt_bool(m: &Map<String, Value>, field: &str) -> Result<Option<bool>, ApiError> {
    match m.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(b)) => Ok(Some(*b)),
        Some(other) => Err(ApiError::bad_request(format!(
            "{field}: Invalid input: expected boolean, received {}",
            kind_of(other)
        ))),
    }
}

/// Optional int (zod `z.number().int()`).
pub fn opt_int(m: &Map<String, Value>, field: &str) -> Result<Option<i64>, ApiError> {
    match m.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => n
            .as_i64()
            .map(Some)
            .ok_or_else(|| ApiError::bad_request(format!("{field}: Invalid input: expected int"))),
        Some(other) => Err(ApiError::bad_request(format!(
            "{field}: Invalid input: expected number, received {}",
            kind_of(other)
        ))),
    }
}

pub(crate) fn kind_of(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}
