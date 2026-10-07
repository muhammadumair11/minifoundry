//! Route modules + request/validation helpers.
//!
//! Validation mirrors the legacy zod schemas issue-by-issue: messages are
//! collected in declaration order and joined with "; " exactly like
//! `zodErrorMessage()` (zod v4 phrasing, same as the auth service).

use axum::http::HeaderMap;
use mf_web::ApiError;
use serde_json::{Map, Value};

pub mod health;
pub mod internal;
pub mod jobs;
pub mod pipelines;
pub mod runs;
pub mod schedules;

// ─── Body parsing (legacy `await req.json()` semantics) ─────────────────

/// Parse a required JSON body. Non-JSON → 400 'Request body must be valid JSON'.
pub fn parse_body(bytes: &[u8]) -> Result<Value, ApiError> {
    serde_json::from_slice(bytes)
        .map_err(|_| ApiError::bad_request("Request body must be valid JSON"))
}

/// Parse an OPTIONAL JSON body (empty/absent → `{}`), like the pipeline-run
/// legacy route (`req.text()` then JSON.parse when non-blank).
pub fn parse_body_or_empty(bytes: &[u8]) -> Result<Value, ApiError> {
    let text = std::str::from_utf8(bytes).unwrap_or("").trim();
    if text.is_empty() {
        return Ok(Value::Object(Map::new()));
    }
    parse_body(bytes)
}

