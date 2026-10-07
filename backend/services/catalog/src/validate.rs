//! Request-body/query validation helpers reproducing the legacy zod schemas'
//! status codes and (best-effort) message shapes. Errors are always 400 with
//! the `{ error }` envelope; messages follow zod v4 formatting as established
//! by the auth service (`<field>: <issue>`, joined with "; ").

use mf_web::ApiError;
use serde_json::{Map, Value};

// ─── Body parsing (legacy `await req.json()` semantics) ─────────────────

/// Parse a required JSON body. Non-JSON → 400 'Request body must be valid JSON'.
pub fn parse_body(bytes: &[u8]) -> Result<Value, ApiError> {
    serde_json::from_slice(bytes)
        .map_err(|_| ApiError::bad_request("Request body must be valid JSON"))
}

/// Parse an OPTIONAL JSON body (empty/absent → `{}`), like the prune and
/// connector-ingest legacy routes (`req.text()` + conditional parse).
pub fn parse_body_or_empty(bytes: &[u8]) -> Result<Value, ApiError> {
    let text = std::str::from_utf8(bytes).unwrap_or("").trim();
    if text.is_empty() {
        return Ok(Value::Object(Map::new()));
    }
    parse_body(bytes)
}

/// Body must be a JSON object.
pub fn as_object(v: Value) -> Result<Map<String, Value>, ApiError> {
    match v {
        Value::Object(m) => Ok(m),
        other => Err(ApiError::bad_request(format!(
            "body: Invalid input: expected object, received {}",
            kind_of(&other)
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

// ─── Field accessors ─────────────────────────────────────────────────────

/// Required string (zod `z.string()`).
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

/// Required non-empty string with a CUSTOM zod min message (e.g.
/// `z.string().min(1, 'name is required')`).
pub fn req_str_min1_custom<'a>(
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

/// Optional string (`z.string().optional()`): absent/null → None.
pub fn opt_str<'a>(m: &'a Map<String, Value>, field: &str) -> Result<Option<&'a str>, ApiError> {
    match m.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s)),
        Some(other) => Err(ApiError::bad_request(format!(
            "{field}: Invalid input: expected string, received {}",
            kind_of(other)
        ))),
    }
}

/// Nullish string (`z.string().nullish()`): absent/null → Ok(None) with a
/// flag telling "explicit null" (callers store NULL) from "absent" (skip).
pub enum Nullish<'a> {
    Absent,
    Null,
    Value(&'a str),
}

pub fn opt_str_nullish<'a>(m: &'a Map<String, Value>, field: &str) -> Result<Nullish<'a>, ApiError> {
    match m.get(field) {
        None => Ok(Nullish::Absent),
        Some(Value::Null) => Ok(Nullish::Null),
        Some(Value::String(s)) => Ok(Nullish::Value(s)),
        Some(other) => Err(ApiError::bad_request(format!(
            "{field}: Invalid input: expected string, received {}",
            kind_of(other)
        ))),
    }
}

/// Trimmed string with min/max AFTER trim (`z.string().trim().min(1,m).max(n)`).
/// Returns the trimmed value; None when absent.
pub fn opt_str_trim_bounded<'a>(
    m: &'a Map<String, Value>,
    field: &str,
    min: usize,
    min_msg: Option<&str>,
    max: usize,
) -> Result<Option<&'a str>, ApiError> {
    match m.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.chars().count() < min {
                return Err(ApiError::bad_request(match min_msg {
                    Some(msg) => format!("{field}: {msg}"),
                    None => format!("{field}: Too small: expected string to have >={min} chars"),
                }));
            }
            if t.chars().count() > max {
                return Err(ApiError::bad_request(format!(
                    "{field}: Too big: expected string to have <={max} chars"
                )));
            }
            Ok(Some(t))
        }
        Some(other) => Err(ApiError::bad_request(format!(
            "{field}: Invalid input: expected string, received {}",
            kind_of(other)
        ))),
    }
}

/// Required enum (`z.enum([...])`).
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
            options.iter().map(|o| format!("\"{o}\"")).collect::<Vec<_>>().join("|")
        )))
    }
}

/// Optional enum.
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

/// Optional bool (`z.boolean().optional()` / `.default()`).
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

/// Optional int (`z.number().int().optional()`).
pub fn opt_int(m: &Map<String, Value>, field: &str) -> Result<Option<i64>, ApiError> {
    match m.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => n.as_i64().map(Some).ok_or_else(|| {
            ApiError::bad_request(format!("{field}: Invalid input: expected int"))
        }),
        Some(other) => Err(ApiError::bad_request(format!(
            "{field}: Invalid input: expected number, received {}",
            kind_of(other)
        ))),
    }
}

