//! M3.1 pipeline versioning — port of `src/lib/pipeline-version-service.ts`.
//! Every graph save snapshots an immutable pipeline_versions row; every run
//! pins the version it executed. Pruning mirrors the keepLastN pattern.

use serde_json::Value;
use sqlx::types::Json;

use crate::state::{PipelineVersionRow, AppState, VERSION_COLS};

/// Pipeline versions retained per pipeline (versions beyond this are pruned).
pub const KEEP_LAST_N: i64 = 20;

/// Validate a stored graph value parses as { nodes: [...], edges: [...] } and
/// return its node count. Error messages mirror the legacy zod surface:
/// 'Pipeline graph is not valid JSON' / `Pipeline graph invalid — <issue>`.
pub fn assert_valid_graph(graph: &Value) -> Result<usize, String> {
    let Some(obj) = graph.as_object() else {
        let kind = match graph {
            Value::Array(_) => "array",
            Value::Null => "null",
            Value::Bool(_) => "boolean",
            Value::Number(_) => "number",
            Value::String(_) => "string",
            Value::Object(_) => unreachable!(),
        };
        return Err(format!(
            "Pipeline graph invalid — body: Invalid input: expected object, received {kind}"
        ));
    };
    for field in ["nodes", "edges"] {
        match obj.get(field) {
            None => {
                return Err(format!(
                    "Pipeline graph invalid — {field}: Invalid input: expected array, received undefined"
                ))
            }
            Some(Value::Array(items)) => {
                // z.array(z.record(z.string(), z.unknown())) — every entry an object
                for (i, item) in items.iter().enumerate() {
                    if !item.is_object() {
                        let kind = match item {
                            Value::Array(_) => "array",
                            Value::Null => "null",
                            Value::Bool(_) => "boolean",
                            Value::Number(_) => "number",
                            Value::String(_) => "string",
                            Value::Object(_) => unreachable!(),
                        };
                        return Err(format!(
                            "Pipeline graph invalid — {field}.{i}: Invalid input: expected object, received {kind}"
                        ));
                    }
                }
            }
            Some(other) => {
                let kind = match other {
                    Value::Null => "null",
                    Value::Bool(_) => "boolean",
                    Value::Number(_) => "number",
                    Value::String(_) => "string",
                    Value::Object(_) => "object",
                    Value::Array(_) => unreachable!(),
                };
                return Err(format!(
                    "Pipeline graph invalid — {field}: Invalid input: expected array, received {kind}"
                ));
            }
        }
    }
    Ok(obj.get("nodes").and_then(|n| n.as_array()).map(|a| a.len()).unwrap_or(0))
}

/// Newest version of a pipeline, or None when none exist yet.
pub async fn latest_version(
    state: &AppState,
    pipeline_id: &str,
) -> Result<Option<PipelineVersionRow>, sqlx::Error> {
    sqlx::query_as(&format!(
        "SELECT {VERSION_COLS} FROM pipeline_versions WHERE pipeline_id = $1 ORDER BY version_number DESC LIMIT 1"
    ))
    .bind(pipeline_id)
    .fetch_optional(&state.db)
    .await
}

/// Version number of the newest version, or None when the pipeline has none.
pub async fn latest_version_number(
    state: &AppState,
    pipeline_id: &str,
) -> Result<Option<i32>, sqlx::Error> {
    let row: Option<(Option<i32>,)> = sqlx::query_as(
        "SELECT version_number FROM pipeline_versions WHERE pipeline_id = $1 ORDER BY version_number DESC LIMIT 1",
    )
    .bind(pipeline_id)
    .fetch_optional(&state.db)
    .await?;
    Ok(row.and_then(|(v,)| v))
}

/// Lazily backfill: when the pipeline has zero versions, snapshot its CURRENT
/// graph as v1 (createdBy 'backfill'). Returns the LATEST version.
/// Errors: `Pipeline '<id>' not found` when the pipeline row is missing.
pub async fn ensure_pipeline_version(
    state: &AppState,
    pipeline_id: &str,
) -> Result<PipelineVersionRow, String> {
    if let Some(latest) = latest_version(state, pipeline_id).await.map_err(|e| e.to_string())? {
        return Ok(latest);
    }
    let pipeline: Option<(Json<Value>,)> =
        sqlx::query_as("SELECT graph_json FROM pipelines WHERE id = $1")
            .bind(pipeline_id)
            .fetch_optional(&state.db)
            .await
            .map_err(|e| e.to_string())?;
    let Some((graph,)) = pipeline else {
        return Err(format!("Pipeline '{pipeline_id}' not found"));
    };
    snapshot_pipeline_version(state, pipeline_id, &graph.0, None, Some("backfill")).await
}

