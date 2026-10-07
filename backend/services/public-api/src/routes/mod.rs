//! v1 route modules + shared value helpers.

use serde_json::Value;

pub mod datasets;
pub mod objects;
pub mod ontology;
pub mod pipelines;
pub mod whoami;

/// Parse the legacy `?version=` param: absent/empty → None; anything that is
/// not an integer >= 1 → the exact legacy 400.
pub fn version_param(
    params: &std::collections::HashMap<String, String>,
) -> Result<Option<i64>, mf_web::ApiError> {
    match params.get("version") {
        None => Ok(None),
        Some(raw) if raw.is_empty() => Ok(None),
        Some(raw) => {
            let n = raw.trim().parse::<f64>().unwrap_or(f64::NAN);
            if !n.is_finite() || n.fract() != 0.0 || n < 1.0 {
                return Err(mf_web::ApiError::bad_request(format!(
                    "Invalid 'version' parameter: '{raw}'"
                )));
            }
            Ok(Some(n as i64))
        }
    }
}

/// `tags` tolerated as a JSON array (new catalog) or a JSON-stringified
/// array (legacy SQLite storage).
pub fn parse_tags(v: &Value) -> Value {
    match v {
        Value::Array(_) => v.clone(),
        Value::String(s) => serde_json::from_str(s).unwrap_or(Value::Array(vec![])),
        _ => Value::Array(vec![]),
    }
}

/// Slice a rows array for 1-based pagination (legacy `rows.slice(start, …)`).
pub fn paginate(rows: &[Value], page: i64, page_size: i64) -> Vec<Value> {
    let start = ((page - 1) * page_size).max(0) as usize;
    let end = start.saturating_add(page_size.max(0) as usize);
    rows.iter().take(end).skip(start).cloned().collect()
}

/// Sort items by a string timestamp field, desc (ISO strings sort
/// lexicographically; missing values sink to the end). Stable.
pub fn sort_by_ts_desc(items: &mut [Value], key: &str) {
    let mut keyed: Vec<(String, usize)> = items
        .iter()
        .enumerate()
        .map(|(i, v)| {
            (
                v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string(),
                i,
            )
        })
        .collect();
    keyed.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    let ordered: Vec<Value> = keyed.iter().map(|(_, i)| items[*i].clone()).collect();
    items.clone_from_slice(&ordered);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn version_param_legacy_messages() {
        let mut p = std::collections::HashMap::new();
        assert_eq!(version_param(&p).unwrap(), None);
        p.insert("version".into(), "".into());
        assert_eq!(version_param(&p).unwrap(), None);
        p.insert("version".into(), "3".into());
        assert_eq!(version_param(&p).unwrap(), Some(3));
        p.insert("version".into(), "abc".into());
        assert_eq!(
            version_param(&p).unwrap_err().message,
            "Invalid 'version' parameter: 'abc'"
        );
        p.insert("version".into(), "2.5".into());
        assert!(version_param(&p).is_err());
        p.insert("version".into(), "0".into());
        assert!(version_param(&p).is_err());
    }

    #[test]
    fn tags_tolerate_both_storages() {
        assert_eq!(parse_tags(&json!(["a"])), json!(["a"]));
        assert_eq!(parse_tags(&json!("[\"b\"]")), json!(["b"]));
        assert_eq!(parse_tags(&json!(null)), json!([]));
        assert_eq!(parse_tags(&json!("nope")), json!([]));
    }

    #[test]
    fn pagination_slices_like_js() {
        let rows: Vec<Value> = (0..7).map(|i| json!(i)).collect();
        assert_eq!(paginate(&rows, 1, 3), vec![json!(0), json!(1), json!(2)]);
        assert_eq!(paginate(&rows, 3, 3), vec![json!(6)]);
        assert_eq!(paginate(&rows, 4, 3), Vec::<Value>::new());
    }

    #[test]
    fn sorting_is_desc_and_stable() {
        let mut items = vec![
            json!({"id": 1, "updatedAt": "2026-01-01T00:00:00.000Z"}),
            json!({"id": 2, "updatedAt": "2026-03-01T00:00:00.000Z"}),
            json!({"id": 3}),
            json!({"id": 4, "updatedAt": "2026-02-01T00:00:00.000Z"}),
        ];
        sort_by_ts_desc(&mut items, "updatedAt");
        let ids: Vec<i64> = items.iter().map(|v| v["id"].as_i64().unwrap()).collect();
        assert_eq!(ids, vec![2, 4, 1, 3]);
    }
}
