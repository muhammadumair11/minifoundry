//! GET /api/search?q= — global platform search (any role), ported from the
//! legacy route. Entity sections owned by sibling services come from their
//! /internal/search?q= endpoints (catalog: datasets+connectors,
//! orchestration: pipelines, compute: transforms, ontology: object
//! types/instances/dashboards/applications). Each fan-out is TOLERANT: an
//! unreachable service's section is omitted (warn-logged) while the merged
//! `{ results: [...] }` shape is preserved.
//!
//! Legacy merge semantics reproduced: fixed section order (datasets →
//! pipelines → transforms → objectTypes → object instances → dashboards →
//! applications → connectors), per-section caps (10 metadata / 5 object hits
//! per type), 20 results total.

use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::response::Response;
use mf_web::{actor_from_headers, json_ok, ApiResult};
use serde_json::Value;
use std::collections::HashMap;

use crate::fanout::percent_encode;
use crate::state::AppState;

const MAX_RESULTS: usize = 20;
const MAX_PER_SECTION: usize = 10;
const MAX_OBJECT_HITS_PER_TYPE: usize = 5;

/// Legacy section order (also the only accepted `type` values).
const SECTION_ORDER: [&str; 8] = [
    "dataset",
    "pipeline",
    "transform",
    "objectType",
    "object",
    "dashboard",
    "application",
    "connector",
];

/// Normalize one service's raw search response into SearchResultItem values.
/// Malformed items (missing type/id/title, unknown type) are dropped.
pub fn normalize_items(raw: &Value) -> Vec<Value> {
    let items = crate::fanout::items_array(raw, "results");
    let mut out = Vec::new();
    for it in items {
        let Some(ty) = it.get("type").and_then(|v| v.as_str()) else {
            continue;
        };
        if !SECTION_ORDER.contains(&ty) {
            continue;
        }
        let Some(id) = it
            .get("id")
            .map(|v| match v {
                Value::String(s) => s.clone(),
                Value::Number(n) => n.to_string(),
                _ => String::new(),
            })
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        let Some(title) = it.get("title").and_then(|v| v.as_str()) else {
            continue;
        };
        let subtitle = it
            .get("subtitle")
            .cloned()
            .filter(|v| v.is_string() || v.is_null())
            .unwrap_or(Value::Null);
        let href = it
            .get("href")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        out.push(serde_json::json!({
            "type": ty,
            "id": id,
            "title": title,
            "subtitle": subtitle,
            "href": href,
        }));
    }
    out
}

/// Pure merge: section order + caps + total limit (unit-testable without
/// any HTTP).
pub fn merge_results(sections: HashMap<&'static str, Vec<Value>>) -> Vec<Value> {
    let mut results: Vec<Value> = Vec::new();
    for ty in SECTION_ORDER {
        let Some(items) = sections.get(ty) else {
            continue;
        };
        if ty == "object" {
            // legacy: one hit per unique title per object type, 5 per type —
            // the type name travels in `subtitle` on the merged wire.
            let mut per_type: HashMap<String, usize> = HashMap::new();
            let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
            for it in items {
                let subtitle = it
                    .get("subtitle")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let title = it.get("title").and_then(|v| v.as_str()).unwrap_or("");
                let key = format!("{subtitle}|{title}");
                if !seen.insert(key) {
                    continue;
                }
                let used = per_type.entry(subtitle).or_insert(0);
                if *used >= MAX_OBJECT_HITS_PER_TYPE {
                    continue;
                }
                *used += 1;
                results.push(it.clone());
            }
        } else {
            results.extend(items.iter().take(MAX_PER_SECTION).cloned());
        }
    }
    results.truncate(MAX_RESULTS);
    results
}

