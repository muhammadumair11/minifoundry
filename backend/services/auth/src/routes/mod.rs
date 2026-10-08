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

// ─── Auth-flow validation (signup / password change) ────────────────────
//
// Collects ALL issues (schema field order, '; '-joined) like zod — the same
// convention the login route uses. Messages follow zod v4 defaults.

/// Minimum password length for self-service registration/changes.
pub const MIN_PASSWORD_LEN: usize = 8;

/// Pragmatic email shape check (learning scale — no RFC 5322 parser):
/// one @, non-empty local/domain parts, at least one dot in the domain.
pub fn email_is_valid(email: &str) -> bool {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r"^[^\s@]+@[^\s@]+\.[^\s@]+$").unwrap());
    re.is_match(email)
}

fn collect_str<'a>(
    m: &'a Map<String, Value>,
    field: &str,
    issues: &mut Vec<String>,
) -> Option<&'a str> {
    match m.get(field) {
        Some(Value::String(s)) => Some(s.as_str()),
        Some(other) => {
            issues.push(format!(
                "{field}: Invalid input: expected string, received {}",
                kind_of(other)
            ));
            None
        }
        None => {
            issues.push(format!(
                "{field}: Invalid input: expected string, received undefined"
            ));
            None
        }
    }
}

fn push_min_len(field: &str, value: &str, min: usize, issues: &mut Vec<String>) -> bool {
    if value.chars().count() < min {
        issues.push(format!(
            "{field}: Too small: expected string to have >={min} characters"
        ));
        false
    } else {
        true
    }
}

/// Validate the signup body. Returns (name_trimmed, email_normalized, password)
/// or a 400 with every issue joined ("; ").
pub fn validate_signup(m: &Map<String, Value>) -> Result<(String, String, String), ApiError> {
    let mut issues: Vec<String> = Vec::new();

    let name = collect_str(m, "name", &mut issues).map(|s| s.trim().to_string());
    if let Some(n) = &name {
        push_min_len("name", n, 1, &mut issues);
    }

    let email = collect_str(m, "email", &mut issues).map(|s| s.trim().to_lowercase());
    if let Some(e) = &email {
        if push_min_len("email", e, 1, &mut issues) && !email_is_valid(e) {
            issues.push("email: Invalid email address".to_string());
        }
    }

    let password = collect_str(m, "password", &mut issues).map(|s| s.to_string());
    if let Some(p) = &password {
        push_min_len("password", p, MIN_PASSWORD_LEN, &mut issues);
    }

    if !issues.is_empty() {
        return Err(ApiError::bad_request(issues.join("; ")));
    }
    Ok((name.unwrap(), email.unwrap(), password.unwrap()))
}

/// Validate the password-change body: currentPassword (min 1) + newPassword
/// (min 8). Same all-issues-joined convention.
pub fn validate_password_change(m: &Map<String, Value>) -> Result<(String, String), ApiError> {
    let mut issues: Vec<String> = Vec::new();

    let current = collect_str(m, "currentPassword", &mut issues).map(|s| s.to_string());
    if let Some(c) = &current {
        push_min_len("currentPassword", c, 1, &mut issues);
    }
    let new = collect_str(m, "newPassword", &mut issues).map(|s| s.to_string());
    if let Some(n) = &new {
        push_min_len("newPassword", n, MIN_PASSWORD_LEN, &mut issues);
    }

    if !issues.is_empty() {
        return Err(ApiError::bad_request(issues.join("; ")));
    }
    Ok((current.unwrap(), new.unwrap()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn map(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn email_shape() {
        assert!(email_is_valid("a@b.co"));
        assert!(email_is_valid("ada+tag@minifoundry.dev"));
        assert!(!email_is_valid("nope"));
        assert!(!email_is_valid("a@b"));
        assert!(!email_is_valid("a b@c.de"));
        assert!(!email_is_valid("@b.de"));
    }

    #[test]
    fn signup_validation_collects_all_issues() {
        let err = validate_signup(&map(json!({}))).unwrap_err();
        assert_eq!(
            err.message,
            "name: Invalid input: expected string, received undefined; \
             email: Invalid input: expected string, received undefined; \
             password: Invalid input: expected string, received undefined"
        );
        let err = validate_signup(&map(json!({"name": "", "email": "x", "password": "short"})))
            .unwrap_err();
        assert_eq!(
            err.message,
            "name: Too small: expected string to have >=1 characters; \
             email: Invalid email address; \
             password: Too small: expected string to have >=8 characters"
        );
        let ok = validate_signup(&map(
            json!({"name": "  Ada  ", "email": " ADA@X.Dev ", "password": "longenough"}),
        ))
        .unwrap();
        assert_eq!(ok, ("Ada".into(), "ada@x.dev".into(), "longenough".into()));
    }

    #[test]
    fn password_change_validation() {
        let err = validate_password_change(&map(json!({"currentPassword": "x"}))).unwrap_err();
        assert_eq!(
            err.message,
            "newPassword: Invalid input: expected string, received undefined"
        );
        let err =
            validate_password_change(&map(json!({"currentPassword": "", "newPassword": "abc"})))
                .unwrap_err();
        assert_eq!(
            err.message,
            "currentPassword: Too small: expected string to have >=1 characters; \
             newPassword: Too small: expected string to have >=8 characters"
        );
        let ok = validate_password_change(&map(
            json!({"currentPassword": "old", "newPassword": "newlongpass"}),
        ))
        .unwrap();
        assert_eq!(ok, ("old".into(), "newlongpass".into()));
    }
}
