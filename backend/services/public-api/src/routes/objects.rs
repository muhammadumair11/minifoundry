//! /api/foundry/v1/objects* — object reads over the public API. The
//! ontology service owns the data and applies viewer masking (forwarded
//! actor + `role=viewer` per the internal-API clarification). This facade
//! reshapes responses onto the legacy v1 contracts (fixtures
//! reads/v1-objects.json / v1-object-detail).

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, Uri};
use axum::response::Response;
use mf_web::{json_ok, ApiError};
use serde_json::Value;
use std::collections::HashMap;

use crate::fanout::{fanout_err, items_array, percent_encode, viewer_actor};
use crate::guard::{self, v1_page_from, v1_pagination};
use crate::state::AppState;

/// GET /api/foundry/v1/objects/{type}?page=&pageSize=&q=
pub async fn list_objects(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path(object_type): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let path = uri.path().to_string();
    let st = state.clone();
    guard::with_api_token(&state, &headers, &path, move |_ctx| async move {
        let (page, page_size) = v1_page_from(&params);
        let mut query = format!("role=viewer&page={page}&pageSize={page_size}");
        if let Some(q) = params.get("q").filter(|q| !q.is_empty()) {
            query.push_str(&format!("&q={}", percent_encode(q)));
        }
        let resp = st
            .ontology
            .get_as(
                &format!("/internal/objects/{}?{query}", percent_encode(&object_type)),
                &viewer_actor(),
            )
            .await
            .map_err(fanout_err)?;

        let masked_default = resp
            .get("maskedColumns")
            .cloned()
            .filter(|v| v.is_array())
            .unwrap_or(Value::Array(vec![]));
        let mut data = items_array(&resp, "data");
        for row in data.iter_mut() {
            if row.get("_masked").is_none() {
                row["_masked"] = masked_default.clone();
            }
        }

        let total = resp
            .get("pagination")
            .and_then(|p| p.get("total"))
            .and_then(|v| v.as_i64())
            .or_else(|| resp.get("total").and_then(|v| v.as_i64()))
            .unwrap_or(data.len() as i64);
        let pagination = resp
            .get("pagination")
            .filter(|p| p.is_object())
            .cloned()
            .unwrap_or_else(|| v1_pagination(page, page_size, total));

        Ok(json_ok(serde_json::json!({
            "data": data,
            "pagination": pagination,
            "objectType": normalize_object_type(resp.get("objectType")),
            "columns": resp.get("columns").cloned().filter(|v| v.is_array()).unwrap_or(Value::Array(vec![])),
        })))
    })
    .await
}

/// GET /api/foundry/v1/objects/{type}/{pk}
pub async fn get_object(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path((object_type, pk)): Path<(String, String)>,
) -> Response {
    let path = uri.path().to_string();
    let st = state.clone();
    guard::with_api_token(&state, &headers, &path, move |_ctx| async move {
        // `pk` is an additive hint param — ontology implementations that
        // resolve it natively answer with `{object}`; otherwise the facade
        // scans the (masked) list, like the legacy route scanned raw rows.
        let resp = st
            .ontology
            .get_as(
                &format!(
                    "/internal/objects/{}?role=viewer&pk={}&page=1&pageSize=1000",
                    percent_encode(&object_type),
                    percent_encode(&pk)
                ),
                &viewer_actor(),
            )
            .await
            .map_err(fanout_err)?;

        let object_type_info = resp.get("objectType").filter(|v| v.is_object());
        let api_name = object_type_info
            .and_then(|t| t.get("apiName"))
            .and_then(|v| v.as_str())
            .unwrap_or(&object_type);

        if let Some(info) = object_type_info {
            let has_pk = info
                .get("primaryKey")
                .and_then(|v| v.as_str())
                .is_some_and(|s| !s.is_empty());
            if !has_pk {
                return Err(ApiError::bad_request(format!(
                    "Object type '{api_name}' has no primary key configured"
                )));
            }
            if info.get("sourceDatasetId").map(|v| v.is_null()).unwrap_or(false) {
                return Err(ApiError::not_found(format!(
                    "Object type '{api_name}' has no backing dataset"
                )));
            }
        }

        if let Some(obj) = resp.get("object").filter(|v| v.is_object()) {
            let mut obj = obj.clone();
            if obj.get("_masked").is_none() {
                obj["_masked"] = resp
                    .get("maskedColumns")
                    .cloned()
                    .filter(|v| v.is_array())
                    .unwrap_or(Value::Array(vec![]));
            }
            return Ok(json_ok(serde_json::json!({ "object": obj })));
        }

        // Fallback: loose pk match across the returned rows (legacy
        // looseEqual on the raw value, masking applied afterwards — the
        // masked pk value still resolves because markings rarely cover the
        // pk column; documented deviation when they do).
        let primary_key = object_type_info
            .and_then(|t| t.get("primaryKey"))
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        let rows = items_array(&resp, "data");
        let masked_default = resp
            .get("maskedColumns")
            .cloned()
            .filter(|v| v.is_array())
            .unwrap_or(Value::Array(vec![]));
        for row in &rows {
            let values = row
                .get("values")
                .filter(|v| v.is_object())
                .cloned()
                .unwrap_or_else(|| row.clone());
            let candidate = values
                .get(primary_key)
                .or_else(|| row.get("pk"))
                .cloned()
                .unwrap_or(Value::Null);
            if loose_equal(&candidate, &pk) {
                let pk_value = values
                    .get(primary_key)
                    .cloned()
                    .or_else(|| row.get("pk").cloned())
                    .unwrap_or(Value::Null);
                let masked = row
                    .get("_masked")
                    .cloned()
                    .unwrap_or_else(|| masked_default.clone());
                return Ok(json_ok(serde_json::json!({
                    "object": { "pk": pk_value, "values": values, "_masked": masked },
                })));
            }
        }

        Err(ApiError::not_found(format!(
            "Object '{pk}' not found in type '{api_name}'"
        )))
    })
    .await
}

