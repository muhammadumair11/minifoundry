//! REAL HTTP/CSV connector ingestion — port of src/lib/real-ingest.ts.
//!
//! Given a connector config { url, format: 'json'|'csv', dataPath? }, fetch
//! the payload over HTTP (SSRF-guarded, 10s timeout, 2MB cap, MiniFoundry UA)
//! and turn it into Row[] the dataset-service can version. Every failure mode
//! carries the exact legacy user-facing message.

use mf_types::{Row, Value};
use serde_json::Map;

pub struct RealIngestConfig {
    pub url: String,
    pub format: String, // "json" | "csv"
    pub data_path: Option<String>,
}

pub struct RealIngestResult {
    pub rows: Vec<Row>,
    pub format: String,
    pub row_count: usize,
    /// Column names of the first row (sample for the test-connection dialog).
    pub columns: Vec<String>,
}

const TIMEOUT_MS: u64 = 10_000;
const MAX_BYTES: usize = 2 * 1024 * 1024;
const MAX_ROWS: usize = 5000;

fn numeric_re() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$").unwrap())
}

fn leading_zero_re() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"^[-+]?0\d").unwrap())
}

/// Fetch + parse a connector payload into rows. Err carries the clean,
/// user-facing legacy message for every failure mode.
pub async fn fetch_connector_rows(config: &RealIngestConfig) -> Result<RealIngestResult, String> {
    let url = config.url.trim();
    if url.is_empty() {
        return Err("A URL is required".to_string());
    }
    // Egress guard runs FIRST so private targets fail before any network I/O.
    crate::egress::assert_public_http_url(url)?;
    let text = http_get_text(url).await?;
    let rows = if config.format == "csv" {
        csv_rows_with_types(crate::csvutil::parse_csv_rows(&text))
    } else {
        json_to_rows(&text, config.data_path.as_deref())?
    };
    if rows.is_empty() {
        return Err("no rows found".to_string());
    }
    if rows.len() > MAX_ROWS {
        return Err(format!(
            "Connector returned {} rows; the current storage limit is {MAX_ROWS}. No rows were written.",
            rows.len()
        ));
    }
    let columns = rows.first().map(|r| r.keys().cloned().collect()).unwrap_or_default();
    Ok(RealIngestResult {
        format: config.format.clone(),
        row_count: rows.len(),
        rows,
        columns,
    })
}

/// GET with SSRF egress controls, timeout + streamed 2MB cap; body as text.
async fn http_get_text(url: &str) -> Result<String, String> {
    let resp = crate::egress::egress_fetch(
        url,
        &[
            ("User-Agent", "MiniFoundry/1.0"),
            ("accept", "application/json, text/csv, text/plain, */*"),
        ],
        std::time::Duration::from_millis(TIMEOUT_MS),
    )
    .await
    .map_err(|e| format!("Fetch failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!(
            "Request failed with status {} {}",
            status.as_u16(),
            status.canonical_reason().unwrap_or("")
        ));
    }
    // Stream the body with a hard size cap (never buffer more than MAX_BYTES).
    let mut total = 0usize;
    let mut buf: Vec<u8> = Vec::new();
    let mut resp = resp;
    loop {
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                total += chunk.len();
                if total > MAX_BYTES {
                    return Err("Response exceeds the 2 MB size cap".to_string());
                }
                buf.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(e) => return Err(format!("Fetch failed: {e}")),
        }
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// JSON → rows. Root array of objects; object roots resolve the row array via
/// dataPath (dot path) or the first array-valued key (common keys first).
/// Each row is flattened ONE level (nested values → compact JSON strings).
pub fn json_to_rows(text: &str, data_path: Option<&str>) -> Result<Vec<Row>, String> {
    let parsed: Value = serde_json::from_str(text).map_err(|e| format!("Invalid JSON: {e}"))?;

    let arr: Vec<Value> = match &parsed {
        Value::Array(a) => a.clone(),
        Value::Object(obj) => {
            if let Some(path) = data_path {
                let mut cursor = Value::Object(obj.clone());
                for segment in path.split('.').map(str::trim).filter(|s| !s.is_empty()) {
                    match cursor.get(segment) {
                        Some(next) => cursor = next.clone(),
                        None => {
                            return Err(format!(
                                "dataPath '{path}' not found in the JSON payload"
                            ))
                        }
                    }
                }
                match cursor {
                    Value::Array(a) => a,
                    _ => {
                        return Err(format!(
                            "dataPath '{path}' does not point to an array"
                        ))
                    }
                }
            } else {
                match crate::parsers::find_array_value(obj) {
                    Some(a) => a,
                    None => {
                        return Err(
                            "JSON payload contains no array of objects".to_string()
                        )
                    }
                }
            }
        }
        _ => {
            return Err(match data_path {
                Some(p) => format!("dataPath '{p}' does not point to an array"),
                None => "JSON payload contains no array of objects".to_string(),
            })
        }
    };

    let rows: Vec<Row> = arr
        .into_iter()
        .filter_map(|v| match v {
            Value::Object(m) => Some(flatten_one_level(m)),
            _ => None,
        })
        .collect();
    if rows.is_empty() {
        return Err("no rows found".to_string());
    }
    Ok(rows)
}

