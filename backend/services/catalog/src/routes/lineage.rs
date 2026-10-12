//! /api/lineage[...] — dataset graph, impact BFS and version-level lineage
//! (ports lineage/route.ts, lineage/impact/route.ts, lineage/versions/route.ts).

use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::Response;
use mf_web::{actor_from_headers, json_ok, ApiError, ApiResult};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

use crate::audit::{audit, AuditOptions};
use crate::jsval::locale_compare;
use crate::routes::{pipeline_names, run_infos};
use crate::state::{ts, AppState};

/// GET /api/lineage — nodes (datasets, createdAt asc) + edges (createdAt asc).
pub async fn get_lineage(State(state): State<AppState>) -> ApiResult<Response> {
    #[derive(sqlx::FromRow)]
    struct NodeRow {
        id: String,
        name: String,
        updated_at: chrono::DateTime<chrono::Utc>,
        row_count: Option<i32>,
    }
    let datasets: Vec<NodeRow> = sqlx::query_as(
        "SELECT d.id, d.name, d.updated_at, \
                (SELECT v.row_count FROM dataset_versions v WHERE v.dataset_id = d.id \
                 ORDER BY v.version_number DESC LIMIT 1) AS row_count \
         FROM datasets d ORDER BY d.created_at ASC, d.id ASC",
    )
    .fetch_all(&state.db)
    .await?;
    let edges: Vec<crate::state::LineageEdgeRow> = sqlx::query_as(&format!(
        "SELECT {} FROM lineage_edges ORDER BY created_at ASC, id ASC",
        crate::state::LINEAGE_EDGE_COLS
    ))
    .fetch_all(&state.db)
    .await?;

    let derived_ids: HashSet<&str> = edges.iter().map(|e| e.to_dataset_id.as_str()).collect();
    Ok(json_ok(json!({
        "nodes": datasets.iter().map(|d| json!({
            "id": d.id,
            "name": d.name,
            "kind": if derived_ids.contains(d.id.as_str()) { "derived" } else { "source" },
            "rowCount": d.row_count.unwrap_or(0),
            "updatedAt": ts(&d.updated_at),
        })).collect::<Vec<_>>(),
        "edges": edges.iter().map(|e| json!({
            "id": e.id,
            "from": e.from_dataset_id,
            "to": e.to_dataset_id,
            "pipelineId": e.pipeline_id,
        })).collect::<Vec<_>>(),
    })))
}

