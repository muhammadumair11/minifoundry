//! Route modules + request helpers (same zod-mirroring conventions as the
//! auth service reference implementation).

use mf_web::ApiError;
use serde_json::{Map, Value};

pub mod acl;
pub mod approvals;
pub mod audit;
pub mod curriculum;
pub mod internal;
pub mod markings;
pub mod notifications;
pub mod search;
pub mod seed_demo;
pub mod settings;
pub mod stats;

// ─── Body parsing (legacy `await req.json()` semantics) ─────────────────

/// Parse a required JSON body. Non-JSON → 400 'Request body must be valid JSON'.
pub fn parse_body(bytes: &[u8]) -> Result<Value, ApiError> {
    serde_json::from_slice(bytes)
        .map_err(|_| ApiError::bad_request("Request body must be valid JSON"))
}

/// Legacy `await req.json().catch(() => null)` — invalid/empty bodies become
/// JSON null so the zod object check reports `received null`.
pub fn parse_body_or_null(bytes: &[u8]) -> Value {
    serde_json::from_slice(bytes).unwrap_or(Value::Null)
}

/// Body must be a JSON object; the message reports the received kind exactly
/// like zod (`body: Invalid input: expected object, received null`).
pub fn as_object(v: Value) -> Result<Map<String, Value>, ApiError> {
    match v {
        Value::Object(m) => Ok(m),
        other => Err(ApiError::bad_request(format!(
            "body: Invalid input: expected object, received {}",
            kind_of(&other)
        ))),
    }
}

/// Required string field (zod `z.string()`).
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

/// Required non-empty string (zod `z.string().min(1)`), custom message.
pub fn req_str_min1<'a>(
    m: &'a Map<String, Value>,
    field: &str,
    min_msg: &str,
) -> Result<&'a str, ApiError> {
    let s = req_str(m, field)?;
    if s.is_empty() {
        return Err(ApiError::bad_request(format!("{field}: {min_msg}")));
    }
    Ok(s)
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

/// Optional string (zod `z.string().optional()`): absent/null → None.
pub fn opt_str<'a>(m: &'a Map<String, Value>, field: &str) -> Result<Option<&'a str>, ApiError> {
    match m.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(_) => req_str(m, field).map(Some),
    }
}

/// Optional enum string with a default (zod `z.enum([...]).default(d)`).
pub fn opt_enum_default<'a>(
    m: &'a Map<String, Value>,
    field: &str,
    options: &[&str],
    default: &'a str,
) -> Result<&'a str, ApiError> {
    match m.get(field) {
        None | Some(Value::Null) => Ok(default),
        Some(_) => req_enum(m, field, options),
    }
}

/// Required bool (zod `z.boolean()`).
pub fn req_bool(m: &Map<String, Value>, field: &str) -> Result<bool, ApiError> {
    match m.get(field) {
        Some(Value::Bool(b)) => Ok(*b),
        Some(other) => Err(ApiError::bad_request(format!(
            "{field}: Invalid input: expected boolean, received {}",
            kind_of(other)
        ))),
        None => Err(ApiError::bad_request(format!(
            "{field}: Invalid input: expected boolean, received undefined"
        ))),
    }
}

/// Required string array, non-empty, elements trimmed + non-empty
/// (zod `z.array(z.string().trim().min(1, msg)).min(1, empty_msg)`).
pub fn req_str_array(
    m: &Map<String, Value>,
    field: &str,
    empty_msg: &str,
    elem_msg: &str,
) -> Result<Vec<String>, ApiError> {
    let v = match m.get(field) {
        Some(v) => v,
        None => {
            return Err(ApiError::bad_request(format!(
                "{field}: Invalid input: expected array, received undefined"
            )))
        }
    };
    let arr = v.as_array().ok_or_else(|| {
        ApiError::bad_request(format!(
            "{field}: Invalid input: expected array, received {}",
            kind_of(v)
        ))
    })?;
    if arr.is_empty() {
        return Err(ApiError::bad_request(format!("{field}: {empty_msg}")));
    }
    let mut out = Vec::with_capacity(arr.len());
    for (i, item) in arr.iter().enumerate() {
        match item {
            Value::String(s) => {
                let t = s.trim();
                if t.is_empty() {
                    return Err(ApiError::bad_request(format!("{field}.{i}: {elem_msg}")));
                }
                out.push(t.to_string());
            }
            other => {
                return Err(ApiError::bad_request(format!(
                    "{field}.{i}: Invalid input: expected string, received {}",
                    kind_of(other)
                )))
            }
        }
    }
    Ok(out)
}