/// Body must be a JSON object (zod `.object()` rejection).
pub fn as_object(v: Value) -> Result<Map<String, Value>, ApiError> {
    match v {
        Value::Object(m) => Ok(m),
        _ => Err(ApiError::bad_request(format!(
            "body: Invalid input: expected object, received {}",
            kind_of(&v)
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

// ─── zod-style field validators (Err carries the issue string) ──────────

/// `z.string().optional()` — missing ok, null/other → issue.
pub fn opt_string(m: &Map<String, Value>, field: &str) -> Result<Option<String>, String> {
    match m.get(field) {
        None => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(other) => Err(issue(field, &format!("Invalid input: expected string, received {}", kind_of(other)))),
    }
}

/// `z.string().min(1, '<msg>').optional()` — custom empty message.
pub fn opt_string_min1_custom(
    m: &Map<String, Value>,
    field: &str,
    empty_msg: &str,
) -> Result<Option<String>, String> {
    match opt_string(m, field)? {
        Some(s) if s.is_empty() => Err(issue(field, empty_msg)),
        other => Ok(other),
    }
}

/// `z.string().min(1).optional()` — default zod v4 too-small message.
pub fn opt_string_min1(m: &Map<String, Value>, field: &str) -> Result<Option<String>, String> {
    opt_string_min1_custom(m, field, "Too small: expected string to have >=1 chars")
}

/// `z.string().min(1)` (required).
pub fn req_string_min1_custom(
    m: &Map<String, Value>,
    field: &str,
    empty_msg: &str,
) -> Result<String, String> {
    match m.get(field) {
        None => Err(issue(field, "Invalid input: expected string, received undefined")),
        Some(Value::String(s)) if s.is_empty() => Err(issue(field, empty_msg)),
        Some(Value::String(s)) => Ok(s.clone()),
        Some(other) => Err(issue(field, &format!("Invalid input: expected string, received {}", kind_of(other)))),
    }
}

/// `z.string().nullish()` — missing/null → None; other non-string → issue.
pub fn nullish_string(m: &Map<String, Value>, field: &str) -> Result<Option<String>, String> {
    match m.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(other) => Err(issue(field, &format!("Invalid input: expected string, received {}", kind_of(other)))),
    }
}

/// `z.boolean().optional()`
pub fn opt_bool(m: &Map<String, Value>, field: &str) -> Result<Option<bool>, String> {
    match m.get(field) {
        None => Ok(None),
        Some(Value::Bool(b)) => Ok(Some(*b)),
        Some(other) => Err(issue(field, &format!("Invalid input: expected boolean, received {}", kind_of(other)))),
    }
}

/// `z.number().int(<int_msg>).min(<min>, <min_msg>).max(<max>, <max_msg>).optional()`
pub struct IntRange {
    pub min: i64,
    pub max: i64,
    pub int_msg: &'static str,
    pub min_msg: &'static str,
    pub max_msg: &'static str,
}

pub fn opt_int_range(
    m: &Map<String, Value>,
    field: &str,
    range: &IntRange,
) -> Result<Option<i64>, String> {
    let v = match m.get(field) {
        None => return Ok(None),
        Some(v) => v,
    };
    let n = match v {
        Value::Number(num) => match num.as_i64() {
            Some(i) => i as f64,
            None => num.as_f64().unwrap_or(f64::NAN),
        },
        other => {
            return Err(issue(
                field,
                &format!("Invalid input: expected number, received {}", kind_of(other)),
            ))
        }
    };
    if n.is_nan() {
        return Err(issue(field, "Invalid input: expected number, received nan"));
    }
    if !n.is_finite() || n != n.trunc() {
        return Err(issue(field, range.int_msg));
    }
    let i = n as i64;
    if i < range.min {
        return Err(issue(field, range.min_msg));
    }
    if i > range.max {
        return Err(issue(field, range.max_msg));
    }
    Ok(Some(i))
}

/// `z.number().int().min(1)` (required, restore route).
pub fn req_int_min1(m: &Map<String, Value>, field: &str) -> Result<i64, String> {
    match m.get(field) {
        None => Err(issue(field, "Invalid input: expected number, received undefined")),
        Some(v) => {
            let m2 = {
                let mut x = Map::new();
                x.insert(field.to_string(), v.clone());
                x
            };
            opt_int_range(
                &m2,
                field,
                &IntRange {
                    min: 1,
                    max: i64::MAX,
                    int_msg: "Invalid input: expected int",
                    min_msg: "Too small: expected number to be >=1",
                    max_msg: "Too big: expected number to be <=9223372036854775807",
                },
            )?
            .ok_or_else(|| issue(field, "Invalid input: expected number, received undefined"))
        }
    }
}

/// `z.enum([...]).optional()`
pub fn opt_enum<'a>(m: &'a Map<String, Value>, field: &str, options: &[&str]) -> Result<Option<&'a str>, String> {
    match m.get(field) {
        None => Ok(None),
        Some(Value::String(s)) => {
            if options.contains(&s.as_str()) {
                Ok(Some(s.as_str()))
            } else {
                Err(issue(
                    field,
                    &format!(
                        "Invalid option: expected one of {}",
                        options.iter().map(|o| format!("\"{o}\"")).collect::<Vec<_>>().join("|")
                    ),
                ))
            }
        }
        Some(other) => Err(issue(field, &format!("Invalid input: expected string, received {}", kind_of(other)))),
    }
}

/// `z.array(z.string()).max(<max>).optional()`
pub fn opt_string_array(m: &Map<String, Value>, field: &str, max: usize) -> Result<Option<Vec<String>>, String> {
    match m.get(field) {
        None => Ok(None),
        Some(Value::Array(arr)) => {
            let mut issues = Vec::new();
            let mut out = Vec::with_capacity(arr.len());
            for (i, item) in arr.iter().enumerate() {
                match item {
                    Value::String(s) => out.push(s.clone()),
                    other => issues.push(issue(
                        &format!("{field}.{i}"),
                        &format!("Invalid input: expected string, received {}", kind_of(other)),
                    )),
                }
            }
            if arr.len() > max {
                issues.push(issue(field, &format!("Too big: expected array to have <={max} items")));
            }
            if issues.is_empty() {
                Ok(Some(out))
            } else {
                Err(issues.join("; "))
            }
        }
        Some(other) => Err(issue(field, &format!("Invalid input: expected array, received {}", kind_of(other)))),
    }
}

/// The legacy `graphSchema` (z.object({ nodes: z.array(z.record(...)), edges:
/// z.array(z.record(...)) })).optional() — returns the raw graph value to
/// store (input key order preserved).
pub fn opt_graph(m: &Map<String, Value>, field: &str) -> Result<Option<Value>, String> {
    let Some(v) = m.get(field) else { return Ok(None) };
    if !v.is_object() {
        return Err(issue(field, &format!("Invalid input: expected object, received {}", kind_of(v))));
    }
    let mut issues = Vec::new();
    for sub in ["nodes", "edges"] {
        match v.get(sub) {
            None => issues.push(issue(
                &format!("{field}.{sub}"),
                "Invalid input: expected array, received undefined",
            )),
            Some(Value::Array(items)) => {
                for (i, item) in items.iter().enumerate() {
                    if !item.is_object() {
                        issues.push(issue(
                            &format!("{field}.{sub}.{i}"),
                            &format!("Invalid input: expected object, received {}", kind_of(item)),
                        ));
                    }
                }
            }
            Some(other) => issues.push(issue(
                &format!("{field}.{sub}"),
                &format!("Invalid input: expected array, received {}", kind_of(other)),
            )),
        }
    }
    if issues.is_empty() {
        Ok(Some(v.clone()))
    } else {
        Err(issues.join("; "))
    }
}

/// `z.coerce.number().int().min(a).max(b).default(d)` for query params.
pub fn coerce_query_int(
    params: &std::collections::HashMap<String, String>,
    field: &str,
    min: i64,
    max: i64,
    default: i64,
) -> Result<i64, String> {
    let Some(raw) = params.get(field) else { return Ok(default) };
    // JS Number(raw): "" → 0, whitespace trimmed, decimal/hex/exponent ok.
    let n = if raw.trim().is_empty() {
        0.0
    } else {
        crate::values::to_number(&Value::String(raw.clone()))
    };
    if n.is_nan() {
        return Err(issue(field, "Invalid input: expected number, received nan"));
    }
    if !n.is_finite() || n != n.trunc() {
        return Err(issue(field, "Invalid input: expected int, received float"));
    }
    let i = n as i64;
    if i < min {
        return Err(issue(field, &format!("Too small: expected number to be >={min}")));
    }
    if i > max {
        return Err(issue(field, &format!("Too big: expected number to be <={max}")));
    }
    Ok(i)
}

/// `z.enum([...]).optional()` for query params.
pub fn query_enum<'a>(
    params: &'a std::collections::HashMap<String, String>,
    field: &str,
    options: &[&str],
) -> Result<Option<&'a str>, String> {
    let Some(raw) = params.get(field) else { return Ok(None) };
    if options.contains(&raw.as_str()) {
        Ok(Some(raw.as_str()))
    } else {
        Err(issue(
            field,
            &format!(
                "Invalid option: expected one of {}",
                options.iter().map(|o| format!("\"{o}\"")).collect::<Vec<_>>().join("|")
            ),
        ))
    }
}

