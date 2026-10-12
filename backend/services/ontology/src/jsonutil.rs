//! Request-body parsing helpers — same conventions/messages as the auth
//! service (approximations of the legacy zod error strings via
//! `zodErrorMessage`: `<path>: <message>` joined with '; ').

use mf_web::ApiError;
use serde_json::{Map, Value};

/// Parse a required JSON body. Non-JSON → 400 'Request body must be valid JSON'.
pub fn parse_body(bytes: &[u8]) -> Result<Value, ApiError> {
    serde_json::from_slice(bytes)
        .map_err(|_| ApiError::bad_request("Request body must be valid JSON"))
}

/// Body must be a JSON object.
pub fn as_object(v: Value) -> Result<Map<String, Value>, ApiError> {
    match v {
        Value::Object(m) => Ok(m),
        _ => Err(ApiError::bad_request(
            "body: Invalid input: expected object",
        )),
    }
}

pub fn kind_of(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn expected(path: &str, kind: &str, got: &str) -> ApiError {
    ApiError::bad_request(format!(
        "{path}: Invalid input: expected {kind}, received {got}"
    ))
}

fn missing(path: &str, kind: &str) -> ApiError {
    ApiError::bad_request(format!(
        "{path}: Invalid input: expected {kind}, received undefined"
    ))
}

/// Required string field (`z.string()`), custom path for nested issues.
pub fn req_str_at<'a>(
    m: &'a Map<String, Value>,
    path: &str,
    field: &str,
) -> Result<&'a str, ApiError> {
    match m.get(field) {
        Some(Value::String(s)) => Ok(s),
        Some(other) => Err(expected(path, "string", kind_of(other))),
        None => Err(missing(path, "string")),
    }
}

#[allow(dead_code)]
pub fn req_str<'a>(m: &'a Map<String, Value>, field: &str) -> Result<&'a str, ApiError> {
    req_str_at(m, field, field)
}

/// Required non-empty string (`z.string().min(1)`), optional custom message.
pub fn req_str_min1_msg<'a>(
    m: &'a Map<String, Value>,
    path: &str,
    field: &str,
    msg: Option<&str>,
) -> Result<&'a str, ApiError> {
    let s = req_str_at(m, path, field)?;
    if s.is_empty() {
        return Err(ApiError::bad_request(match msg {
            Some(custom) => format!("{path}: {custom}"),
            None => format!("{path}: Too small: expected string to have >=1 chars"),
        }));
    }
    Ok(s)
}

#[allow(dead_code)]
pub fn req_str_min1<'a>(m: &'a Map<String, Value>, field: &str) -> Result<&'a str, ApiError> {
    req_str_min1_msg(m, field, field, None)
}

/// Optional string (absent | null → None).
pub fn opt_str<'a>(m: &'a Map<String, Value>, field: &str) -> Result<Option<&'a str>, ApiError> {
    match m.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s)),
        Some(other) => Err(expected(field, "string", kind_of(other))),
    }
}

/// `z.string().nullish()` — absent/null → Ok(None-but-present-as-null);
/// returns (present, value) so callers can distinguish "absent" from "null".
pub fn nullish_str<'a>(
    m: &'a Map<String, Value>,
    field: &str,
) -> Result<Option<Option<&'a str>>, ApiError> {
    match m.get(field) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::String(s)) => Ok(Some(Some(s))),
        Some(other) => Err(expected(field, "string", kind_of(other))),
    }
}

/// Required enum string (`z.enum([...])`).
#[allow(dead_code)]
pub fn req_enum<'a>(
    m: &'a Map<String, Value>,
    path: &str,
    field: &str,
    options: &[&str],
) -> Result<&'a str, ApiError> {
    let s = req_str_at(m, path, field)?;
    enum_or_err(s, path, options)
}

pub fn enum_or_err<'a>(s: &'a str, path: &str, options: &[&str]) -> Result<&'a str, ApiError> {
    if options.contains(&s) {
        Ok(s)
    } else {
        Err(ApiError::bad_request(format!(
            "{path}: Invalid option: expected one of {}",
            options
                .iter()
                .map(|o| format!("\"{o}\""))
                .collect::<Vec<_>>()
                .join("|")
        )))
    }
}

/// Optional enum string.
#[allow(dead_code)]
pub fn opt_enum<'a>(
    m: &'a Map<String, Value>,
    path: &str,
    field: &str,
    options: &[&str],
) -> Result<Option<&'a str>, ApiError> {
    match m.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(_) => req_enum(m, path, field, options).map(Some),
    }
}

/// Optional bool.
pub fn opt_bool(m: &Map<String, Value>, field: &str) -> Result<Option<bool>, ApiError> {
    match m.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(b)) => Ok(Some(*b)),
        Some(other) => Err(expected(field, "boolean", kind_of(other))),
    }
}

/// Optional integer (`z.number().int()`).
pub fn opt_int(m: &Map<String, Value>, field: &str) -> Result<Option<i64>, ApiError> {
    match m.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => n
            .as_i64()
            .map(Some)
            .ok_or_else(|| ApiError::bad_request(format!("{field}: Invalid input: expected int"))),
        Some(other) => Err(expected(field, "number", kind_of(other))),
    }
}

/// Max-length check for a present string (`z.string().max(n)`).
pub fn check_max_len(path: &str, s: &str, max: usize) -> Result<(), ApiError> {
    if s.chars().count() > max {
        return Err(ApiError::bad_request(format!(
            "{path}: Too big: expected string to have <={max} chars"
        )));
    }
    Ok(())
}

/// Regex-validated optional slug (`z.string().regex(SLUG_RE, msg)`).
pub fn check_regex(path: &str, s: &str, re: &regex::Regex, msg: &str) -> Result<(), ApiError> {
    if !re.is_match(s) {
        return Err(ApiError::bad_request(format!("{path}: {msg}")));
    }
    Ok(())
}

/// Query-string helper: first value for a key.
pub fn query_param(params: &axum::http::Uri, key: &str) -> Option<String> {
    let q = params.query()?;
    url::form_urlencoded::parse(q.as_bytes())
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn map(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn body_parse_error_messages() {
        let e = parse_body(b"nope").unwrap_err();
        assert_eq!(e.message, "Request body must be valid JSON");
        let e = as_object(json!(3)).unwrap_err();
        assert_eq!(e.message, "body: Invalid input: expected object");
    }

    #[test]
    fn field_validation_messages() {
        let m = map(json!({"n": 5, "s": ""}));
        assert_eq!(
            req_str(&m, "s2").unwrap_err().message,
            "s2: Invalid input: expected string, received undefined"
        );
        assert_eq!(
            req_str(&m, "n").unwrap_err().message,
            "n: Invalid input: expected string, received number"
        );
        assert_eq!(
            req_str_min1(&m, "s").unwrap_err().message,
            "s: Too small: expected string to have >=1 chars"
        );
        assert_eq!(
            req_enum(&m, "kind", "s", &["a", "b"]).unwrap_err().message,
            "kind: Invalid option: expected one of \"a\"|\"b\""
        );
    }

    #[test]
    fn query_param_extraction() {
        let uri: axum::http::Uri = "/api/objects?type=customer&q=a%20b&filters=%5B%5D"
            .parse()
            .unwrap();
        assert_eq!(query_param(&uri, "type").as_deref(), Some("customer"));
        assert_eq!(query_param(&uri, "q").as_deref(), Some("a b"));
        assert_eq!(query_param(&uri, "filters").as_deref(), Some("[]"));
        assert_eq!(query_param(&uri, "nope"), None);
    }
}