pub async fn search(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    let q = params.get("q").cloned().unwrap_or_default();
    let q = q.trim();
    if q.is_empty() {
        return Ok(json_ok(serde_json::json!({ "results": [] })));
    }
    let actor = actor_from_headers(&headers);
    let path = format!("/internal/search?q={}", percent_encode(q));

    // Object-instance matches are masking-sensitive → the caller's actor
    // travels along (ontology masks with the forwarded role, legacy getRole).
    let (catalog, orchestration, compute, ontology) = futures::join!(
        state.clients.catalog.get_as(&path, &actor),
        state.clients.orchestration.get_as(&path, &actor),
        state.clients.compute.get_as(&path, &actor),
        state.clients.ontology.get_as(&path, &actor),
    );

    let mut sections: HashMap<&'static str, Vec<Value>> = HashMap::new();
    for (r, service) in [
        (catalog, "catalog"),
        (orchestration, "orchestration"),
        (compute, "compute"),
        (ontology, "ontology"),
    ] {
        match r {
            Ok(v) => {
                for item in normalize_items(&v) {
                    let ty = item["type"].as_str().unwrap_or_default();
                    if let Some(pos) = SECTION_ORDER.iter().position(|t| *t == ty) {
                        sections
                            .entry(SECTION_ORDER[pos])
                            .or_default()
                            .push(item);
                    }
                }
            }
            Err(e) => {
                tracing::warn!(service, error = %e, "search fan-out failed; section omitted");
            }
        }
    }

    Ok(json_ok(serde_json::json!({
        "results": merge_results(sections),
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(ty: &str, id: &str, title: &str, subtitle: Value, href: &str) -> Value {
        serde_json::json!({
            "type": ty, "id": id, "title": title, "subtitle": subtitle, "href": href,
        })
    }

    #[test]
    fn merge_preserves_legacy_section_order() {
        let mut sections = HashMap::new();
        sections.insert(
            "connector",
            vec![item("connector", "c1", "C", Value::Null, "/connectors")],
        );
        sections.insert(
            "dataset",
            vec![item("dataset", "d1", "D", Value::Null, "/datasets/d1")],
        );
        sections.insert(
            "objectType",
            vec![item("objectType", "o1", "O", Value::Null, "/objects/o")],
        );
        let merged = merge_results(sections);
        let types: Vec<&str> = merged.iter().map(|v| v["type"].as_str().unwrap()).collect();
        assert_eq!(types, vec!["dataset", "objectType", "connector"]);
    }

    #[test]
    fn merge_caps_sections_and_total() {
        let mut sections = HashMap::new();
        let many = |ty: &'static str| {
            (0..15)
                .map(|i| item(ty, &format!("{ty}{i}"), "t", Value::Null, "/x"))
                .collect::<Vec<_>>()
        };
        sections.insert("dataset", many("dataset"));
        sections.insert("pipeline", many("pipeline"));
        let merged = merge_results(sections);
        assert_eq!(merged.len(), MAX_RESULTS);
        // datasets fill their cap (10) first, then pipelines up to the total
        assert_eq!(
            merged.iter().filter(|v| v["type"] == "dataset").count(),
            10
        );
        assert_eq!(
            merged.iter().filter(|v| v["type"] == "pipeline").count(),
            10
        );
    }

    #[test]
    fn object_hits_capped_per_type_and_deduped() {
        let mut items = Vec::new();
        for i in 0..7 {
            items.push(item(
                "object",
                &format!("t:{i}"),
                &format!("Title {i}"),
                Value::String("Customer".into()),
                "/objects/customer",
            ));
        }
        // duplicate title for the same type — dropped
        items.push(item(
            "object",
            "t:dupe",
            "Title 0",
            Value::String("Customer".into()),
            "/objects/customer",
        ));
        // a second type keeps its own budget
        items.push(item(
            "object",
            "p:1",
            "Prod",
            Value::String("Product".into()),
            "/objects/product",
        ));
        let mut sections = HashMap::new();
        sections.insert("object", items);
        let merged = merge_results(sections);
        assert_eq!(
            merged.iter().filter(|v| v["subtitle"] == "Customer").count(),
            MAX_OBJECT_HITS_PER_TYPE
        );
        assert_eq!(merged.len(), MAX_OBJECT_HITS_PER_TYPE + 1);
    }

    #[test]
    fn tolerant_normalization_drops_malformed() {
        let raw = serde_json::json!({
            "results": [
                { "type": "dataset", "id": "d1", "title": "D", "href": "/datasets/d1" },
                { "type": "unknown-thing", "id": "x", "title": "X", "href": "/" },
                { "type": "pipeline", "title": "no id", "href": "/" },
                { "type": "transform", "id": 42, "title": "T" },
                "not-an-object",
            ]
        });
        let items = normalize_items(&raw);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["type"], "dataset");
        // missing subtitle → null; numeric id stringified; missing href → ""
        assert_eq!(items[1]["id"], "42");
        assert_eq!(items[1]["subtitle"], Value::Null);
        assert_eq!(items[1]["href"], "");
    }

    #[test]
    fn bare_array_response_accepted() {
        let raw = serde_json::json!([
            { "type": "connector", "id": "c", "title": "C", "href": "/connectors" }
        ]);
        assert_eq!(normalize_items(&raw).len(), 1);
    }
}