/// `z.string().min(1).optional()` for query params.
pub fn query_string_min1(
    params: &std::collections::HashMap<String, String>,
    field: &str,
) -> Result<Option<String>, String> {
    match params.get(field) {
        None => Ok(None),
        Some(s) if s.is_empty() => Err(issue(field, "Too small: expected string to have >=1 chars")),
        Some(s) => Ok(Some(s.clone())),
    }
}

fn issue(field: &str, message: &str) -> String {
    format!("{field}: {message}")
}

/// True when the caller presented a valid service token directly (legacy
/// `isServiceAuthorized(req)` for callers that bypass the gateway).
pub fn service_token_authorized(state: &crate::state::AppState, headers: &HeaderMap) -> bool {
    let provided = headers
        .get(mf_auth::SERVICE_TOKEN_HEADER)
        .and_then(|v| v.to_str().ok());
    state.mode.is_service_authorized(provided)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn map(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn graph_validation_messages() {
        let m = map(json!({"graph": "nope"}));
        assert_eq!(
            opt_graph(&m, "graph").unwrap_err(),
            "graph: Invalid input: expected object, received string"
        );
        let m = map(json!({"graph": {"edges": []}}));
        assert_eq!(
            opt_graph(&m, "graph").unwrap_err(),
            "graph.nodes: Invalid input: expected array, received undefined"
        );
        let m = map(json!({"graph": {"nodes": [{"id":"a"}, 5], "edges": 3}}));
        assert_eq!(
            opt_graph(&m, "graph").unwrap_err(),
            "graph.nodes.1: Invalid input: expected object, received number; graph.edges: Invalid input: expected array, received number"
        );
        let ok = map(json!({"graph": {"nodes": [], "edges": []}}));
        assert!(opt_graph(&ok, "graph").unwrap().is_some());
        assert!(opt_graph(&map(json!({})), "graph").unwrap().is_none());
    }

    #[test]
    fn interval_minutes_custom_messages() {
        let range = IntRange {
            min: 5,
            max: 10080,
            int_msg: "intervalMinutes must be an integer",
            min_msg: "intervalMinutes must be at least 5",
            max_msg: "intervalMinutes must be at most 10080 (7 days)",
        };
        let m = map(json!({"intervalMinutes": 3}));
        assert_eq!(
            opt_int_range(&m, "intervalMinutes", &range).unwrap_err(),
            "intervalMinutes: intervalMinutes must be at least 5"
        );
        let m = map(json!({"intervalMinutes": 5.5}));
        assert_eq!(
            opt_int_range(&m, "intervalMinutes", &range).unwrap_err(),
            "intervalMinutes: intervalMinutes must be an integer"
        );
        let m = map(json!({"intervalMinutes": 10081}));
        assert_eq!(
            opt_int_range(&m, "intervalMinutes", &range).unwrap_err(),
            "intervalMinutes: intervalMinutes must be at most 10080 (7 days)"
        );
        let m = map(json!({"intervalMinutes": 60}));
        assert_eq!(opt_int_range(&m, "intervalMinutes", &range).unwrap(), Some(60));
        assert_eq!(opt_int_range(&map(json!({})), "intervalMinutes", &range).unwrap(), None);
    }

    #[test]
    fn enum_and_array_issues() {
        let m = map(json!({"triggerMode": "auto"}));
        assert_eq!(
            opt_enum(&m, "triggerMode", &["manual", "upstream"]).unwrap_err(),
            "triggerMode: Invalid option: expected one of \"manual\"|\"upstream\""
        );
        let m = map(json!({"ids": ["a", 3]}));
        assert_eq!(
            opt_string_array(&m, "ids", 50).unwrap_err(),
            "ids.1: Invalid input: expected string, received number"
        );
        let m = map(json!({"ids": ["a", "b", "c"]}));
        assert_eq!(
            opt_string_array(&m, "ids", 2).unwrap_err(),
            "ids: Too big: expected array to have <=2 items"
        );
    }

    #[test]
    fn query_coercion() {
        let mut p = std::collections::HashMap::new();
        p.insert("limit".to_string(), "50".to_string());
        assert_eq!(coerce_query_int(&p, "limit", 1, 200, 100).unwrap(), 50);
        p.insert("limit".to_string(), "abc".to_string());
        assert_eq!(
            coerce_query_int(&p, "limit", 1, 200, 100).unwrap_err(),
            "limit: Invalid input: expected number, received nan"
        );
        p.insert("limit".to_string(), "0".to_string());
        assert_eq!(
            coerce_query_int(&p, "limit", 1, 200, 100).unwrap_err(),
            "limit: Too small: expected number to be >=1"
        );
        p.insert("limit".to_string(), "1.5".to_string());
        assert_eq!(
            coerce_query_int(&p, "limit", 1, 200, 100).unwrap_err(),
            "limit: Invalid input: expected int, received float"
        );
        p.remove("limit");
        assert_eq!(coerce_query_int(&p, "limit", 1, 200, 100).unwrap(), 100);
    }
}
