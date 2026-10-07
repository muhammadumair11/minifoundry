//! Route modules + request helpers (same conventions as services/auth).

use mf_web::ApiError;
use serde_json::{Map, Value};

pub mod internal;
pub mod runs;
pub mod seed_demo;
pub mod transforms;

// ─── Body parsing (legacy `await req.json()` semantics) ─────────────────

/// Parse a required JSON body. Non-JSON → 400 'Request body must be valid JSON'.
pub fn parse_body(bytes: &[u8]) -> Result<Value, ApiError> {
    serde_json::from_slice(bytes)
        .map_err(|_| ApiError::bad_request("Request body must be valid JSON"))
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

/// Required non-empty string with a CUSTOM zod min message
/// (`z.string().min(1, '<msg>')` — the transforms create/patch schemas).
pub fn req_str_min1_msg<'a>(
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

/// Optional enum string (absent/null → None).
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

/// `z.string().nullish()` → outer Option = key present?, inner = null vs str.
pub fn opt_str_nullish(
    m: &Map<String, Value>,
    field: &str,
) -> Result<Option<Option<String>>, ApiError> {
    match m.get(field) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::String(s)) => Ok(Some(Some(s.clone()))),
        Some(other) => Err(ApiError::bad_request(format!(
            "{field}: Invalid input: expected string, received {}",
            kind_of(other)
        ))),
    }
}

/// `z.string().min(1, msg).optional()` — absent/null → None.
pub fn opt_str_min1_msg<'a>(
    m: &'a Map<String, Value>,
    field: &str,
    min_msg: &str,
) -> Result<Option<&'a str>, ApiError> {
    match m.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(_) => req_str_min1_msg(m, field, min_msg).map(Some),
    }
}

/// `z.array(z.string().min(1))` (optional variant: absent/null → None).
/// Inner min has NO custom message → default zod v4 "Too small" string.
pub fn opt_str_array(m: &Map<String, Value>, field: &str) -> Result<Option<Vec<String>>, ApiError> {
    match m.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(arr)) => {
            let mut out = Vec::with_capacity(arr.len());
            for (i, el) in arr.iter().enumerate() {
                match el {
                    Value::String(s) if !s.is_empty() => out.push(s.clone()),
                    Value::String(_) => {
                        return Err(ApiError::bad_request(format!(
                            "{field}.{i}: Too small: expected string to have >=1 chars"
                        )))
                    }
                    other => {
                        return Err(ApiError::bad_request(format!(
                            "{field}.{i}: Invalid input: expected string, received {}",
                            kind_of(other)
                        )))
                    }
                }
            }
            Ok(Some(out))
        }
        Some(other) => Err(ApiError::bad_request(format!(
            "{field}: Invalid input: expected array, received {}",
            kind_of(other)
        ))),
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

/// Percent-encode one URL path segment (dataset names contain spaces).
pub fn encode_segment(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for b in raw.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
