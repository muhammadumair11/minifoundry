//! GET /api/health — platform health metrics (port of src/app/api/health/route.ts).
//!
//! The aggregate math is ported EXACTLY: successRatePct = all-time
//! success/(success+failed) with Math.round(x*1000)/10 (100 when none),
//! avgDurationMs over finished runs (null when none), runs7d/failed7d over
//! startedAt >= now-7d, failingPipelines = top 5 pipelineIds by failed count
//! desc with names. The datasets block comes from catalog's
//! GET /internal/health/datasets (a down catalog degrades to `datasets: []`
//! with a tracing warn — orchestration must stay up for its own metrics).

use axum::response::Response;
use chrono::{DateTime, Utc};
use mf_web::TenantState as State;
use mf_web::{json_ok, ApiResult};
use serde_json::{json, Map, Value};

use crate::state::AppState;
use crate::values::{js_math_round, json_number};

const SEVEN_DAYS_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// The runs-side aggregates (also served on /internal/health/runs).
pub async fn compute_runs_health(state: &AppState) -> Result<Value, sqlx::Error> {
    let now = Utc::now();
    let week_ago = now - chrono::Duration::milliseconds(SEVEN_DAYS_MS);

    let (success_count,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM pipeline_runs WHERE status = 'success'")
            .fetch_one(&state.db)
            .await?;
    let (failed_count,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM pipeline_runs WHERE status = 'failed'")
            .fetch_one(&state.db)
            .await?;
    let (runs7d,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM pipeline_runs WHERE started_at >= $1")
            .bind(week_ago)
            .fetch_one(&state.db)
            .await?;
    let (failed7d,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM pipeline_runs WHERE started_at >= $1 AND status = 'failed'",
    )
    .bind(week_ago)
    .fetch_one(&state.db)
    .await?;
    let finished_runs: Vec<(DateTime<Utc>, DateTime<Utc>)> = sqlx::query_as(
        "SELECT started_at, finished_at FROM pipeline_runs WHERE finished_at IS NOT NULL",
    )
    .fetch_all(&state.db)
    .await?;

    let finished_total = success_count + failed_count;
    let success_rate = if finished_total == 0 {
        json!(100)
    } else {
        json_number(js_math_round(success_count as f64 / finished_total as f64 * 1000.0) / 10.0)
    };

    let avg_duration = if finished_runs.is_empty() {
        Value::Null
    } else {
        let sum: i64 = finished_runs
            .iter()
            .map(|(s, f)| (*f - *s).num_milliseconds())
            .sum();
        json!(js_math_round(sum as f64 / finished_runs.len() as f64) as i64)
    };

    // Top-5 failing pipelines by failed count desc (tie-break pipeline_id asc
    // for determinism — Prisma groupBy leaves ties unordered).
    let failing_groups: Vec<(String, i64, Option<DateTime<Utc>>)> = sqlx::query_as(
        "SELECT pipeline_id, COUNT(*) AS failed_count, MAX(finished_at) AS last_failure_at \
         FROM pipeline_runs WHERE status = 'failed' \
         GROUP BY pipeline_id ORDER BY failed_count DESC, pipeline_id ASC LIMIT 5",
    )
    .fetch_all(&state.db)
    .await?;
    let failing_pipelines = if failing_groups.is_empty() {
        vec![]
    } else {
        let ids: Vec<String> = failing_groups.iter().map(|(id, _, _)| id.clone()).collect();
        let names: Vec<(String, String)> =
            sqlx::query_as("SELECT id, name FROM pipelines WHERE id = ANY($1)")
                .bind(&ids)
                .fetch_all(&state.db)
                .await?;
        let name_by: std::collections::HashMap<&str, &str> = names
            .iter()
            .map(|(id, n)| (id.as_str(), n.as_str()))
            .collect();
        failing_groups
            .iter()
            .map(|(id, count, last)| {
                json!({
                    "id": id,
                    "name": name_by.get(id.as_str()).copied().unwrap_or("Unknown pipeline"),
                    "failedCount": count,
                    "lastFailureAt": last.map(|d| mf_types::ts::format(&d)),
                })
            })
            .collect()
    };

    Ok(json!({
        "successRatePct": success_rate,
        "avgDurationMs": avg_duration,
        "runs7d": runs7d,
        "failed7d": failed7d,
        "failingPipelines": failing_pipelines,
    }))
}

/// GET /api/health — merges the runs aggregates with catalog's dataset
/// freshness list (fixture order: successRatePct, avgDurationMs, runs7d,
/// failed7d, datasets, failingPipelines).
pub async fn health(State(state): State<AppState>) -> ApiResult<Response> {
    let runs = compute_runs_health(&state)
        .await
        .map_err(|e| mf_web::ApiError::internal(e.to_string()))?;
    let datasets = match state.catalog.health_datasets().await {
        Ok(d) => Value::Array(d),
        Err(e) => {
            tracing::warn!(error = %crate::catalog::internal_error_message(&e), "health: catalog datasets unavailable — returning []");
            Value::Array(vec![])
        }
    };
    let mut out = Map::new();
    for key in ["successRatePct", "avgDurationMs", "runs7d", "failed7d"] {
        if let Some(v) = runs.get(key) {
            out.insert(key.to_string(), v.clone());
        }
    }
    out.insert("datasets".to_string(), datasets);
    if let Some(v) = runs.get("failingPipelines") {
        out.insert("failingPipelines".to_string(), v.clone());
    }
    Ok(json_ok(Value::Object(out)))
}
