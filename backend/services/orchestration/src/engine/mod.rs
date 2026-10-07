//! Pipeline execution engine — port of `src/lib/engine.ts`.
//!
//! Executes a pipeline graph: topological order, rows streamed in memory
//! between nodes, the output dataset version written through the catalog
//! internal API, and a RunManifest (pinned graph version, exact input
//! versions, outputs, node fingerprints incl. sha256 of derive expressions)
//! captured for reproducible builds/replay.
//!
//! Architecture deviation (documented): the legacy monolith wrote dataset
//! versions + lineage rows directly; here the output node calls catalog's
//! `POST /internal/datasets/{id}/versions` (idempotent via `outputJobId` —
//! the legacy crash-recovery guarantee) and catalog owns lineage edges,
//! quality auto-evaluation and the `mf.dataset.version.created` event.

pub mod nodes;

use std::collections::{HashMap, HashSet, VecDeque};
use std::time::Instant;

use chrono::Utc;
use mf_types::LogEntry;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sqlx::types::Json;

use crate::catalog::{internal_error_message, is_not_found, CatalogClient};
use crate::state::AppState;
use nodes::{GraphNode, PipelineError, Row};

// ─── Constants (copied EXACTLY from engine.ts) ─────────────────────────

/// Max downstream pipelines triggered per successful run.
pub const CASCADE_MAX_CHILDREN: usize = 5;
/// Max cascade depth (manual run = 0 → children at 1 → grandchildren at 2 → stop).
pub const CASCADE_MAX_DEPTH: i32 = 2;
/// A 'running' run older than this is stale (crashed worker) and no longer blocks.
pub const RUNNING_STALE_MS: i64 = 10 * 60 * 1000;
pub const PIPELINE_BUSY_MESSAGE: &str = "Run skipped: another run is already in progress";
/// Legacy dataset-service MAX_ROWS (env-overridable) — output versions fail
/// explicitly rather than silently discarding rows.
pub fn storage_max_rows() -> usize {
    std::env::var("MAX_ROWS")
        .ok()
        .and_then(|v| v.trim().parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(5000)
}

const KNOWN_NODE_TYPES: [&str; 12] = [
    "source", "filter", "derive", "select", "rename", "join", "aggregate", "sort", "dedupe",
    "union", "limit", "output",
];

// ─── Graph types ────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct GraphEdge {
    pub id: String,
    pub source: String,
    pub target: String,
    pub target_handle: Option<String>,
}

#[derive(Debug, Clone)]
pub struct PipelineGraph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