/// Bounded int (`z.number().int().min(lo).max(hi).optional()`).
pub fn opt_int_bounded(
    m: &Map<String, Value>,
    field: &str,
    lo: i64,
    hi: i64,
) -> Result<Option<i64>, ApiError> {
    let Some(v) = opt_int(m, field)? else { return Ok(None) };
    if v < lo {
        return Err(ApiError::bad_request(format!(
            "{field}: Too small: expected number to be >={lo}"
        )));
    }
    if v > hi {
        return Err(ApiError::bad_request(format!(
            "{field}: Too large: expected number to be <={hi}"
        )));
    }
    Ok(Some(v))
}

/// Required positive int (`z.number().int().positive()`).
pub fn req_int_positive(m: &Map<String, Value>, field: &str) -> Result<i64, ApiError> {
    match m.get(field) {
        Some(Value::Number(n)) => {
            let Some(v) = n.as_i64() else {
                return Err(ApiError::bad_request(format!(
                    "{field}: Invalid input: expected int"
                )));
            };
            if v <= 0 {
                return Err(ApiError::bad_request(format!(
                    "{field}: Too small: expected number to be >0"
                )));
            }
            Ok(v)
        }
        Some(other) => Err(ApiError::bad_request(format!(
            "{field}: Invalid input: expected number, received {}",
            kind_of(other)
        ))),
        None => Err(ApiError::bad_request(format!(
            "{field}: Invalid input: expected number, received undefined"
        ))),
    }
}

/// Positive int, nullable (`z.number().int().positive().optional().nullable()`).
pub fn opt_int_positive_null(
    m: &Map<String, Value>,
    field: &str,
) -> Result<Option<Option<i64>>, ApiError> {
    match m.get(field) {
        None => Ok(Some(None)), // absent → default null (comment route)
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::Number(n)) => {
            let Some(v) = n.as_i64() else {
                return Err(ApiError::bad_request(format!(
                    "{field}: Invalid input: expected int"
                )));
            };
            if v <= 0 {
                return Err(ApiError::bad_request(format!(
                    "{field}: Too small: expected number to be >0"
                )));
            }
            Ok(Some(Some(v)))
        }
        Some(other) => Err(ApiError::bad_request(format!(
            "{field}: Invalid input: expected number, received {}",
            kind_of(other)
        ))),
    }
}

/// Object field (`z.record(z.string(), z.unknown())`), with default when
/// absent/null.
pub fn opt_object(m: &Map<String, Value>, field: &str) -> Result<Option<Map<String, Value>>, ApiError> {
    match m.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Object(o)) => Ok(Some(o.clone())),
        Some(other) => Err(ApiError::bad_request(format!(
            "{field}: Invalid input: expected object, received {}",
            kind_of(other)
        ))),
    }
}

/// Array-of-objects field (`z.array(z.record(z.string(), z.unknown()))`).
pub fn req_rows_array(m: &Map<String, Value>, field: &str) -> Result<Vec<Map<String, Value>>, ApiError> {
    match m.get(field) {
        Some(Value::Array(arr)) => {
            let mut out = Vec::with_capacity(arr.len());
            for (i, item) in arr.iter().enumerate() {
                match item {
                    Value::Object(o) => out.push(o.clone()),
                    other => {
                        return Err(ApiError::bad_request(format!(
                            "{field}.{i}: Invalid input: expected object, received {}",
                            kind_of(other)
                        )))
                    }
                }
            }
            Ok(out)
        }
        Some(other) => Err(ApiError::bad_request(format!(
            "{field}: Invalid input: expected array, received {}",
            kind_of(other)
        ))),
        None => Err(ApiError::bad_request(format!(
            "{field}: Invalid input: expected array, received undefined"
        ))),
    }
}

/// Optional array-of-objects (internal version door `rows?`).
pub fn opt_rows_array(
    m: &Map<String, Value>,
    field: &str,
) -> Result<Option<Vec<Map<String, Value>>>, ApiError> {
    match m.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(_) => req_rows_array(m, field).map(Some),
    }
}

// ─── Query params (z.coerce.number() semantics) ─────────────────────────