/// Ensure the objectType block carries the legacy keys incl. titleProperty
/// (isTitle property → primaryKey → null).
fn normalize_object_type(t: Option<&Value>) -> Value {
    let Some(t) = t.filter(|v| v.is_object()) else {
        return Value::Null;
    };
    let title_property = t
        .get("titleProperty")
        .cloned()
        .or_else(|| {
            t.get("properties")
                .and_then(|p| p.as_array())
                .and_then(|props| {
                    props
                        .iter()
                        .find(|p| p.get("isTitle").and_then(|v| v.as_bool()) == Some(true))
                        .and_then(|p| p.get("apiName").cloned())
                })
        })
        .or_else(|| t.get("primaryKey").cloned())
        .unwrap_or(Value::Null);
    serde_json::json!({
        "id": t.get("id").cloned().unwrap_or(Value::Null),
        "apiName": t.get("apiName").cloned().unwrap_or(Value::Null),
        "displayName": t.get("displayName").cloned().unwrap_or(Value::Null),
        "primaryKey": t.get("primaryKey").cloned().unwrap_or(Value::Null),
        "icon": t.get("icon").cloned().unwrap_or(Value::Null),
        "color": t.get("color").cloned().unwrap_or(Value::Null),
        "titleProperty": title_property,
    })
}

/// Port of `looseEqual` — identical, numerically equal, or string-equal.
pub fn loose_equal(a: &Value, b: &str) -> bool {
    match a {
        Value::Null => false,
        Value::String(s) => {
            if s == b {
                return true;
            }
            numeric_eq(s, b)
        }
        Value::Number(n) => {
            let as_str = n.to_string();
            if as_str == b {
                return true;
            }
            numeric_eq(&as_str, b)
        }
        Value::Bool(bl) => {
            let as_str = if *bl { "true" } else { "false" };
            as_str == b || numeric_eq(as_str, b)
        }
        other => *other == *b,
    }
}

fn numeric_eq(a: &str, b: &str) -> bool {
    match (a.trim().parse::<f64>(), b.trim().parse::<f64>()) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn loose_equal_matches_legacy() {
        assert!(loose_equal(&json!("C001"), "C001"));
        assert!(!loose_equal(&json!("C001"), "C002"));
        assert!(loose_equal(&json!(22), "22"));
        assert!(loose_equal(&json!(22.0), "22"));
        assert!(loose_equal(&json!("22"), "22.0"));
        assert!(loose_equal(&json!(2.5), "2.5"));
        assert!(!loose_equal(&json!(null), "null"));
        assert!(!loose_equal(&json!(null), ""));
        assert!(loose_equal(&json!(true), "true"));
    }

    #[test]
    fn object_type_title_property_fallbacks() {
        let t = json!({
            "id": "ot1", "apiName": "customer", "displayName": "Customer",
            "primaryKey": "customer_id", "icon": "globe", "color": "emerald",
            "properties": [
                { "apiName": "customer_id", "isTitle": true },
                { "apiName": "city", "isTitle": false },
            ]
        });
        let n = normalize_object_type(Some(&t));
        assert_eq!(n["titleProperty"], "customer_id");
        // no isTitle → primaryKey
        let t2 = json!({ "primaryKey": "pk", "properties": [{ "apiName": "x" }] });
        assert_eq!(normalize_object_type(Some(&t2))["titleProperty"], "pk");
        // nothing → null
        assert_eq!(normalize_object_type(None), Value::Null);
    }
}
