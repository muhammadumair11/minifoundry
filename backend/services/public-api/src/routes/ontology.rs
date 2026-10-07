//! GET /api/foundry/v1/ontology — semantic layer over the public API. The
//! ontology service returns the serialized object types (public contract);
//! this facade adds the legacy flattened top-level `actions` array (each
//! action tagged with its owner object type) when the callee did not
//! pre-flatten it.

use axum::extract::{Query, State};
use axum::http::{HeaderMap, Uri};
use axum::response::Response;
use mf_web::json_ok;
use serde_json::Value;
use std::collections::HashMap;

use crate::fanout::{fanout_err, items_array, viewer_actor};
use crate::guard;
use crate::state::AppState;

pub async fn get_ontology(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Query(_params): Query<HashMap<String, String>>,
) -> Response {
    let path = uri.path().to_string();
    let st = state.clone();
    guard::with_api_token(&state, &headers, &path, move |_ctx| async move {
        let resp = st
            .ontology
            .get_as("/internal/ontology", &viewer_actor())
            .await
            .map_err(fanout_err)?;

        let object_types: Vec<Value> = match resp.get("objectTypes").and_then(|v| v.as_array()) {
            Some(arr) => arr.clone(),
            None => items_array(&resp, "objectTypes"),
        };

        let actions: Vec<Value> = match resp.get("actions").and_then(|v| v.as_array()) {
            Some(arr) => arr.clone(),
            None => flatten_actions(&object_types),
        };

        Ok(json_ok(serde_json::json!({
            "objectTypes": object_types,
            "actions": actions,
        })))
    })
    .await
}

/// Legacy flattening: every action of every object type, tagged with
/// `objectType: { id, apiName, displayName }`.
pub fn flatten_actions(object_types: &[Value]) -> Vec<Value> {
    let mut out = Vec::new();
    for ot in object_types {
        let tag = serde_json::json!({
            "id": ot.get("id").cloned().unwrap_or(Value::Null),
            "apiName": ot.get("apiName").cloned().unwrap_or(Value::Null),
            "displayName": ot.get("displayName").cloned().unwrap_or(Value::Null),
        });
        if let Some(actions) = ot.get("actions").and_then(|v| v.as_array()) {
            for a in actions {
                let mut a = match a {
                    Value::Object(m) => Value::Object(m.clone()),
                    other => serde_json::json!({ "value": other.clone() }),
                };
                a["objectType"] = tag.clone();
                out.push(a);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn flattens_actions_with_owner_tag() {
        let ots = vec![
            json!({
                "id": "ot1", "apiName": "order", "displayName": "Order",
                "actions": [{ "id": "a1", "apiName": "update" }]
            }),
            json!({ "id": "ot2", "apiName": "customer", "displayName": "Customer", "actions": [] }),
            json!({ "id": "ot3", "apiName": "product", "displayName": "Product" }),
        ];
        let actions = flatten_actions(&ots);
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0]["id"], "a1");
        assert_eq!(actions[0]["objectType"]["apiName"], "order");
        assert_eq!(actions[0]["objectType"]["displayName"], "Order");
    }
}