/// `z.coerce.number().int().min(lo).max(hi).default(d)` for a query param.
/// Coercion uses JS `Number()` semantics; issues are collected zod-style.
pub fn coerce_int_param(
    raw: Option<&str>,
    field: &str,
    lo: i64,
    hi: i64,
    default: i64,
    issues: &mut Vec<String>,
) -> i64 {
    let Some(raw) = raw.filter(|s| !s.is_empty()) else {
        return default;
    };
    let n = crate::jsval::js_parse_number(raw);
    if n.is_nan() {
        issues.push(format!("{field}: Invalid input: expected number, received nan"));
        return default;
    }
    if n.fract() != 0.0 {
        issues.push(format!("{field}: Invalid input: expected int"));
        return default;
    }
    let v = n as i64;
    if v < lo {
        issues.push(format!("{field}: Too small: expected number to be >={lo}"));
        return default;
    }
    if v > hi {
        issues.push(format!("{field}: Too large: expected number to be <={hi}"));
        return default;
    }
    v
}

/// Join collected zod issues into the legacy 400 error, if any.
pub fn finish_query_issues(issues: Vec<String>) -> Result<(), ApiError> {
    if issues.is_empty() {
        Ok(())
    } else {
        Err(ApiError::bad_request(issues.join("; ")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn map(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn req_str_messages() {
        let m = map(json!({"a": "x"}));
        assert_eq!(req_str(&m, "a").unwrap(), "x");
        let e = req_str(&m, "b").unwrap_err();
        assert_eq!(e.message, "b: Invalid input: expected string, received undefined");
        let m = map(json!({"a": 5}));
        let e = req_str(&m, "a").unwrap_err();
        assert_eq!(e.message, "a: Invalid input: expected string, received number");
    }

    #[test]
    fn custom_min_messages() {
        let m = map(json!({"name": ""}));
        let e = req_str_min1_custom(&m, "name", "name is required").unwrap_err();
        assert_eq!(e.message, "name: name is required");
    }

    #[test]
    fn enum_messages() {
        let m = map(json!({"kind": "nope"}));
        let e = req_enum(&m, "kind", &["a", "b"]).unwrap_err();
        assert_eq!(e.message, "kind: Invalid option: expected one of \"a\"|\"b\"");
    }

    #[test]
    fn bounded_ints() {
        let m = map(json!({"keepLastN": -1}));
        let e = opt_int_bounded(&m, "keepLastN", 0, 1000).unwrap_err();
        assert_eq!(e.message, "keepLastN: Too small: expected number to be >=0");
        let m = map(json!({"keepLastN": 2000}));
        let e = opt_int_bounded(&m, "keepLastN", 0, 1000).unwrap_err();
        assert_eq!(e.message, "keepLastN: Too large: expected number to be <=1000");
        let m = map(json!({"keepLastN": 20}));
        assert_eq!(opt_int_bounded(&m, "keepLastN", 0, 1000).unwrap(), Some(20));
    }

    #[test]
    fn trim_bounded_strings() {
        let m = map(json!({"body": "  hi  "}));
        assert_eq!(
            opt_str_trim_bounded(&m, "body", 1, Some("comment is empty"), 2000).unwrap(),
            Some("hi")
        );
        let m = map(json!({"body": "   "}));
        let e = opt_str_trim_bounded(&m, "body", 1, Some("comment is empty"), 2000).unwrap_err();
        assert_eq!(e.message, "body: comment is empty");
    }

    #[test]
    fn rows_array_validation() {
        let m = map(json!({"rows": [{"a": 1}, "x"]}));
        let e = req_rows_array(&m, "rows").unwrap_err();
        assert_eq!(e.message, "rows.1: Invalid input: expected object, received string");
        let m = map(json!({"rows": [{"a": 1}]}));
        assert_eq!(req_rows_array(&m, "rows").unwrap().len(), 1);
        let m = map(json!({}));
        let e = req_rows_array(&m, "rows").unwrap_err();
        assert_eq!(e.message, "rows: Invalid input: expected array, received undefined");
    }

    #[test]
    fn query_coercion_matches_zod() {
        let mut issues = Vec::new();
        assert_eq!(coerce_int_param(None, "limit", 1, 200, 100, &mut issues), 100);
        assert_eq!(coerce_int_param(Some("50"), "limit", 1, 200, 100, &mut issues), 50);
        assert!(issues.is_empty());
        assert_eq!(coerce_int_param(Some("abc"), "limit", 1, 200, 100, &mut issues), 100);
        assert_eq!(issues, vec!["limit: Invalid input: expected number, received nan"]);
        issues.clear();
        assert_eq!(coerce_int_param(Some("0"), "limit", 1, 200, 100, &mut issues), 100);
        assert_eq!(issues, vec!["limit: Too small: expected number to be >=1"]);
        issues.clear();
        assert_eq!(coerce_int_param(Some("1.5"), "limit", 1, 200, 100, &mut issues), 100);
        assert_eq!(issues, vec!["limit: Invalid input: expected int"]);
    }
}