// ─── Run manifest (Phase 1: reproducible builds) ───────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestInput {
    pub dataset_id: String,
    pub dataset_name: String,
    /// Exact version this run read (null only when the dataset had no versions).
    pub version_number: Option<i64>,
    pub row_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestOutput {
    pub dataset_id: String,
    pub dataset_name: String,
    pub version_number: i64,
    pub row_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestNode {
    pub node_id: String,
    #[serde(rename = "type")]
    pub node_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// sha256 of inline code (derive nodes) — confirms the exact logic identity.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code_sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphVersionRef {
    pub version_number: Option<i32>,
    pub node_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunManifest {
    pub graph_version: GraphVersionRef,
    pub inputs: Vec<ManifestInput>,
    pub outputs: Vec<ManifestOutput>,
    pub nodes: Vec<ManifestNode>,
}

#[derive(Debug, Default)]
struct ManifestCapture {
    inputs: Vec<ManifestInput>,
    outputs: Vec<ManifestOutput>,
    nodes: Vec<ManifestNode>,
}

#[derive(Debug, Clone)]
pub struct ExecuteResult {
    pub output_dataset_id: String,
    pub output_name: String,
    pub output_version_number: i64,
    pub output_row_count: i64,
}

// ─── Execution context ──────────────────────────────────────────────────

struct ExecContext<'a> {
    pipeline_id: &'a str,
    run_id: &'a str,
    graph_version_number: Option<i32>,
    output_job_id: Option<&'a str>,
    pipeline_name: &'a str,
    source_dataset_ids: Vec<String>,
    log: Vec<LogEntry>,
    output_result: Option<ExecuteResult>,
    /// Replay pin: datasetId → exact versionNumber to read instead of the head.
    input_overrides: &'a HashMap<String, i64>,
    capture: ManifestCapture,
    cascade_depth: i32,
    state: &'a AppState,
}

impl<'a> ExecContext<'a> {
    fn info(&mut self, msg: impl Into<String>) {
        self.log.push(LogEntry::info(msg));
    }
    fn warn(&mut self, msg: impl Into<String>) {
        self.log.push(LogEntry::warn(msg));
    }
    fn error(&mut self, msg: impl Into<String>) {
        self.log.push(LogEntry::error(msg));
    }
    fn success(&mut self, msg: impl Into<String>) {
        self.log.push(LogEntry::success(msg));
    }
}

// ─── Public entry point (port of runPipeline) ───────────────────────────

#[derive(Debug, Clone, Default)]
pub struct RunPipelineOptions {
    /// Unique job identity enforced on the output version for crash recovery.
    pub output_job_id: Option<String>,
    /// Cascade depth: manual runs = 0, cascaded runs = parent + 1.
    pub cascade_depth: i32,
    /// Graph to execute INSTEAD of pipeline.graph_json (pinned version snapshot).
    pub graph_override: Option<Value>,
    /// Version number written on the created run row.
    pub version_number: Option<i32>,
    /// Pipeline ids already visited in the current cascade chain (loop guard).
    pub chain: HashSet<String>,
    /// manual | schedule | upstream | retry | replay | cascade
    pub trigger: String,
    pub attempt: i32,
    /// Replay pin: datasetId → exact versionNumber each source node must read.
    pub input_overrides: HashMap<String, i64>,
    pub replay_of_run_id: Option<String>,
}

/// The run row as persisted (subset used by job processing).
#[derive(Debug, sqlx::FromRow)]
#[allow(dead_code)] // full record mirror; job processing reads status/failure_cause
pub struct RunRecord {
    pub id: String,
    pub status: String,
    pub failure_cause: Option<String>,
    pub output_dataset_id: Option<String>,
    pub output_version_number: Option<i32>,
}

const RUN_RECORD_COLS: &str =
    "id, status, failure_cause, output_dataset_id, output_version_number";

/// Execute a pipeline end-to-end and return the final run record. The run is
/// created up-front (status 'running') and updated to success/failed. Errors
/// only escape when the pipeline row itself is missing/unreadable (no run
/// record possible) — graph/runtime failures land in `failure_cause`.
pub async fn run_pipeline(
    state: &AppState,
    pipeline_id: &str,
    opts: RunPipelineOptions,
) -> Result<RunRecord, anyhow::Error> {
    let mut chain = opts.chain.clone();
    chain.insert(pipeline_id.to_string());

    #[derive(sqlx::FromRow)]
    struct PipelineBasic {
        name: String,
        graph_json: Json<Value>,
    }
    let pipeline: Option<PipelineBasic> =
        sqlx::query_as("SELECT name, graph_json FROM pipelines WHERE id = $1")
            .bind(pipeline_id)
            .fetch_optional(&state.db)
            .await?;
    let Some(pipeline) = pipeline else {
        return Err(anyhow::anyhow!(
            "{}",
            PipelineError(format!("Pipeline {pipeline_id} not found")).0
        ));
    };

    // Concurrency guard: only one in-flight run per pipeline (prevents
    // scheduler overlap pile-ups); stale 'running' rows no longer block.
    let stale_cutoff = Utc::now() - chrono::Duration::milliseconds(RUNNING_STALE_MS);
    let active: Option<(String,)> = sqlx::query_as(
        "SELECT id FROM pipeline_runs WHERE pipeline_id = $1 AND status = 'running' AND started_at > $2 LIMIT 1",
    )
    .bind(pipeline_id)
    .bind(stale_cutoff)
    .fetch_optional(&state.db)
    .await?;
    if active.is_some() {
        let now = Utc::now();
        let busy_manifest = RunManifest {
            graph_version: GraphVersionRef { version_number: opts.version_number, node_count: 0 },
            inputs: vec![],
            outputs: vec![],
            nodes: vec![],
        };
        let busy_logs = vec![LogEntry {
            ts: mf_types::ts::format(&now),
            level: mf_types::LogLevel::Error,
            msg: PIPELINE_BUSY_MESSAGE.to_string(),
        }];
        let skipped: RunRecord = sqlx::query_as(&format!(
            "INSERT INTO pipeline_runs (id, pipeline_id, status, finished_at, version_number, \"trigger\", attempt, duration_ms, failure_cause, replayed_from_run_id, manifest_json, logs_json) \
             VALUES ($1, $2, 'failed', $3, $4, $5, $6, 0, $7, $8, $9, $10) RETURNING {RUN_RECORD_COLS}"
        ))
        .bind(mf_db::new_id())
        .bind(pipeline_id)
        .bind(now)
        .bind(opts.version_number)
        .bind(if opts.trigger.is_empty() { "manual" } else { opts.trigger.as_str() })
        .bind(if opts.attempt == 0 { 1 } else { opts.attempt })
        .bind(PIPELINE_BUSY_MESSAGE)
        .bind(opts.replay_of_run_id.clone())
        .bind(Json(serde_json::to_value(&busy_manifest).unwrap_or(Value::Null)))
        .bind(Json(serde_json::to_value(&busy_logs).unwrap_or(Value::Array(vec![]))))
        .fetch_one(&state.db)
        .await?;
        return Ok(skipped);
    }

    let run_id = mf_db::new_id();
    sqlx::query(
        "INSERT INTO pipeline_runs (id, pipeline_id, status, logs_json, version_number, \"trigger\", attempt, replayed_from_run_id) \
         VALUES ($1, $2, 'running', '[]'::jsonb, $3, $4, $5, $6)",
    )
    .bind(&run_id)
    .bind(pipeline_id)
    .bind(opts.version_number)
    .bind(if opts.trigger.is_empty() { "manual" } else { opts.trigger.as_str() })
    .bind(if opts.attempt == 0 { 1 } else { opts.attempt })
    .bind(opts.replay_of_run_id.clone())
    .execute(&state.db)
    .await?;

    let started_at_ms = Instant::now();
    let mut ctx = ExecContext {
        pipeline_id,
        run_id: &run_id,
        graph_version_number: opts.version_number,
        output_job_id: opts.output_job_id.as_deref(),
        pipeline_name: &pipeline.name,
        source_dataset_ids: vec![],
        log: Vec::new(),
        output_result: None,
        input_overrides: &opts.input_overrides,
        capture: ManifestCapture::default(),
        cascade_depth: opts.cascade_depth,
        state,
    };

    let graph_value = opts.graph_override.clone().unwrap_or(pipeline.graph_json.0.clone());
    let mut failure_msg: Option<String> = None;
    let mut result: Option<ExecuteResult> = None;
    match execute_graph(&mut ctx, &graph_value).await {
        Ok(res) => {
            let elapsed = started_at_ms.elapsed().as_millis() as i64;
            ctx.success(format!(
                "Pipeline '{}' completed in {elapsed}ms — output dataset '{}' (v{}, {} rows)",
                pipeline.name, res.output_name, res.output_version_number, res.output_row_count
            ));
            result = Some(res);
        }
        Err(e) => {
            failure_msg = Some(e.0.clone());
            ctx.error(format!("Pipeline failed: {}", e.0));
        }
    }
    let duration_ms = started_at_ms.elapsed().as_millis() as i64;

    // The run manifest — written for success AND failed runs (a partial
    // manifest is still the best diagnostic record we can keep).
    let manifest = RunManifest {
        graph_version: GraphVersionRef {
            version_number: opts.version_number,
            node_count: ctx.capture.nodes.len(),
        },
        inputs: std::mem::take(&mut ctx.capture.inputs),
        outputs: std::mem::take(&mut ctx.capture.outputs),
        nodes: std::mem::take(&mut ctx.capture.nodes),
    };

    let finished_at = Utc::now();
    let final_run: RunRecord = sqlx::query_as(&format!(
        "UPDATE pipeline_runs SET status = $1, finished_at = $2, logs_json = $3, manifest_json = $4, \
         duration_ms = $5, failure_cause = $6, output_dataset_id = $7, output_version_number = $8 \
         WHERE id = $9 RETURNING {RUN_RECORD_COLS}"
    ))
    .bind(if result.is_some() { "success" } else { "failed" })
    .bind(finished_at)
    .bind(Json(serde_json::to_value(&ctx.log).unwrap_or(Value::Array(vec![]))))
    .bind(Json(serde_json::to_value(&manifest).unwrap_or(Value::Null)))
    .bind(duration_ms as i32)
    .bind(failure_msg.clone())
    .bind(result.as_ref().map(|r| r.output_dataset_id.clone()))
    .bind(result.as_ref().map(|r| r.output_version_number as i32))
    .bind(&run_id)
    .fetch_one(&state.db)
    .await?;

    // Cascade: trigger downstream pipelines that consume this run's output
    // dataset. A failing cascade never fails the parent run.
    if let Some(res) = &result {
        trigger_cascades(
            state,
            pipeline_id,
            &run_id,
            &res.output_dataset_id,
            opts.cascade_depth,
            &mut chain,
            &mut ctx.log,
        )
        .await;
        // Flush cascade log lines appended after finalization (legacy persistLogs).
        let _ = sqlx::query("UPDATE pipeline_runs SET logs_json = $1 WHERE id = $2")
            .bind(Json(serde_json::to_value(&ctx.log).unwrap_or(Value::Array(vec![]))))
            .bind(&run_id)
            .execute(&state.db)
            .await;
    }

    // Re-read so the returned record reflects any post-finalize updates.
    let fresh: Option<RunRecord> =
        sqlx::query_as(&format!("SELECT {RUN_RECORD_COLS} FROM pipeline_runs WHERE id = $1"))
            .bind(&run_id)
            .fetch_optional(&state.db)
            .await?;
    Ok(fresh.unwrap_or(final_run))
}

// ─── Cascade orchestration (port of triggerCascades) ────────────────────

async fn trigger_cascades(
    state: &AppState,
    parent_pipeline_id: &str,
    parent_run_id: &str,
    output_dataset_id: &str,
    cascade_depth: i32,
    chain: &mut HashSet<String>,
    log: &mut Vec<LogEntry>,
) {
    if cascade_depth >= CASCADE_MAX_DEPTH {
        return;
    }

    #[derive(sqlx::FromRow)]
    struct Candidate {
        id: String,
        name: String,
        graph_json: Json<Value>,
    }
    let candidates: Vec<Candidate> = match sqlx::query_as::<_, Candidate>(
        "SELECT id, name, graph_json FROM pipelines WHERE id <> $1 ORDER BY created_at ASC",
    )
    .bind(parent_pipeline_id)
    .fetch_all(&state.db)
    .await
    {
        Ok(rows) => rows
            .into_iter()
            .filter(|p| graph_sources_include_dataset(&p.graph_json.0, output_dataset_id))
            .take(CASCADE_MAX_CHILDREN)
            .collect(),
        Err(e) => {
            log.push(LogEntry::warn(format!(
                "cascade: failed to look up downstream pipelines — {e}"
            )));
            persist_cascade_logs(state, parent_run_id, log).await;
            return;
        }
    };

    for child in candidates {
        if chain.contains(&child.id) {
            log.push(LogEntry::info(format!(
                "cascade: skipped '{}' (already in chain)",
                child.name
            )));
            persist_cascade_logs(state, parent_run_id, log).await;
            continue;
        }
        log.push(LogEntry::info(format!(
            "cascade: queued '{}' (depth {})",
            child.name,
            cascade_depth + 1
        )));
        persist_cascade_logs(state, parent_run_id, log).await;
        chain.insert(child.id.clone());

        let event_key = format!(
            "cascade:{}:{}:{}:{}",
            child.id,
            output_dataset_id,
            cascade_depth + 1,
            Utc::now().timestamp_millis()
        );
        let payload = serde_json::json!({
            "parentRunId": parent_run_id,
            "cascadeDepth": cascade_depth + 1,
        });
        match crate::jobs::enqueue_pipeline_job(
            state,
            &child.id,
            crate::jobs::EnqueueOptions {
                trigger: "cascade",
                event_key,
                schedule_id: None,
                max_attempts: None,
                graph_version_number: None,
                payload,
            },
        )
        .await
        {
            Ok(_) => {
                log.push(LogEntry::info(format!(
                    "cascade: '{}' enqueued as durable job",
                    child.name
                )));
            }
            Err(e) => {
                log.push(LogEntry::error(format!(
                    "cascade: '{}' failed to enqueue — {e}",
                    child.name
                )));
            }
        }
        persist_cascade_logs(state, parent_run_id, log).await;
    }
}

async fn persist_cascade_logs(state: &AppState, run_id: &str, log: &[LogEntry]) {
    let _ = sqlx::query("UPDATE pipeline_runs SET logs_json = $1 WHERE id = $2")
        .bind(Json(serde_json::to_value(log).unwrap_or(Value::Array(vec![]))))
        .bind(run_id)
        .execute(&state.db)
        .await;
}

/// True when any source node in a pipeline's graph references the dataset id.
pub fn graph_sources_include_dataset(graph: &Value, dataset_id: &str) -> bool {
    let Some(nodes) = graph.get("nodes").and_then(|n| n.as_array()) else {
        return false;
    };
    nodes.iter().any(|n| {
        n.get("type").and_then(|t| t.as_str()) == Some("source")
            && n.get("data")
                .and_then(|d| d.get("datasetId"))
                .and_then(|d| d.as_str())
                == Some(dataset_id)
    })
}

// ─── Graph orchestration ────────────────────────────────────────────────

async fn execute_graph(
    ctx: &mut ExecContext<'_>,
    graph_value: &Value,
) -> Result<ExecuteResult, PipelineError> {
    let graph = parse_graph(graph_value)?;
    ctx.info(format!(
        "Pipeline '{}' run started (graph: {} nodes, {} edges)",
        ctx.pipeline_name,
        graph.nodes.len(),
        graph.edges.len()
    ));

    validate_graph(&graph)?;
    let order = topo_sort(&graph)?;

    // Distinct dataset ids referenced by source nodes (lineage fan-out).
    let mut seen = HashSet::new();
    ctx.source_dataset_ids = graph
        .nodes
        .iter()
        .filter(|n| n.node_type == "source")
        .filter_map(|n| n.data.get("datasetId").and_then(|d| d.as_str()))
        .filter(|d| seen.insert(d.to_string()))
        .map(|d| d.to_string())
        .collect();

    let mut outputs: HashMap<String, Vec<Row>> = HashMap::new();
    let mut result: Option<ExecuteResult> = None;

    for node in &order {
        // Phase 1: fingerprint every executed node — type, display label, and
        // the sha256 of any inline logic (derive stores it in `expression`).
        let label = node
            .data
            .get("name")
            .and_then(|v| v.as_str())
            .or_else(|| node.data.get("label").and_then(|v| v.as_str()))
            .map(|s| s.to_string());
        let inline_code = node
            .data
            .get("code")
            .and_then(|v| v.as_str())
            .or_else(|| node.data.get("expression").and_then(|v| v.as_str()))
            .map(|s| s.to_string());
        ctx.capture.nodes.push(ManifestNode {
            node_id: node.id.clone(),
            node_type: node.node_type.clone(),
            label,
            code_sha256: inline_code.map(|code| {
                use sha2::{Digest, Sha256};
                hex::encode(Sha256::digest(code.as_bytes()))
            }),
        });

        // Inputs: edges into this node, upper handle ('in-1' last — legacy
        // sorts Number(a==='in-1') - Number(b==='in-1') ascending, stable).
        let mut in_edges: Vec<&GraphEdge> =
            graph.edges.iter().filter(|e| e.target == node.id).collect();
        in_edges.sort_by_key(|e| if e.target_handle.as_deref() == Some("in-1") { 1 } else { 0 });
        let mut inputs: Vec<Vec<Row>> = Vec::with_capacity(in_edges.len());
        for e in in_edges {
            match outputs.get(&e.source) {
                Some(rows) => inputs.push(rows.clone()),
                None => {
                    return Err(PipelineError(format!(
                        "Internal error: input from node '{}' was not computed before '{}'",
                        e.source, node.id
                    )))
                }
            }
        }

        let in_count: usize = inputs.iter().map(|r| r.len()).sum();
        let out = exec_node(node, &inputs, ctx).await?;
        let out_len = out.len();
        outputs.insert(node.id.clone(), out);
        ctx.info(format!(
            "node {} ({}): {in_count} rows in -> {out_len} rows out",
            node.node_type, node.id
        ));
        if node.node_type == "output" {
            let Some(res) = ctx.output_result.clone() else {
                return Err(PipelineError("output node did not produce a result".into()));
            };
            result = Some(res);
        }
    }

    result.ok_or_else(|| PipelineError("Pipeline did not produce an output dataset".into()))
}

/// parseGraph — lenient coercion exactly like the legacy function.
pub fn parse_graph(value: &Value) -> Result<PipelineGraph, PipelineError> {
    match value {
        Value::Object(_) | Value::Array(_) => {}
        _ => return Err(PipelineError("Pipeline graph is not valid JSON".into())),
    }
    let (nodes_val, edges_val) = (value.get("nodes"), value.get("edges"));
    let (Some(nodes_arr), Some(edges_arr)) = (
        nodes_val.and_then(|n| n.as_array()),
        edges_val.and_then(|n| n.as_array()),
    ) else {
        return Err(PipelineError(
            "Pipeline graph must contain \"nodes\" and \"edges\" arrays".into(),
        ));
    };

    let mut nodes = Vec::with_capacity(nodes_arr.len());
    for (i, n) in nodes_arr.iter().enumerate() {
        let id = n
            .get("id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("node-{i}"));
        let node_type = match n.get("type") {
            Some(Value::String(s)) => s.clone(),
            Some(other) => loose_string_of(other),
            None => String::new(),
        };
        let data = match n.get("data") {
            Some(Value::Object(m)) => m.clone(),
            _ => Map::new(),
        };
        nodes.push(GraphNode { id, node_type, data });
    }

    let mut edges = Vec::new();
    let filtered: Vec<&Value> = edges_arr
        .iter()
        .filter(|e| {
            e.get("source").and_then(|s| s.as_str()).is_some()
                && e.get("target").and_then(|t| t.as_str()).is_some()
        })
        .collect();
    for (i, e) in filtered.iter().enumerate() {
        edges.push(GraphEdge {
            id: e
                .get("id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("edge-{i}")),
            source: e.get("source").and_then(|s| s.as_str()).unwrap_or("").to_string(),
            target: e.get("target").and_then(|s| s.as_str()).unwrap_or("").to_string(),
            target_handle: e.get("targetHandle").and_then(|h| h.as_str()).map(|s| s.to_string()),
        });
    }
    Ok(PipelineGraph { nodes, edges })
}

/// JS `String(v)` coercion for non-string node types (parseGraph fallback).
fn loose_string_of(v: &Value) -> String {
    match v {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(_) => crate::values::js_string_of(v),
        Value::String(s) => s.clone(),
        Value::Array(_) => String::new(), // String([]) === ""
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// validateGraph — exact legacy error messages.
pub fn validate_graph(graph: &PipelineGraph) -> Result<(), PipelineError> {
    if graph.nodes.is_empty() {
        return Err(PipelineError("Pipeline graph has no nodes".into()));
    }
    let mut ids: HashSet<String> = HashSet::new();
    for node in &graph.nodes {
        if node.id.is_empty() {
            return Err(PipelineError("A node is missing an id".into()));
        }
        if !ids.insert(node.id.clone()) {
            return Err(PipelineError(format!("Duplicate node id '{}'", node.id)));
        }
        if !KNOWN_NODE_TYPES.contains(&node.node_type.as_str()) {
            return Err(PipelineError(format!(
                "Unknown node type '{}' (node '{}')",
                node.node_type, node.id
            )));
        }
    }
    for edge in &graph.edges {
        if !ids.contains(&edge.source) {
            return Err(PipelineError(format!(
                "Edge '{}' references unknown source node '{}'",
                edge.id, edge.source
            )));
        }
        if !ids.contains(&edge.target) {
            return Err(PipelineError(format!(
                "Edge '{}' references unknown target node '{}'",
                edge.id, edge.target
            )));
        }
    }
    let output_nodes = graph.nodes.iter().filter(|n| n.node_type == "output").count();
    if output_nodes != 1 {
        return Err(PipelineError(format!(
            "Pipeline must have exactly one output node (found {output_nodes})"
        )));
    }
    let mut in_degree: HashMap<&str, usize> = HashMap::new();
    for node in &graph.nodes {
        in_degree.insert(node.id.as_str(), 0);
    }
    for edge in &graph.edges {
        *in_degree.entry(edge.target.as_str()).or_insert(0) += 1;
    }
    for node in &graph.nodes {
        let n = in_degree.get(node.id.as_str()).copied().unwrap_or(0);
        if node.node_type == "source" {
            if n > 0 {
                return Err(PipelineError(format!(
                    "source node '{}' must not have incoming edges",
                    node.id
                )));
            }
        } else if node.node_type == "join" || node.node_type == "union" {
            if n != 2 {
                return Err(PipelineError(format!(
                    "{} node '{}' requires exactly 2 inputs (found {n})",
                    node.node_type, node.id
                )));
            }
        } else if n != 1 {
            return Err(PipelineError(format!(
                "{} node '{}' requires exactly 1 input (found {n})",
                node.node_type, node.id
            )));
        }
    }
    Ok(())
}

/// Kahn's algorithm; throws on cycles. Returns nodes in execution order.
pub fn topo_sort(graph: &PipelineGraph) -> Result<Vec<GraphNode>, PipelineError> {
    let by_id: HashMap<&str, &GraphNode> =
        graph.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let mut in_degree: HashMap<&str, usize> = HashMap::new();
    let mut adjacency: HashMap<&str, Vec<&str>> = HashMap::new();
    for node in &graph.nodes {
        in_degree.insert(node.id.as_str(), 0);
        adjacency.insert(node.id.as_str(), Vec::new());
    }
    for edge in &graph.edges {
        adjacency.entry(edge.source.as_str()).or_default().push(edge.target.as_str());
        *in_degree.entry(edge.target.as_str()).or_insert(0) += 1;
    }
    let mut queue: VecDeque<&str> = graph
        .nodes
        .iter()
        .filter(|n| in_degree.get(n.id.as_str()).copied().unwrap_or(0) == 0)
        .map(|n| n.id.as_str())
        .collect();
    let mut order: Vec<&str> = Vec::new();
    while let Some(id) = queue.pop_front() {
        order.push(id);
        for target in adjacency.get(id).cloned().unwrap_or_default() {
            let next = in_degree.get(target).copied().unwrap_or(0) - 1;
            in_degree.insert(target, next);
            if next == 0 {
                queue.push_back(target);
            }
        }
    }
    if order.len() != graph.nodes.len() {
        let in_order: HashSet<&str> = order.iter().copied().collect();
        let cyclic: Vec<&str> = graph
            .nodes
            .iter()
            .map(|n| n.id.as_str())
            .filter(|id| !in_order.contains(id))
            .collect();
        return Err(PipelineError(format!(
            "Pipeline graph contains a cycle involving nodes: {}",
            cyclic.join(", ")
        )));
    }
    Ok(order.iter().map(|id| (*by_id.get(id).expect("node")).clone()).collect())
}

// ─── Node dispatch ──────────────────────────────────────────────────────

async fn exec_node(
    node: &GraphNode,
    inputs: &[Vec<Row>],
    ctx: &mut ExecContext<'_>,
) -> Result<Vec<Row>, PipelineError> {
    match node.node_type.as_str() {
        "source" => exec_source(node, ctx).await,
        "filter" => nodes::exec_filter(node, nodes::single_input(node, inputs)?),
        "derive" => {
            let (out, failed) = nodes::exec_derive(node, nodes::single_input(node, inputs)?)?;
            if failed > 0 {
                let expression = node
                    .data
                    .get("expression")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                ctx.warn(format!(
                    "derive ({}): {failed} row(s) failed to evaluate '{expression}' — set to null",
                    node.id
                ));
            }
            Ok(out)
        }
        "select" => nodes::exec_select(node, nodes::single_input(node, inputs)?),
        "rename" => nodes::exec_rename(node, nodes::single_input(node, inputs)?),
        "join" => nodes::exec_join(node, inputs),
        "aggregate" => nodes::exec_aggregate(node, nodes::single_input(node, inputs)?),
        "sort" => nodes::exec_sort(node, nodes::single_input(node, inputs)?),
        "dedupe" => nodes::exec_dedupe(node, nodes::single_input(node, inputs)?),
        "union" => nodes::exec_union(node, inputs),
        "limit" => nodes::exec_limit(node, nodes::single_input(node, inputs)?),
        "output" => exec_output(node, nodes::single_input(node, inputs)?, ctx).await,
        _ => Err(PipelineError(format!(
            "Unknown node type '{}' (node '{}')",
            node.node_type, node.id
        ))),
    }
}

// ─── source node (catalog reads) ────────────────────────────────────────

async fn exec_source(
    node: &GraphNode,
    ctx: &mut ExecContext<'_>,
) -> Result<Vec<Row>, PipelineError> {
    let dataset_id = nodes::require_string(node, "datasetId")?;
    let catalog: &CatalogClient = &ctx.state.catalog;

    // Dataset display name (manifest + log labels).
    let detail = catalog.dataset_detail(&dataset_id).await.map_err(|e| {
        if is_not_found(&e) {
            PipelineError(format!("Source dataset '{dataset_id}' not found"))
        } else {
            PipelineError(internal_error_message(&e))
        }
    })?;
    let dataset_name = detail
        .get("dataset")
        .and_then(|d| d.get("name"))
        .and_then(|n| n.as_str())
        .or_else(|| detail.get("name").and_then(|n| n.as_str()))
        .unwrap_or(&dataset_id)
        .to_string();

    // Phase 1: a replay pins the EXACT version this node must read; a normal
    // run resolves the consumer version (gate-aware) inside catalog via head.
    let pinned = ctx.input_overrides.get(&dataset_id).copied();
    let spec = match pinned {
        Some(n) => n.to_string(),
        None => "head".to_string(),
    };
    match catalog.rows_all(&dataset_id, &spec).await {
        Ok(source) => {
            if pinned.is_some() && source.version_number.is_none() && source.rows.is_empty() {
                // Pinned version vanished (retention/reset) — legacy error.
                return Err(PipelineError(format!(
                    "Replay pinned dataset '{dataset_name}' at v{}, but that version no longer exists (removed by retention or workspace reset)",
                    pinned.unwrap_or_default()
                )));
            }
            if pinned.is_none() && source.version_number.is_none() {
                ctx.capture.inputs.push(ManifestInput {
                    dataset_id: dataset_id.clone(),
                    dataset_name: dataset_name.clone(),
                    version_number: None,
                    row_count: 0,
                });
                ctx.warn(format!(
                    "source ({}): dataset '{dataset_name}' has no published version — 0 rows loaded",
                    node.id
                ));
                return Ok(vec![]);
            }
            let version_number = source.version_number.unwrap_or_else(|| pinned.unwrap_or(0));
            let row_count = source.rows.len() as i64;
            ctx.capture.inputs.push(ManifestInput {
                dataset_id: dataset_id.clone(),
                dataset_name: dataset_name.clone(),
                version_number: Some(version_number),
                row_count,
            });
            ctx.info(format!(
                "source ({}): loaded dataset '{dataset_name}' v{version_number}{} ({row_count} rows)",
                node.id,
                if pinned.is_some() { " (pinned by replay)" } else { "" }
            ));
            Ok(source.rows)
        }
        Err(e) => {
            if is_not_found(&e) {
                if let Some(n) = pinned {
                    return Err(PipelineError(format!(
                        "Replay pinned dataset '{dataset_name}' at v{n}, but that version no longer exists (removed by retention or workspace reset)"
                    )));
                }
                // No consumable version — legacy warn + empty rows.
                ctx.capture.inputs.push(ManifestInput {
                    dataset_id: dataset_id.clone(),
                    dataset_name: dataset_name.clone(),
                    version_number: None,
                    row_count: 0,
                });
                ctx.warn(format!(
                    "source ({}): dataset '{dataset_name}' has no published version — 0 rows loaded",
                    node.id
                ));
                return Ok(vec![]);
            }
            Err(PipelineError(internal_error_message(&e)))
        }
    }
}

// ─── output node (catalog write) ────────────────────────────────────────

async fn exec_output(
    node: &GraphNode,
    rows: &[Row],
    ctx: &mut ExecContext<'_>,
) -> Result<Vec<Row>, PipelineError> {
    let name = nodes::require_string(node, "name")?;
    let catalog: &CatalogClient = &ctx.state.catalog;

    // Keep the input versions and node fingerprints BEFORE committing the
    // output, so a restarted worker can repair provenance (legacy behavior).
    if ctx.output_job_id.is_some() {
        let partial = RunManifest {
            graph_version: GraphVersionRef {
                version_number: ctx.graph_version_number,
                node_count: ctx.capture.nodes.len(),
            },
            inputs: ctx.capture.inputs.clone(),
            outputs: vec![],
            nodes: ctx.capture.nodes.clone(),
        };
        let _ = sqlx::query("UPDATE pipeline_runs SET manifest_json = $1 WHERE id = $2")
            .bind(Json(serde_json::to_value(&partial).unwrap_or(Value::Null)))
            .bind(ctx.run_id)
            .execute(&ctx.state.db)
            .await;
    }

    // Legacy createDatasetFromRows refuses oversized versions explicitly.
    let max_rows = storage_max_rows();
    if rows.len() > max_rows {
        return Err(PipelineError(format!(
            "Dataset version has {} rows; the current storage limit is {max_rows}. No rows were written.",
            rows.len()
        )));
    }

    // Ensure the output dataset exists (by exact name; legacy createDatasetFromRows).
    let dataset_id = match catalog.dataset_by_name(&name).await {
        Ok(v) => extract_id(&v).ok_or_else(|| {
            PipelineError(format!("Catalog returned an unusable dataset payload for '{name}'"))
        })?,
        Err(e) if is_not_found(&e) => {
            let created = catalog.create_dataset(&name, &["derived"]).await.map_err(|e2| {
                PipelineError(internal_error_message(&e2))
            })?;
            extract_id(&created).ok_or_else(|| {
                PipelineError(format!("Catalog returned an unusable dataset payload for '{name}'"))
            })?
        }
        Err(e) => return Err(PipelineError(internal_error_message(&e))),
    };

    // Version-level lineage inputs: deduped per dataset (a dataset read by two
    // source nodes contributes one edge with the version it was read at).
    let mut seen_inputs: HashSet<&str> = HashSet::new();
    let version_inputs: Vec<Value> = ctx
        .capture
        .inputs
        .iter()
        .filter(|i| i.version_number.is_some() && seen_inputs.insert(i.dataset_id.as_str()))
        .map(|i| {
            serde_json::json!({
                "datasetId": i.dataset_id,
                "versionNumber": i.version_number,
            })
        })
        .collect();

    let rows_value: Vec<Value> = rows.iter().map(|r| Value::Object(r.clone())).collect();
    let mut body = serde_json::json!({
        "rows": rows_value,
        "createdBy": ctx.run_id,
        "inputs": version_inputs,
        "runId": ctx.run_id,
        "pipelineId": ctx.pipeline_id,
        // Cascade/event context for catalog's VersionCreatedEvent emission
        // (legacy emitVersionCreated carried these; catalog may forward them).
        "source": format!("pipeline:{}", ctx.pipeline_name),
        "cascadeParentRunId": ctx.run_id,
        "cascadeDepth": ctx.cascade_depth,
    });
    if let Some(job_id) = ctx.output_job_id {
        // Idempotency key: a crashed worker re-running this job NEVER writes a
        // second output version (catalog enforces outputJobId uniqueness).
        body["outputJobId"] = Value::String(job_id.to_string());
    }

    let resp = catalog.append_version(&dataset_id, &body).await.map_err(|e| {
        PipelineError(internal_error_message(&e))
    })?;
    let version_number = resp
        .get("versionNumber")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| PipelineError("Catalog version response is missing versionNumber".into()))?;
    let row_count = resp
        .get("rowCount")
        .and_then(|v| v.as_i64())
        .unwrap_or(rows.len() as i64);

    // Lineage telemetry logs (edges themselves are written centrally by catalog).
    if !ctx.source_dataset_ids.is_empty() {
        ctx.info(format!(
            "lineage: captured {} edge(s) into dataset '{name}'",
            ctx.source_dataset_ids.len()
        ));
    }
    if !version_inputs.is_empty() {
        ctx.info(format!(
            "lineage: recorded {} version-level edge(s) feeding '{name}' v{version_number}",
            version_inputs.len()
        ));
    }
    ctx.info(format!(
        "output ({}): wrote {row_count} rows to dataset '{name}' v{version_number}",
        node.id
    ));

    ctx.output_result = Some(ExecuteResult {
        output_dataset_id: dataset_id.clone(),
        output_name: name.clone(),
        output_version_number: version_number,
        output_row_count: row_count,
    });
    ctx.capture.outputs.push(ManifestOutput {
        dataset_id,
        dataset_name: name,
        version_number,
        row_count,
    });
    Ok(rows.to_vec())
}

/// Pull an id out of a catalog dataset payload ({id} or {dataset:{id}} or summary).
fn extract_id(v: &Value) -> Option<String> {
    v.get("id")
        .and_then(|x| x.as_str())
        .or_else(|| v.get("dataset").and_then(|d| d.get("id")).and_then(|x| x.as_str()))
        .map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn graph(v: Value) -> PipelineGraph {
        parse_graph(&v).unwrap()
    }

    #[test]
    fn parse_graph_coercions() {
        let g = graph(json!({
            "nodes": [
                {"id": "s1", "type": "source", "data": {"datasetId": "d1"}},
                {"type": 42, "data": "not-an-object"},
            ],
            "edges": [
                {"source": "s1", "target": "o1"},
                {"source": "s1"},
            ],
        }));
        assert_eq!(g.nodes.len(), 2);
        assert_eq!(g.nodes[1].id, "node-1");
        assert_eq!(g.nodes[1].node_type, "42");
        assert!(g.nodes[1].data.is_empty());
        assert_eq!(g.edges.len(), 1); // edge without target is dropped
        assert_eq!(g.edges[0].id, "edge-0");

        assert_eq!(
            parse_graph(&json!(5)).unwrap_err().0,
            "Pipeline graph is not valid JSON"
        );
        assert_eq!(
            parse_graph(&json!(null)).unwrap_err().0,
            "Pipeline graph is not valid JSON"
        );
        assert_eq!(
            parse_graph(&json!({"nodes": []})).unwrap_err().0,
            "Pipeline graph must contain \"nodes\" and \"edges\" arrays"
        );
        assert_eq!(
            parse_graph(&json!({"nodes": 5, "edges": []})).unwrap_err().0,
            "Pipeline graph must contain \"nodes\" and \"edges\" arrays"
        );
    }

    #[test]
    fn validate_graph_messages() {
        let e = validate_graph(&graph(json!({"nodes": [], "edges": []}))).unwrap_err();
        assert_eq!(e.0, "Pipeline graph has no nodes");

        let e = validate_graph(&graph(json!({
            "nodes": [{"id": "a", "type": "source"}, {"id": "a", "type": "output"}],
            "edges": [],
        })))
        .unwrap_err();
        assert_eq!(e.0, "Duplicate node id 'a'");

        let e = validate_graph(&graph(json!({
            "nodes": [{"id": "a", "type": "wat"}, {"id": "b", "type": "output"}],
            "edges": [{"id": "e1", "source": "a", "target": "b"}],
        })))
        .unwrap_err();
        assert_eq!(e.0, "Unknown node type 'wat' (node 'a')");

        let e = validate_graph(&graph(json!({
            "nodes": [{"id": "a", "type": "source"}, {"id": "b", "type": "output"}],
            "edges": [{"id": "e1", "source": "a", "target": "zz"}],
        })))
        .unwrap_err();
        assert_eq!(e.0, "Edge 'e1' references unknown target node 'zz'");

        let e = validate_graph(&graph(json!({
            "nodes": [{"id": "a", "type": "source"}],
            "edges": [],
        })))
        .unwrap_err();
        assert_eq!(e.0, "Pipeline must have exactly one output node (found 0)");

        let e = validate_graph(&graph(json!({
            "nodes": [
                {"id": "s1", "type": "source"},
                {"id": "s2", "type": "source"},
                {"id": "j", "type": "join"},
                {"id": "o", "type": "output"},
            ],
            "edges": [
                {"id": "e1", "source": "s1", "target": "j"},
                {"id": "e2", "source": "j", "target": "o"},
            ],
        })))
        .unwrap_err();
        assert_eq!(e.0, "join node 'j' requires exactly 2 inputs (found 1)");

        let e = validate_graph(&graph(json!({
            "nodes": [
                {"id": "s1", "type": "source"},
                {"id": "s2", "type": "source"},
                {"id": "f", "type": "filter"},
                {"id": "o", "type": "output"},
            ],
            "edges": [
                {"id": "e1", "source": "s1", "target": "f"},
                {"id": "e2", "source": "s2", "target": "f"},
                {"id": "e3", "source": "f", "target": "o"},
            ],
        })))
        .unwrap_err();
        assert_eq!(e.0, "filter node 'f' requires exactly 1 input (found 2)");

        let e = validate_graph(&graph(json!({
            "nodes": [
                {"id": "s1", "type": "source"},
                {"id": "o", "type": "output"},
            ],
            "edges": [{"id": "e1", "source": "o", "target": "s1"}],
        })))
        .unwrap_err();
        // source with incoming edge is reported first (node iteration order)
        assert_eq!(e.0, "source node 's1' must not have incoming edges");
    }

    #[test]
    fn topo_sort_orders_and_detects_cycles() {
        let g = graph(json!({
            "nodes": [
                {"id": "o", "type": "output"},
                {"id": "f", "type": "filter"},
                {"id": "s", "type": "source"},
            ],
            "edges": [
                {"id": "e1", "source": "s", "target": "f"},
                {"id": "e2", "source": "f", "target": "o"},
            ],
        }));
        let order = topo_sort(&g).unwrap();
        let ids: Vec<&str> = order.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(ids, vec!["s", "f", "o"]); // Kahn: in-degree 0 first, then dependents

        let cyc = graph(json!({
            "nodes": [
                {"id": "a", "type": "filter"},
                {"id": "b", "type": "filter"},
                {"id": "s", "type": "source"},
                {"id": "o", "type": "output"},
            ],
            "edges": [
                {"id": "e1", "source": "a", "target": "b"},
                {"id": "e2", "source": "b", "target": "a"},
                {"id": "e3", "source": "s", "target": "o"},
            ],
        }));
        let e = topo_sort(&cyc).unwrap_err();
        assert_eq!(e.0, "Pipeline graph contains a cycle involving nodes: a, b");
    }

    #[test]
    fn graph_sources_include_dataset_detection() {
        let g = json!({
            "nodes": [
                {"id": "s", "type": "source", "data": {"datasetId": "d1"}},
                {"id": "x", "type": "filter", "data": {"datasetId": "d2"}},
            ],
            "edges": [],
        });
        assert!(graph_sources_include_dataset(&g, "d1"));
        assert!(!graph_sources_include_dataset(&g, "d2")); // filter nodes don't count
        assert!(!graph_sources_include_dataset(&json!({}), "d1"));
        assert!(!graph_sources_include_dataset(&json!({"nodes": 5}), "d1"));
    }

    #[test]
    fn busy_message_constant() {
        assert_eq!(PIPELINE_BUSY_MESSAGE, "Run skipped: another run is already in progress");
        assert_eq!(CASCADE_MAX_DEPTH, 2);
        assert_eq!(CASCADE_MAX_CHILDREN, 5);
        assert_eq!(RUNNING_STALE_MS, 600_000);
    }

    #[test]
    fn manifest_serialization_shape() {
        let m = RunManifest {
            graph_version: GraphVersionRef { version_number: Some(11), node_count: 3 },
            inputs: vec![ManifestInput {
                dataset_id: "d1".into(),
                dataset_name: "orders".into(),
                version_number: Some(4),
                row_count: 16,
            }],
            outputs: vec![ManifestOutput {
                dataset_id: "d2".into(),
                dataset_name: "curated".into(),
                version_number: 7,
                row_count: 16,
            }],
            nodes: vec![
                ManifestNode { node_id: "s".into(), node_type: "source".into(), label: None, code_sha256: None },
                ManifestNode { node_id: "d".into(), node_type: "derive".into(), label: None, code_sha256: Some("abc".into()) },
                ManifestNode { node_id: "o".into(), node_type: "output".into(), label: Some("curated".into()), code_sha256: None },
            ],
        };
        let v = serde_json::to_value(&m).unwrap();
        assert_eq!(v["graphVersion"]["versionNumber"], 11);
        assert_eq!(v["inputs"][0]["datasetName"], "orders");
        assert_eq!(v["outputs"][0]["versionNumber"], 7);
        // exact key sets per the run-detail fixture
        assert_eq!(v["nodes"][0].as_object().unwrap().len(), 2);
        assert!(v["nodes"][1].as_object().unwrap().contains_key("codeSha256"));
        assert!(v["nodes"][2].as_object().unwrap().contains_key("label"));
        assert!(!v["nodes"][2].as_object().unwrap().contains_key("codeSha256"));
        // round-trip
        let back: RunManifest = serde_json::from_value(v).unwrap();
        assert_eq!(back.nodes.len(), 3);
        assert_eq!(back.inputs[0].version_number, Some(4));
    }

    #[test]
    fn busy_manifest_matches_legacy_shape() {
        // The busy-skip run stores an empty manifest + single error log line.
        let m = RunManifest {
            graph_version: GraphVersionRef { version_number: None, node_count: 0 },
            inputs: vec![],
            outputs: vec![],
            nodes: vec![],
        };
        let v = serde_json::to_value(&m).unwrap();
        assert_eq!(
            v,
            json!({"graphVersion": {"versionNumber": null, "nodeCount": 0}, "inputs": [], "outputs": [], "nodes": []})
        );
    }
}