/// One-level flatten: nested objects/arrays become compact JSON strings.
fn flatten_one_level(row: Map<String, Value>) -> Row {
    let mut out = Map::new();
    for (key, value) in row {
        let v = match &value {
            Value::Object(_) | Value::Array(_) => {
                Value::String(serde_json::to_string(&value).unwrap_or_default())
            }
            other => other.clone(),
        };
        out.insert(key, v);
    }
    out
}

/// CSV rows (all values strings) → typed rows: a column whose non-empty
/// values are ALL numeric becomes number, all true/false becomes boolean;
/// anything else stays string. Empty cells → null. Key order follows the
/// unified column list (extra/'' columns are dropped, like the legacy).
pub fn csv_rows_with_types(rows: Vec<Row>) -> Vec<Row> {
    if rows.is_empty() {
        return Vec::new();
    }
    // Unified column list in first-appearance order, minus '' and parse extras.
    let mut columns: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for r in &rows {
        for k in r.keys() {
            if !k.is_empty() && !k.starts_with("__parsed_extra") && seen.insert(k.clone()) {
                columns.push(k.clone());
            }
        }
    }
    let mut kinds: Vec<&str> = Vec::with_capacity(columns.len());
    for column in &columns {
        let mut saw_value = false;
        let mut numeric = true;
        let mut boolean = true;
        for row in &rows {
            let Some(raw) = row.get(column) else { continue };
            if raw.is_null() {
                continue;
            }
            let s = crate::jsval::js_stringify(raw);
            let s = s.trim();
            if s.is_empty() {
                continue;
            }
            saw_value = true;
            if numeric {
                let n = crate::jsval::js_parse_number(s);
                let ok = numeric_re().is_match(s)
                    && !leading_zero_re().is_match(s)
                    && n.is_finite()
                    && !(n.fract() == 0.0 && n.abs() > 9_007_199_254_740_991.0);
                if !ok {
                    numeric = false;
                }
            }
            if boolean {
                let lower = s.to_lowercase();
                if lower != "true" && lower != "false" {
                    boolean = false;
                }
            }
            if !numeric && !boolean {
                break;
            }
        }
        kinds.push(if !saw_value {
            "string"
        } else if numeric {
            "number"
        } else if boolean {
            "boolean"
        } else {
            "string"
        });
    }
    rows.iter()
        .map(|row| {
            let mut out = Map::new();
            for (column, kind) in columns.iter().zip(kinds.iter()) {
                let raw = row.get(column);
                let s = match raw {
                    None | Some(Value::Null) => String::new(),
                    Some(v) => crate::jsval::js_stringify(v).trim().to_string(),
                };
                let value = if s.is_empty() {
                    Value::Null
                } else {
                    match *kind {
                        "number" => {
                            let n = crate::jsval::js_parse_number(&s);
                            if n.is_nan() {
                                Value::String(s.clone())
                            } else {
                                crate::jsval::js_number_value(n)
                            }
                        }
                        "boolean" => Value::Bool(s.to_lowercase() == "true"),
                        _ => raw.cloned().unwrap_or(Value::Null),
                    }
                };
                out.insert(column.clone(), value);
            }
            out
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn json_to_rows_root_array_and_flatten() {
        let rows = json_to_rows(r#"[{"a":1,"n":{"x":2},"l":[1,2]}]"#, None).unwrap();
        assert_eq!(rows[0]["a"], json!(1));
        assert_eq!(rows[0]["n"], json!(r#"{"x":2}"#));
        assert_eq!(rows[0]["l"], json!("[1,2]"));
    }

    #[test]
    fn json_to_rows_data_path() {
        let text = r#"{"meta":{"count":2},"payload":{"items":[{"a":1},{"a":2}]}}"#;
        let rows = json_to_rows(text, Some("payload.items")).unwrap();
        assert_eq!(rows.len(), 2);
        let err = json_to_rows(text, Some("payload.missing")).unwrap_err();
        assert_eq!(err, "dataPath 'payload.missing' not found in the JSON payload");
        let err = json_to_rows(text, Some("meta")).unwrap_err();
        assert_eq!(err, "dataPath 'meta' does not point to an array");
    }

    #[test]
    fn json_to_rows_errors() {
        assert_eq!(
            json_to_rows("{oops", None).unwrap_err().split(':').next().unwrap(),
            "Invalid JSON"
        );
        assert_eq!(
            json_to_rows(r#"{"a":1}"#, None).unwrap_err(),
            "JSON payload contains no array of objects"
        );
        assert_eq!(json_to_rows("[]", None).unwrap_err(), "no rows found");
        assert_eq!(json_to_rows("[1,2]", None).unwrap_err(), "no rows found");
    }

    #[test]
    fn csv_typed_columns() {
        let raw = crate::csvutil::parse_csv_rows("id,name,score,flag,zip,mixed\n1,a,4.5,true,012,X\n2,b,6,FALSE,345,Y\n");
        let rows = csv_rows_with_types(raw);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["id"], json!(1)); // uniformly numeric → number
        assert_eq!(rows[0]["name"], json!("a")); // string
        assert_eq!(rows[0]["score"], json!(4.5));
        assert_eq!(rows[0]["flag"], json!(true)); // case-insensitive booleans
        assert_eq!(rows[1]["flag"], json!(false));
        assert_eq!(rows[0]["zip"], json!("012")); // leading zero → whole column stays string
        assert_eq!(rows[1]["zip"], json!("345")); // string kind keeps raw strings
        assert_eq!(rows[0]["mixed"], json!("X"));
    }

    #[test]
    fn csv_empty_cells_become_null() {
        let raw = crate::csvutil::parse_csv_rows("a,b\n1,\n");
        let rows = csv_rows_with_types(raw);
        assert_eq!(rows[0]["a"], json!(1));
        assert_eq!(rows[0]["b"], Value::Null);
    }

    #[test]
    fn csv_column_order_follows_first_appearance() {
        let raw = crate::csvutil::parse_csv_rows("b,a\n1,2\n");
        let rows = csv_rows_with_types(raw);
        let keys: Vec<&String> = rows[0].keys().collect();
        assert_eq!(keys, vec!["b", "a"]);
    }

    #[test]
    fn numeric_regex_matches_legacy() {
        assert!(numeric_re().is_match("42"));
        assert!(numeric_re().is_match("-3.14"));
        assert!(numeric_re().is_match(".5"));
        assert!(numeric_re().is_match("5."));
        assert!(numeric_re().is_match("1e5"));
        assert!(numeric_re().is_match("+7"));
        assert!(!numeric_re().is_match("abc"));
        assert!(!numeric_re().is_match("1.2.3"));
        assert!(leading_zero_re().is_match("012"));
        assert!(leading_zero_re().is_match("-012"));
        assert!(leading_zero_re().is_match("+012"));
        assert!(!leading_zero_re().is_match("0.5"));
    }
}