/// GET /api/lineage/impact?datasetId= — BFS downstream (max depth 8), first
/// hop wins; affected sorted by depth then name (localeCompare approximation).
pub async fn get_impact(
    State(state): State<AppState>,
    query: axum::extract::Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    let Some(dataset_id) = query.get("datasetId").filter(|s| !s.is_empty()) else {
        return Err(ApiError::bad_request(
            "datasetId query parameter is required",
        ));
    };
    let root: Option<(String, String)> =
        sqlx::query_as("SELECT id, name FROM datasets WHERE id = $1")
            .bind(dataset_id)
            .fetch_optional(&state.db)
            .await?;
    let Some((_, root_name)) = root else {
        return Err(ApiError::bad_request(format!(
            "Dataset '{dataset_id}' not found"
        )));
    };

    let edges: Vec<(String, String, Option<String>)> =
        sqlx::query_as("SELECT from_dataset_id, to_dataset_id, pipeline_id FROM lineage_edges")
            .fetch_all(&state.db)
            .await?;

    // BFS downstream from the root (first/shortest hop wins).
    let mut downstream: Vec<(String, i32, Option<String>)> = Vec::new(); // id, depth, viaPipeline
    let mut seen: HashSet<String> = HashSet::new();
    let mut frontier: Vec<String> = vec![dataset_id.clone()];
    let mut depth = 0;
    const MAX_DEPTH: i32 = 8;
    while !frontier.is_empty() && depth < MAX_DEPTH {
        depth += 1;
        let mut next: Vec<String> = Vec::new();
        for (from, to, pipeline_id) in &edges {
            if !frontier.iter().any(|f| f == from) {
                continue;
            }
            if to == dataset_id {
                continue; // cycle guard
            }
            if seen.contains(to) {
                continue;
            }
            seen.insert(to.clone());
            downstream.push((to.clone(), depth, pipeline_id.clone()));
            next.push(to.clone());
        }
        frontier = next;
    }

    let mut ids: Vec<String> = vec![dataset_id.clone()];
    ids.extend(downstream.iter().map(|(id, _, _)| id.clone()));
    #[derive(sqlx::FromRow)]
    struct DsRow {
        id: String,
        name: String,
        quality_gate: bool,
        head_version: Option<i32>,
        row_count: Option<i32>,
    }
    let datasets: Vec<DsRow> = sqlx::query_as(
        "SELECT d.id, d.name, d.quality_gate, \
                (SELECT v.version_number FROM dataset_versions v WHERE v.dataset_id = d.id \
                 ORDER BY v.version_number DESC LIMIT 1) AS head_version, \
                (SELECT v.row_count FROM dataset_versions v WHERE v.dataset_id = d.id \
                 ORDER BY v.version_number DESC LIMIT 1) AS row_count \
         FROM datasets d WHERE d.id = ANY($1)",
    )
    .bind(&ids)
    .fetch_all(&state.db)
    .await?;
    let by_id: HashMap<String, DsRow> = datasets.into_iter().map(|d| (d.id.clone(), d)).collect();

    // Pipeline display names — best-effort from orchestration (null when the
    // service is unreachable; the legacy joined its own DB).
    let needs_names = downstream.iter().any(|(_, _, p)| p.is_some());
    let names: HashMap<String, String> = if needs_names {
        pipeline_names(&state).await
    } else {
        HashMap::new()
    };

    let mut affected: Vec<Value> = downstream
        .iter()
        .map(|(id, d, via)| {
            let ds = by_id.get(id);
            let via_name = via.as_ref().and_then(|p| names.get(p)).cloned();
            json!({
                "id": id,
                "name": ds.map(|x| x.name.clone()).unwrap_or_else(|| "(unknown)".to_string()),
                "depth": d,
                "viaPipelineId": via,
                "viaPipelineName": via_name,
                "headVersion": ds.and_then(|x| x.head_version).unwrap_or(0),
                "rowCount": ds.and_then(|x| x.row_count).unwrap_or(0),
                "gated": ds.map(|x| x.quality_gate).unwrap_or(false),
            })
        })
        .collect();
    affected.sort_by(|a, b| {
        a["depth"]
            .as_i64()
            .unwrap_or(0)
            .cmp(&b["depth"].as_i64().unwrap_or(0))
            .then_with(|| {
                locale_compare(
                    a["name"].as_str().unwrap_or(""),
                    b["name"].as_str().unwrap_or(""),
                )
            })
    });

    let max_depth = downstream.iter().map(|(_, d, _)| *d).max().unwrap_or(0);
    Ok(json_ok(json!({
        "root": {
            "id": dataset_id,
            "name": root_name,
            "headVersion": by_id.get(dataset_id).and_then(|x| x.head_version).unwrap_or(0),
        },
        "affected": affected,
        "total": downstream.len(),
        "maxDepth": max_depth,
    })))
}

