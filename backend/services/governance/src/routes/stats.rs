//! GET /api/stats — platform overview counters + recent activity (port of
//! the legacy stats route). Every number now lives in a sibling service:
//! catalog (projects/datasets/rows), orchestration (pipelines/runs). Each
//! fan-out is tolerant: an unreachable service contributes zeros/empty
//! arrays while the response keys stay exactly as the fixture pins them.

use axum::extract::State;
use axum::response::Response;
use mf_web::{json_ok, ApiResult};
use serde_json::Value;

use crate::state::AppState;

fn num(v: &Value, key: &str) -> i64 {
    v.get(key).and_then(|x| x.as_i64()).unwrap_or(0)
}

pub async fn stats(State(state): State<AppState>) -> ApiResult<Response> {
    let (catalog_stats, orch_stats, orch_runs, catalog_datasets) = futures::join!(
        state.clients.catalog.get("/internal/stats"),
        state.clients.orchestration.get("/internal/stats"),
        state.clients.orchestration.get("/internal/runs?limit=5"),
        state.clients.catalog.get("/internal/datasets"),
    );

    let catalog_stats = log_degrade(catalog_stats, "catalog stats");
    let orch_stats = log_degrade(orch_stats, "orchestration stats");
    let orch_runs = log_degrade(orch_runs, "orchestration runs");
    let catalog_datasets = log_degrade(catalog_datasets, "catalog datasets");

    // Datasets: totalRows over each dataset's latest version rowCount and the
    // 5 most recently updated datasets (legacy took versions[0].rowCount).
    let datasets = crate::fanout::items_array(&catalog_datasets, "datasets");
    let total_rows: i64 = datasets.iter().map(latest_row_count).sum();

    let mut recent_datasets: Vec<Value> = datasets
        .iter()
        .map(|d| {
            serde_json::json!({
                "id": d.get("id").cloned().unwrap_or(Value::Null),
                "name": d.get("name").cloned().unwrap_or(Value::Null),
                "rowCount": latest_row_count(d),
                "updatedAt": d.get("updatedAt").cloned().unwrap_or(Value::Null),
            })
        })
        .collect();
    // updatedAt desc (ISO strings sort lexicographically); nulls last.
    recent_datasets.sort_by(|a, b| {
        let ka = a["updatedAt"].as_str().unwrap_or("");
        let kb = b["updatedAt"].as_str().unwrap_or("");
        kb.cmp(ka)
    });
    recent_datasets.truncate(5);

    // Recent runs: orchestration's internal runs feed (already latest-first
    // per spec); map defensively onto the legacy row shape.
    let runs = crate::fanout::items_array(&orch_runs, "runs");
    let recent_runs: Vec<Value> = runs
        .iter()
        .take(5)
        .map(|r| {
            let pipeline_name = r
                .get("pipelineName")
                .cloned()
                .or_else(|| {
                    r.get("pipeline")
                        .and_then(|p| p.get("name"))
                        .cloned()
                })
                .unwrap_or(Value::Null);
            serde_json::json!({
                "id": r.get("id").cloned().unwrap_or(Value::Null),
                "pipelineName": pipeline_name,
                "status": r.get("status").cloned().unwrap_or(Value::Null),
                "startedAt": r.get("startedAt").cloned().unwrap_or(Value::Null),
                "finishedAt": r.get("finishedAt").cloned().unwrap_or(Value::Null),
            })
        })
        .collect();

    Ok(json_ok(serde_json::json!({
        "projects": num(&catalog_stats, "projects"),
        "datasets": num(&catalog_stats, "datasets"),
        "pipelines": num(&orch_stats, "pipelines"),
        "runs": num(&orch_stats, "runs"),
        "successRuns": num(&orch_stats, "runsSuccess"),
        "failedRuns": num(&orch_stats, "runsFailed"),
        "totalRows": total_rows,
        "recentRuns": recent_runs,
        "recentDatasets": recent_datasets,
    })))
}

fn log_degrade(r: Result<Value, crate::fanout::FanOutError>, what: &str) -> Value {
    match r {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(what, error = %e, "stats fan-out failed; degrading to zeros");
            Value::Null
        }
    }
}

/// Latest-version rowCount of a dataset summary (tolerant across the session
/// `currentVersion` and v1 `latestVersion` shapes).
pub fn latest_row_count(d: &Value) -> i64 {
    for key in ["currentVersion", "latestVersion"] {
        if let Some(n) = d.get(key).and_then(|v| v.get("rowCount")).and_then(|v| v.as_i64()) {
            return n;
        }
    }
    d.get("rowCount").and_then(|v| v.as_i64()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn row_count_tolerates_shapes() {
        assert_eq!(
            latest_row_count(&serde_json::json!({"currentVersion": {"rowCount": 7}})),
            7
        );
        assert_eq!(
            latest_row_count(&serde_json::json!({"latestVersion": {"rowCount": 3}})),
            3
        );
        assert_eq!(
            latest_row_count(&serde_json::json!({"currentVersion": null})),
            0
        );
        assert_eq!(latest_row_count(&serde_json::json!({})), 0);
    }
}
