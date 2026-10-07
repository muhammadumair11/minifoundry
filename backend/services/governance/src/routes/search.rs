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
/// `object` items are NEVER accepted from a service response: object
/// instance hits are produced exclusively by [`search_object_instances`],
/// which masks rows at the CALLER's role (legacy applyMasking before title
/// matching) — a service-side match could otherwise leak a masked title.
pub fn normalize_items(raw: &Value) -> Vec<Value> {
    let items = crate::fanout::items_array(raw, "results");
    let mut out = Vec::new();
    for it in items {
        let Some(ty) = it.get("type").and_then(|v| v.as_str()) else {
            continue;
        };
        if !SECTION_ORDER.contains(&ty) || ty == "object" {
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
    let needle = q.to_lowercase();
    let path = format!("/internal/search?q={}", percent_encode(q));

    // Metadata sections from the four owners (tolerant per service).
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

    // Object instances fill whatever budget the FIRST FOUR metadata sections
    // left (legacy: instances were computed before dashboards/apps/connectors
    // were appended). Rows are fetched per type from the ontology WITH THE
    // CALLER'S ROLE so masked titles/pks never leak (legacy applyMasking ran
    // before the title match).
    let metadata_count: usize = ["dataset", "pipeline", "transform", "objectType"]
        .iter()
        .map(|ty| sections.get(*ty).map(|v| v.len()).unwrap_or(0))
        .sum();
    let budget = MAX_RESULTS.saturating_sub(metadata_count);
    let instances = search_object_instances(&state, &needle, budget, &actor).await;
    if !instances.is_empty() {
        sections.insert("object", instances);
    }

    Ok(json_ok(serde_json::json!({
        "results": merge_results(sections),
    })))
}

// ─── object-instance search (port of legacy searchObjectInstances) ──────

/// Object-type metadata needed for instance matching.
#[derive(Debug, Clone)]
pub struct InstanceType {
    pub id: String,
    pub api_name: String,
    pub display_name: String,
    pub primary_key: Option<String>,
    pub title_column: Option<String>,
}

/// Parse one object type from the ontology's /internal/ontology payload.
/// Types without a backing dataset are skipped (legacy `sourceDatasetId not
/// null` filter).
pub fn parse_instance_type(v: &Value) -> Option<InstanceType> {
    let id = v.get("id").and_then(|x| x.as_str())?.to_string();
    let api_name = v.get("apiName").and_then(|x| x.as_str())?.to_string();
    let display_name = v
        .get("displayName")
        .and_then(|x| x.as_str())
        .unwrap_or(&api_name)
        .to_string();
    if v.get("sourceDatasetId").map(|x| x.is_null()).unwrap_or(true) {
        return None;
    }
    let primary_key = v
        .get("primaryKey")
        .and_then(|x| x.as_str())
        .map(String::from);
    let title_column = v
        .get("properties")
        .and_then(|p| p.as_array())
        .and_then(|props| {
            props
                .iter()
                .find(|p| p.get("isTitle").and_then(|b| b.as_bool()) == Some(true))
                .and_then(|p| p.get("apiName").and_then(|x| x.as_str()))
                .map(String::from)
        })
        .or_else(|| primary_key.clone());
    Some(InstanceType {
        id,
        api_name,
        display_name,
        primary_key,
        title_column,
    })
}

/// JS `String(value)` for title matching (null/undefined skip the row).
fn js_string(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}

/// Pure per-type hit builder (unit-tested): masked-title types are skipped,
/// one hit per unique title (cap 5/type), global dedupe on apiName|title,
/// href drops ?pk= when the pk column is masked, all bounded by `budget`.
pub fn instance_hits(
    t: &InstanceType,
    rows: &[Value],
    masked: &[String],
    needle: &str,
    budget: usize,
    seen_global: &mut std::collections::HashSet<String>,
) -> Vec<Value> {
    let mut hits = Vec::new();
    if budget == 0 {
        return hits;
    }
    let Some(title_column) = &t.title_column else {
        return hits;
    };
    // Legacy: a masked title column hides the whole type from search.
    if masked.iter().any(|c| c == title_column) {
        return hits;
    }
    let pk_masked = t
        .primary_key
        .as_ref()
        .is_some_and(|pk| masked.iter().any(|c| c == pk));
    let mut seen_titles: std::collections::HashSet<String> = std::collections::HashSet::new();
    for row in rows {
        if hits.len() >= budget || seen_titles.len() >= MAX_OBJECT_HITS_PER_TYPE {
            break;
        }
        let values = row
            .get("values")
            .filter(|v| v.is_object())
            .unwrap_or(row);
        let Some(title_text) = values.get(title_column).and_then(js_string) else {
            continue;
        };
        if !title_text.to_lowercase().contains(needle) {
            continue;
        }
        if !seen_titles.insert(title_text.clone()) {
            continue;
        }
        let dedupe_key = format!("{}|{}", t.api_name, title_text);
        if !seen_global.insert(dedupe_key) {
            continue;
        }
        // pk deep-link — dropped when the pk column is masked for this role.
        let href = match (&pk_masked, &t.primary_key) {
            (false, Some(pk_col)) => values
                .get(pk_col)
                .and_then(js_string)
                .map(|pk| {
                    format!("/objects/{}?pk={}", t.api_name, percent_encode(&pk))
                })
                .unwrap_or_else(|| format!("/objects/{}", t.api_name)),
            _ => format!("/objects/{}", t.api_name),
        };
        hits.push(serde_json::json!({
            "type": "object",
            "id": format!("{}:{}", t.id, title_text),
            "title": title_text,
            "subtitle": t.display_name,
            "href": href,
        }));
    }
    hits
}

/// Object-instance fan-out: object types from the ontology, then MASKED rows
/// per type via /internal/objects/{type}?role=<caller> (the ontology forwards
/// the role to the catalog rows path). Any failure omits instances (warn).
async fn search_object_instances(
    state: &AppState,
    needle: &str,
    budget: usize,
    actor: &mf_auth::Actor,
) -> Vec<Value> {
    if budget == 0 {
        return Vec::new();
    }
    let onto = match state.clients.ontology.get("/internal/ontology").await {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(error = %e, "ontology unavailable; object-instance search omitted");
            return Vec::new();
        }
    };
    let types: Vec<InstanceType> = crate::fanout::items_array(&onto, "objectTypes")
        .iter()
        .filter_map(parse_instance_type)
        .collect();

    let mut hits = Vec::new();
    let mut seen_global = std::collections::HashSet::new();
    for t in types {
        let remaining = budget.saturating_sub(hits.len());
        if remaining == 0 {
            break;
        }
        let path = format!(
            "/internal/objects/{}?role={}&page=1&pageSize=200&limit=200",
            percent_encode(&t.api_name),
            percent_encode(&actor.role)
        );
        let resp = match state.clients.ontology.get_as(&path, actor).await {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(api_name = %t.api_name, error = %e, "object rows unavailable; type skipped");
                continue;
            }
        };
        let rows = crate::fanout::items_array(&resp, "data");
        let mut masked: Vec<String> = resp
            .get("maskedColumns")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        if masked.is_empty() {
            // per-row _masked (v1 objects shape)
            if let Some(first) = rows.first() {
                if let Some(arr) = first.get("_masked").and_then(|v| v.as_array()) {
                    masked = arr
                        .iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect();
                }
            }
        }
        hits.extend(instance_hits(
            &t,
            &rows,
            &masked,
            needle,
            remaining,
            &mut seen_global,
        ));
    }
    hits
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

    #[test]
    fn object_items_from_services_are_dropped() {
        // Instance hits must come from the role-masked local scan only.
        let raw = serde_json::json!({
            "results": [
                { "type": "object", "id": "leak", "title": "Masked Value", "href": "/objects/x" },
                { "type": "objectType", "id": "ot", "title": "T", "href": "/objects/t" },
            ]
        });
        let items = normalize_items(&raw);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["type"], "objectType");
    }

    fn itype() -> InstanceType {
        InstanceType {
            id: "ot1".into(),
            api_name: "customer".into(),
            display_name: "Customer".into(),
            primary_key: Some("customer_id".into()),
            title_column: Some("customer_name".into()),
        }
    }

    fn row(pk: &str, name: &str) -> Value {
        serde_json::json!({
            "pk": pk,
            "values": { "customer_id": pk, "customer_name": name },
            "_masked": [],
        })
    }

    #[test]
    fn instance_hits_match_cap_and_dedupe() {
        let t = itype();
        let rows = vec![
            row("C1", "Amina Khan"),
            row("C2", "Bilal"),
            row("C3", "Amina Khan"), // duplicate title → single hit
            row("C4", "No Match"),
        ];
        let mut seen = std::collections::HashSet::new();
        let hits = instance_hits(&t, &rows, &[], "amina", 20, &mut seen);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0]["title"], "Amina Khan");
        assert_eq!(hits[0]["id"], "ot1:Amina Khan");
        assert_eq!(hits[0]["subtitle"], "Customer");
        assert_eq!(hits[0]["href"], "/objects/customer?pk=C1");
    }

    #[test]
    fn instance_hits_respect_per_type_cap_and_budget() {
        let t = itype();
        let rows: Vec<Value> = (0..9).map(|i| row(&format!("C{i}"), &format!("Amin {i}"))).collect();
        let mut seen = std::collections::HashSet::new();
        let hits = instance_hits(&t, &rows, &[], "amin", 20, &mut seen);
        assert_eq!(hits.len(), MAX_OBJECT_HITS_PER_TYPE);
        let mut seen2 = std::collections::HashSet::new();
        let hits2 = instance_hits(&t, &rows, &[], "amin", 2, &mut seen2);
        assert_eq!(hits2.len(), 2);
    }

    #[test]
    fn masked_title_hides_type_masked_pk_drops_deeplink() {
        let t = itype();
        let rows = vec![row("C1", "Amina")];
        let mut seen = std::collections::HashSet::new();
        // title column masked for this role → the whole type is skipped
        let hits = instance_hits(&t, &rows, &["customer_name".into()], "amina", 20, &mut seen);
        assert!(hits.is_empty());
        // pk column masked → hit survives without ?pk= deep link
        let mut seen2 = std::collections::HashSet::new();
        let hits2 = instance_hits(&t, &rows, &["customer_id".into()], "amina", 20, &mut seen2);
        assert_eq!(hits2.len(), 1);
        assert_eq!(hits2[0]["href"], "/objects/customer");
    }

    #[test]
    fn global_dedupe_across_types() {
        let t1 = itype();
        let mut t2 = itype();
        t2.id = "ot2".into();
        let rows = vec![row("C1", "Amina")];
        let mut seen = std::collections::HashSet::new();
        assert_eq!(instance_hits(&t1, &rows, &[], "amina", 20, &mut seen).len(), 1);
        // same apiName|title from a second type record → globally deduped
        assert!(instance_hits(&t2, &rows, &[], "amina", 20, &mut seen).is_empty());
    }

    #[test]
    fn instance_type_parsing() {
        let full = serde_json::json!({
            "id": "ot1", "apiName": "order", "displayName": "Order",
            "sourceDatasetId": "ds1", "primaryKey": "order_id",
            "properties": [
                { "apiName": "order_id", "isTitle": false },
                { "apiName": "label", "isTitle": true },
            ]
        });
        let t = parse_instance_type(&full).unwrap();
        assert_eq!(t.title_column.as_deref(), Some("label"));
        // no backing dataset → skipped (legacy sourceDatasetId not-null filter)
        let no_ds = serde_json::json!({ "id": "x", "apiName": "a", "sourceDatasetId": null });
        assert!(parse_instance_type(&no_ds).is_none());
        // title falls back to the primary key
        let no_props = serde_json::json!({
            "id": "y", "apiName": "b", "sourceDatasetId": "ds", "primaryKey": "pk"
        });
        assert_eq!(parse_instance_type(&no_props).unwrap().title_column.as_deref(), Some("pk"));
    }
}