/// Snapshot a graph as the next version (max versionNumber + 1), then prune to
/// KEEP_LAST_N. Errors carry the assert_valid_graph messages.
pub async fn snapshot_pipeline_version(
    state: &AppState,
    pipeline_id: &str,
    graph: &Value,
    note: Option<&str>,
    created_by: Option<&str>,
) -> Result<PipelineVersionRow, String> {
    let node_count = assert_valid_graph(graph)?;
    // Unique (pipeline_id, version_number): a concurrent snapshot race is
    // resolved by re-reading the winner's row (last writer appends the next).
    for _attempt in 0..3 {
        let prev = latest_version_number(state, pipeline_id).await.map_err(|e| e.to_string())?;
        let next = prev.unwrap_or(0) + 1;
        let id = mf_db::new_id();
        let result = sqlx::query_as(&format!(
            "INSERT INTO pipeline_versions (id, pipeline_id, version_number, graph_json, node_count, note, created_by) \
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING {VERSION_COLS}"
        ))
        .bind(&id)
        .bind(pipeline_id)
        .bind(next)
        .bind(Json(graph))
        .bind(node_count as i32)
        .bind(note)
        .bind(created_by)
        .fetch_optional(&state.db)
        .await;
        match result {
            Ok(Some(row)) => {
                let _ = prune_pipeline_versions(state, pipeline_id, KEEP_LAST_N).await;
                return Ok(row);
            }
            Ok(None) => continue,
            Err(sqlx::Error::Database(db_err)) if db_err.is_unique_violation() => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("Failed to snapshot pipeline version (concurrent writers)".to_string())
}

/// One specific snapshot, or None when the pipeline/version combination is unknown.
pub async fn get_pipeline_version(
    state: &AppState,
    pipeline_id: &str,
    version_number: i32,
) -> Result<Option<PipelineVersionRow>, sqlx::Error> {
    sqlx::query_as(&format!(
        "SELECT {VERSION_COLS} FROM pipeline_versions WHERE pipeline_id = $1 AND version_number = $2"
    ))
    .bind(pipeline_id)
    .bind(version_number)
    .fetch_optional(&state.db)
    .await
}

/// M3.1 retention: keep only the newest `keep_last_n` versions (lowest
/// versionNumbers are deleted). keep_last_n <= 0 means unlimited.
pub async fn prune_pipeline_versions(
    state: &AppState,
    pipeline_id: &str,
    keep_last_n: i64,
) -> Result<u64, sqlx::Error> {
    if keep_last_n <= 0 {
        return Ok(0);
    }
    let result = sqlx::query(
        "DELETE FROM pipeline_versions WHERE pipeline_id = $1 AND id NOT IN ( \
           SELECT id FROM pipeline_versions WHERE pipeline_id = $1 ORDER BY version_number DESC LIMIT $2 \
         )",
    )
    .bind(pipeline_id)
    .bind(keep_last_n)
    .execute(&state.db)
    .await?;
    Ok(result.rows_affected())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn valid_graph_node_count() {
        assert_eq!(
            assert_valid_graph(&json!({"nodes": [{"id": "a"}, {"id": "b"}], "edges": []})).unwrap(),
            2
        );
        assert_eq!(assert_valid_graph(&json!({"nodes": [], "edges": []})).unwrap(), 0);
    }

    #[test]
    fn invalid_graph_messages() {
        assert_eq!(
            assert_valid_graph(&json!("nope")).unwrap_err(),
            "Pipeline graph invalid — body: Invalid input: expected object, received string"
        );
        assert_eq!(
            assert_valid_graph(&json!({"edges": []})).unwrap_err(),
            "Pipeline graph invalid — nodes: Invalid input: expected array, received undefined"
        );
        assert_eq!(
            assert_valid_graph(&json!({"nodes": [], "edges": 5})).unwrap_err(),
            "Pipeline graph invalid — edges: Invalid input: expected array, received number"
        );
        assert_eq!(
            assert_valid_graph(&json!({"nodes": [{"id": "a"}, 7], "edges": []})).unwrap_err(),
            "Pipeline graph invalid — nodes.1: Invalid input: expected object, received number"
        );
    }
}