/// GET /api/lineage/versions?datasetId=&versionNumber= — exact input/output
/// versions with display joins; audited as lineage.version.view (curriculum).
pub async fn get_version_lineage(
    State(state): State<AppState>,
    headers: HeaderMap,
    query: axum::extract::Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    let Some(dataset_id) = query.get("datasetId").filter(|s| !s.is_empty()) else {
        return Err(ApiError::bad_request(
            "datasetId query parameter is required",
        ));
    };
    let version_number = match query.get("versionNumber") {
        Some(raw) => {
            let n = crate::jsval::js_parse_number(raw);
            if !n.is_finite() || n.fract() != 0.0 || n <= 0.0 {
                return Err(ApiError::bad_request(
                    "versionNumber must be a positive integer",
                ));
            }
            n as i32
        }
        None => {
            return Err(ApiError::bad_request(
                "versionNumber must be a positive integer",
            ))
        }
    };

    let upstream: Vec<crate::state::VersionLineageEdgeRow> = sqlx::query_as(&format!(
        "SELECT {} FROM version_lineage_edges WHERE to_dataset_id = $1 AND to_version_number = $2 \
         ORDER BY created_at ASC, id ASC LIMIT 50",
        crate::state::VERSION_LINEAGE_EDGE_COLS
    ))
    .bind(dataset_id)
    .bind(version_number)
    .fetch_all(&state.db)
    .await?;
    let downstream: Vec<crate::state::VersionLineageEdgeRow> = sqlx::query_as(&format!(
        "SELECT {} FROM version_lineage_edges WHERE from_dataset_id = $1 AND from_version_number = $2 \
         ORDER BY created_at ASC, id ASC LIMIT 50",
        crate::state::VERSION_LINEAGE_EDGE_COLS
    ))
    .bind(dataset_id)
    .bind(version_number)
    .fetch_all(&state.db)
    .await?;

    let dataset: Option<(String, String)> =
        sqlx::query_as("SELECT id, name FROM datasets WHERE id = $1")
            .bind(dataset_id)
            .fetch_optional(&state.db)
            .await?;
    let Some((_, dataset_name)) = dataset else {
        return Err(ApiError::bad_request(format!(
            "Dataset '{dataset_id}' not found"
        )));
    };
    audit(
        &state,
        &actor,
        AuditOptions::new("lineage.version.view", "dataset")
            .resource_id(Some(dataset_id))
            .resource_name(Some(&dataset_name))
            .detail(Some(&format!("v{version_number}"))),
    )
    .await;

    // Dataset display names (local).
    let mut dataset_ids: HashSet<String> = HashSet::new();
    for e in upstream.iter().chain(downstream.iter()) {
        dataset_ids.insert(e.from_dataset_id.clone());
        dataset_ids.insert(e.to_dataset_id.clone());
    }
    dataset_ids.insert(dataset_id.clone());
    let names: Vec<(String, String)> =
        sqlx::query_as("SELECT id, name FROM datasets WHERE id = ANY($1)")
            .bind(dataset_ids.iter().cloned().collect::<Vec<_>>())
            .fetch_all(&state.db)
            .await?;
    let names: HashMap<String, String> = names.into_iter().collect();

    // Pipeline names — best-effort from orchestration.
    let pipeline_ids: HashSet<String> = upstream
        .iter()
        .chain(downstream.iter())
        .filter_map(|e| e.pipeline_id.clone())
        .collect();
    let pipelines: HashMap<String, String> = if pipeline_ids.is_empty() {
        HashMap::new()
    } else {
        pipeline_names(&state).await
    };
    // Run info — best-effort from orchestration.
    let run_ids: HashSet<String> = upstream
        .iter()
        .chain(downstream.iter())
        .filter_map(|e| e.run_id.clone())
        .collect();
    #[allow(clippy::type_complexity)]
    let runs: HashMap<String, (Option<String>, Option<String>, Option<String>)> =
        if run_ids.is_empty() {
            HashMap::new()
        } else {
            run_infos(&state).await
        };

    let shape = |e: &crate::state::VersionLineageEdgeRow, direction: &str| -> Value {
        // Transform-run display info lives in the compute service (no by-id
        // internal lookup in the contract) — degrades exactly like the legacy
        // did for missing rows: trigger 'transform', status/startedAt null.
        let (run_trigger, run_status, started_at) = if e.transform_run_id.is_some() {
            (
                Some("transform".to_string()),
                None::<String>,
                None::<String>,
            )
        } else if let Some(run_id) = &e.run_id {
            match runs.get(run_id) {
                Some((trigger, status, started)) => {
                    (trigger.clone(), status.clone(), started.clone())
                }
                None => (None, None, None),
            }
        } else {
            (None, None, None)
        };
        json!({
            "fromDatasetId": e.from_dataset_id,
            "fromDatasetName": names.get(&e.from_dataset_id).cloned().unwrap_or_else(|| "(unknown)".into()),
            "fromVersionNumber": e.from_version_number,
            "toDatasetId": e.to_dataset_id,
            "toDatasetName": names.get(&e.to_dataset_id).cloned().unwrap_or_else(|| "(unknown)".into()),
            "toVersionNumber": e.to_version_number,
            "runId": e.run_id,
            "runTrigger": run_trigger,
            "runStatus": run_status,
            "startedAt": started_at,
            "pipelineId": e.pipeline_id,
            "pipelineName": e.pipeline_id.as_ref().and_then(|p| pipelines.get(p)).cloned(),
            "transformRunId": e.transform_run_id,
            "transformName": Value::Null,
            "direction": direction,
        })
    };

    Ok(json_ok(json!({
        "datasetId": dataset_id,
        "datasetName": dataset_name,
        "versionNumber": version_number,
        "upstream": upstream.iter().map(|e| shape(e, "up")).collect::<Vec<_>>(),
        "downstream": downstream.iter().map(|e| shape(e, "down")).collect::<Vec<_>>(),
    })))
}
