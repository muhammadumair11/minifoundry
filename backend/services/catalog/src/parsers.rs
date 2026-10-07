//! Raw payload parsers for ingestion (port of src/lib/parsers.ts):
//! JSON / CSV text parsing + URL fetch.

use mf_types::{Row, Value};
use serde_json::Map;

#[derive(Debug)]
pub struct ParsedSource {
    pub rows: Vec<Row>,
    pub format: &'static str, // "json" | "csv"
}

/// Parse a JSON payload into rows: top-level array of objects, an object with
/// such an array under data/rows/items/records/results, or the first
/// array-of-objects property found. None when not parseable as JSON.
pub fn parse_json_rows(text: &str) -> Option<Vec<Row>> {
    let parsed: Value = serde_json::from_str(text).ok()?;
    let arr = match &parsed {
        Value::Array(a) => Some(a.clone()),
        Value::Object(obj) => find_array_value(obj),
        _ => None,
    }?;
    let rows: Vec<Row> = arr
        .into_iter()
        .filter_map(|v| match v {
            Value::Object(m) => Some(m),
            _ => None,
        })
        .collect();
    if rows.is_empty() {
        None
    } else {
        Some(rows)
    }
}

/// data/rows/items/records/results first, then the first array-valued key
/// (insertion order — serde_json preserve_order).
pub(crate) fn find_array_value(obj: &Map<String, Value>) -> Option<Vec<Value>> {
    for key in ["data", "rows", "items", "records", "results"] {
        if let Some(Value::Array(a)) = obj.get(key) {
            return Some(a.clone());
        }
    }
    for value in obj.values() {
        if let Value::Array(a) = value {
            return Some(a.clone());
        }
    }
    None
}

/// Parse raw text: try JSON first, fall back to CSV. Err when neither yields
/// rows (exact legacy message).
pub fn parse_raw_text(text: &str) -> Result<ParsedSource, String> {
    if let Some(rows) = parse_json_rows(text) {
        return Ok(ParsedSource { rows, format: "json" });
    }
    let rows = crate::csvutil::parse_csv_rows(text);
    if rows.is_empty() {
        return Err("No parseable rows found — payload is neither valid JSON nor CSV".to_string());
    }
    Ok(ParsedSource { rows, format: "csv" })
}

/// Fetch a URL and parse the response as JSON or CSV (sniffed from
/// headers/content). Port of `fetchRowsFromUrl` — plain fetch semantics
/// (redirects followed by the client, 15s timeout), NO SSRF guard (the legacy
/// /api/ingest url path had none; the rest_url connector path uses egress.rs).
pub async fn fetch_rows_from_url(url: &str) -> Result<ParsedSource, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("URL fetch failed: {e}"))?;
    let resp = client
        .get(url)
        .header("accept", "application/json, text/csv, text/plain, */*")
        .send()
        .await
        .map_err(|e| format!("URL fetch failed: {}", e.without_url()))?;
    let status = resp.status();
    if !status.is_success() {
        let reason = status.canonical_reason().unwrap_or("");
        return Err(format!(
            "URL fetch failed with status {} {}",
            status.as_u16(),
            reason
        ));
    }
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    let text = resp.text().await.map_err(|e| format!("URL fetch failed: {e}"))?;
    let looks_json = content_type.contains("json") || {
        let t = text.trim_start();
        t.starts_with('[') || t.starts_with('{')
    };
    if looks_json {
        return match parse_json_rows(&text) {
            Some(rows) => Ok(ParsedSource { rows, format: "json" }),
            None => Err("URL returned JSON but no array of objects could be found".to_string()),
        };
    }
    let rows = crate::csvutil::parse_csv_rows(&text);
    if rows.is_empty() {
        return Err("URL response contained no parseable CSV rows".to_string());
    }
    Ok(ParsedSource { rows, format: "csv" })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn json_rows_top_level_array() {
        let rows = parse_json_rows(r#"[{"a":1},{"b":2}]"#).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["a"], json!(1));
    }

    #[test]
    fn json_rows_common_keys_win() {
        let rows = parse_json_rows(r#"{"other":[{"z":0}],"data":[{"a":1}]}"#).unwrap();
        assert_eq!(rows[0]["a"], json!(1));
        let rows = parse_json_rows(r#"{"other":[{"z":0}]}"#).unwrap();
        assert_eq!(rows[0]["z"], json!(0));
    }

    #[test]
    fn json_rows_filters_non_objects() {
        assert!(parse_json_rows("[1,2]").is_none());
        let rows = parse_json_rows(r#"[{"a":1},5,null]"#).unwrap();
        assert_eq!(rows.len(), 1);
        assert!(parse_json_rows("nope").is_none());
        assert!(parse_json_rows("42").is_none());
    }

    #[test]
    fn raw_text_json_then_csv() {
        let p = parse_raw_text(r#"[{"a":1}]"#).unwrap();
        assert_eq!(p.format, "json");
        let p = parse_raw_text("a,b\n1,2\n").unwrap();
        assert_eq!(p.format, "csv");
        assert_eq!(p.rows[0]["b"], json!("2"));
        let err = parse_raw_text("   ").unwrap_err();
        assert_eq!(err, "No parseable rows found — payload is neither valid JSON nor CSV");
    }
}