/// Practical zod `.email()` approximation (one @, non-empty trimmed parts).
pub fn is_email(s: &str) -> bool {
    let s = s.trim();
    let Some((local, domain)) = s.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && !domain.is_empty()
        && !local.contains('@')
        && !domain.contains('@')
        && !s.contains(char::is_whitespace)
        && domain.contains('.')
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

// ─── Query-param number parsing (JS `Number()` semantics) ───────────────

/// Port of the audit route's `boundedNumber`: `Number(raw ?? '')` (absent →
/// 0!), non-finite → fallback, else floor + clamp. NOTE the legacy quirk:
/// an ABSENT param parses as '' → 0 → clamps to `min` (the fallback only
/// applies to non-numeric garbage like 'abc').
pub fn bounded_number(raw: Option<&str>, fallback: i64, min: i64, max: i64) -> i64 {
    let n = js_number(raw.unwrap_or(""));
    if !n.is_finite() {
        return fallback;
    }
    let floored = n.floor() as i64;
    floored.clamp(min, max)
}

/// JS `Number(str)`: '' → 0, trimmed numeric (incl. exponent/inf/nan rules).
pub fn js_number(raw: &str) -> f64 {
    let s = raw.trim();
    if s.is_empty() {
        return 0.0;
    }
    match s {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    // JS accepts hex (0x...) — Rust parse does not; cover the common decimal
    // forms and treat anything else as NaN (legacy fallback path).
    if let Some(hex) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        if let Ok(n) = i64::from_str_radix(hex, 16) {
            return n as f64;
        }
        return f64::NAN;
    }
    s.parse::<f64>().unwrap_or(f64::NAN)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obj(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn bounded_number_reproduces_legacy_quirk() {
        // absent param → Number('') = 0 → clamped to min (NOT the fallback!)
        assert_eq!(bounded_number(None, 100, 1, 200), 1);
        assert_eq!(bounded_number(None, 0, 0, 10_000), 0);
        // explicit values clamp + floor
        assert_eq!(bounded_number(Some("50"), 100, 1, 200), 50);
        assert_eq!(bounded_number(Some("0"), 100, 1, 200), 1);
        assert_eq!(bounded_number(Some("999"), 100, 1, 200), 200);
        assert_eq!(bounded_number(Some("7.9"), 100, 1, 200), 7);
        // non-numeric → fallback
        assert_eq!(bounded_number(Some("abc"), 100, 1, 200), 100);
        assert_eq!(bounded_number(Some("Infinity"), 100, 1, 200), 100);
    }

    #[test]
    fn zod_style_messages() {
        let m = obj(serde_json::json!({}));
        assert_eq!(
            req_str(&m, "name").unwrap_err().message,
            "name: Invalid input: expected string, received undefined"
        );
        let m = obj(serde_json::json!({"name": ""}));
        assert_eq!(
            req_str_min1(&m, "name", "name is required")
                .unwrap_err()
                .message,
            "name: name is required"
        );
        let m = obj(serde_json::json!({"kind": "nope"}));
        assert_eq!(
            req_enum(&m, "kind", &["publish_dataset", "publish_pipeline"])
                .unwrap_err()
                .message,
            "kind: Invalid option: expected one of \"publish_dataset\"|\"publish_pipeline\""
        );
        assert_eq!(
            as_object(Value::Null).unwrap_err().message,
            "body: Invalid input: expected object, received null"
        );
    }

    #[test]
    fn str_array_validation() {
        let m = obj(serde_json::json!({"columns": []}));
        assert_eq!(
            req_str_array(&m, "columns", "columns must not be empty", "column names must be non-empty")
                .unwrap_err()
                .message,
            "columns: columns must not be empty"
        );
        let m = obj(serde_json::json!({"columns": ["a", "  ", "b"]}));
        assert_eq!(
            req_str_array(&m, "columns", "columns must not be empty", "column names must be non-empty")
                .unwrap_err()
                .message,
            "columns.1: column names must be non-empty"
        );
        let m = obj(serde_json::json!({"columns": [" a ", "b"]}));
        assert_eq!(
            req_str_array(&m, "columns", "columns must not be empty", "column names must be non-empty")
                .unwrap(),
            vec!["a".to_string(), "b".to_string()]
        );
    }

    #[test]
    fn email_approximation() {
        assert!(is_email("a@b.co"));
        assert!(is_email("demo-admin@example.invalid"));
        assert!(!is_email("nope"));
        assert!(!is_email("a@b"));
        assert!(!is_email("a b@c.de"));
        assert!(!is_email("@b.de"));
    }
}
