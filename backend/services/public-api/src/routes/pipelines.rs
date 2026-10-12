//! /api/foundry/v1/pipelines* — pipeline reads over the public API. The
//! orchestration service owns the data; this facade maps its internal
//! responses onto the legacy v1 shapes (fixtures reads/v1-pipelines.json /
//! v1-pipeline-detail.json) with the standard pagination envelope.

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, Uri};
use axum::response::Response;
use mf_web::json_ok;
use serde_json::Value;
use std::collections::HashMap;

use crate::fanout::{fanout_err, items_array, payload_root};
use crate::guard::{self, v1_page_from, v1_pagination};
use crate::routes::{paginate, sort_by_ts_desc};
use crate::state::AppState;

/// GET /api/foundry/v1/pipelines?page=&pageSize=
pub async fn list_pipelines(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let path = uri.path().to_string();
    let st = state.clone();
    guard::with_api_token(&state, &headers, &path, move |_ctx| async move {
        let (page, page_size) = v1_page_from(&params);
        let resp = st
            .orchestration
            .get("/internal/pipelines")
            .await
            .map_err(fanout_err)?;
        let mut items: Vec<Value> = items_array(&resp, "pipelines")
            .iter()
            .map(pipeline_v1_item)
            .collect();
        let total = items.len() as i64;
        sort_by_ts_desc(&mut items, "updatedAt");
        let data = paginate(&items, page, page_size);
        Ok(json_ok(serde_json::json!({
            "data": data,
            "pagination": v1_pagination(page, page_size, total),
        })))
    })
    .await
}

/// GET /api/foundry/v1/pipelines/{id}
pub async fn pipeline_detail(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path(id): Path<String>,
) -> Response {
    let path = uri.path().to_string();
    let st = state.clone();
    guard::with_api_token(&state, &headers, &path, move |_ctx| async move {
        let resp = st
            .orchestration
            .get(&format!("/internal/pipelines/{id}"))
            .await
            .map_err(fanout_err)?;
        let root = payload_root(&resp, &["pipeline"]);

        let nodes = root
            .get("nodes")
            .cloned()
            .filter(|v| v.is_array())
            .or_else(|| root.get("graph").and_then(|g| g.get("nodes")).cloned())
            .unwrap_or(Value::Array(vec![]));
        let graph = root
            .get("graph")
            .cloned()
            .filter(|v| v.is_object())
            .unwrap_or_else(|| serde_json::json!({ "nodes": [], "edges": [] }));
        let last_runs = root
            .get("lastRuns")
            .cloned()
            .filter(|v| v.is_array())
            .or_else(|| root.get("recentRuns").cloned().filter(|v| v.is_array()))
            .unwrap_or(Value::Array(vec![]));

        Ok(json_ok(serde_json::json!({
            "pipeline": {
                "id": root.get("id").cloned().unwrap_or(Value::String(id.clone())),
                "name": root.get("name").cloned().unwrap_or(Value::Null),
                "description": root.get("description").cloned().unwrap_or(Value::Null),
                "nodes": nodes,
                "graph": graph,
                "lastRuns": last_runs,
            },
        })))
    })
    .await
}

/// v1 pipeline-list item (fixture reads/v1-pipelines.json).
pub fn pipeline_v1_item(p: &Value) -> Value {
    let root = payload_root(p, &["pipeline"]);
    let node_count = root
        .get("nodeCount")
        .and_then(|v| v.as_i64())
        .or_else(|| {
            root.get("graph")
                .and_then(|g| g.get("nodes"))
                .and_then(|n| n.as_array())
                .map(|a| a.len() as i64)
        })
        .or_else(|| {
            root.get("nodes")
                .and_then(|n| n.as_array())
                .map(|a| a.len() as i64)
        })
        .unwrap_or(0);
    let last_run = root
        .get("lastRun")
        .filter(|v| v.is_object())
        .cloned()
        .map(|r| {
            serde_json::json!({
                "status": r.get("status").cloned().unwrap_or(Value::Null),
                "startedAt": r.get("startedAt").cloned().unwrap_or(Value::Null),
            })
        })
        .or_else(|| {
            root.get("runs")
                .and_then(|v| v.as_array())
                .and_then(|a| a.first())
                .map(|r| {
                    serde_json::json!({
                        "status": r.get("status").cloned().unwrap_or(Value::Null),
                        "startedAt": r.get("startedAt").cloned().unwrap_or(Value::Null),
                    })
                })
        })
        .unwrap_or(Value::Null);
    serde_json::json!({
        "id": root.get("id").cloned().unwrap_or(Value::Null),
        "name": root.get("name").cloned().unwrap_or(Value::Null),
        "description": root.get("description").cloned().unwrap_or(Value::Null),
        "nodeCount": node_count,
        "lastRun": last_run,
        "updatedAt": root.get("updatedAt").cloned().unwrap_or(Value::Null),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn item_mapping_tolerates_shapes() {
        let a = pipeline_v1_item(&json!({
            "id": "p1", "name": "P", "description": null, "nodeCount": 8,
            "lastRun": { "status": "success", "startedAt": "2026-01-01T00:00:00.000Z", "extra": 1 },
            "updatedAt": "2026-01-02T00:00:00.000Z"
        }));
        assert_eq!(a["nodeCount"], 8);
        assert_eq!(a["lastRun"]["status"], "success");
        assert!(a["lastRun"].get("extra").is_none());

        let b = pipeline_v1_item(&json!({
            "pipeline": { "id": "p2", "name": "Q", "graph": { "nodes": [{}, {}], "edges": [] },
                          "runs": [{ "status": "failed", "startedAt": "x" }] }
        }));
        assert_eq!(b["nodeCount"], 2);
        assert_eq!(b["lastRun"]["status"], "failed");

        let c = pipeline_v1_item(&json!({ "id": "p3" }));
        assert_eq!(c["nodeCount"], 0);
        assert_eq!(c["lastRun"], Value::Null);
    }
}
