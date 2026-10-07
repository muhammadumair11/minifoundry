//! /api/pipelines* — pipeline CRUD, versioning, run enqueue, restore and the
//! run-output assessment/removal routes (ports of src/app/api/pipelines/**).

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::Response;
use chrono::Utc;
use mf_web::{actor_from_headers, json_accepted, json_created, json_ok, require_role, ApiError, ApiResult};
use serde_json::{json, Map, Value};
use sqlx::types::Json;

use crate::audit::{self, AuditOptions};
use crate::jobs::{self, EnqueueOptions};
use crate::routes::{
    as_object, nullish_string, opt_enum, opt_graph, opt_int_range, opt_string,
    opt_string_array, opt_string_min1, parse_body, parse_body_or_empty, req_int_min1,
    req_string_min1_custom, service_token_authorized, IntRange,
};
use crate::scheduler;
use crate::state::{
    LastRunRow, PipelineRow, PipelineVersionRow, RunRow, ScheduleRow, AppState,
    PIPELINE_COLS, RUN_COLS, SCHEDULE_COLS, VERSION_COLS,
};
use crate::versions;

fn internal_err(msg: String) -> ApiError {
    ApiError::internal(msg)
}

// ─── GET/POST /api/pipelines ────────────────────────────────────────────

/// GET /api/pipelines — list, updatedAt desc, with runsCount + lastRun.
pub async fn list_pipelines(State(state): State<AppState>) -> ApiResult<Response> {
    Ok(json_ok(pipelines_list_payload(&state).await?))
}

pub async fn pipelines_list_payload(state: &AppState) -> Result<Value, ApiError> {
    let pipelines: Vec<PipelineRow> =
        sqlx::query_as(&format!("SELECT {PIPELINE_COLS} FROM pipelines ORDER BY updated_at DESC"))
            .fetch_all(&state.db)
            .await?;
    let counts: Vec<(String, i64)> =
        sqlx::query_as("SELECT pipeline_id, COUNT(*) FROM pipeline_runs GROUP BY pipeline_id")
            .fetch_all(&state.db)
            .await?;
    let lasts: Vec<LastRunRow> = sqlx::query_as(
        "SELECT DISTINCT ON (pipeline_id) pipeline_id, id, status, started_at, finished_at \
         FROM pipeline_runs ORDER BY pipeline_id, started_at DESC",
    )
    .fetch_all(&state.db)
    .await?;
    let count_by: std::collections::HashMap<&str, i64> =
        counts.iter().map(|(id, n)| (id.as_str(), *n)).collect();
    let last_by: std::collections::HashMap<&str, &LastRunRow> =
        lasts.iter().map(|r| (r.pipeline_id.as_str(), r)).collect();

    let items: Vec<Value> = pipelines
        .iter()
        .map(|p| {
            crate::state::serialize_pipeline_list_item(
                p,
                count_by.get(p.id.as_str()).copied().unwrap_or(0),
                last_by.get(p.id.as_str()).copied(),
            )
        })
        .collect();
    Ok(json!({ "pipelines": items }))
}

/// POST /api/pipelines — create (editor+).
pub async fn create_pipeline(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;

    let v = parse_body(&body)?;
    let m = as_object(v)?;

    let mut issues = Vec::new();
    let name = match req_string_min1_custom(&m, "name", "name is required") {
        Ok(n) => Some(n),
        Err(i) => {
            issues.push(i);
            None
        }
    };
    let description = match opt_string(&m, "description") {
        Ok(d) => d,
        Err(i) => {
            issues.push(i);
            None
        }
    };
    let graph = match opt_graph(&m, "graph") {
        Ok(g) => g,
        Err(i) => {
            issues.push(i);
            None
        }
    };
    if !issues.is_empty() {
        return Err(ApiError::bad_request(issues.join("; ")));
    }
    let name = name.expect("validated");
    let graph_value = graph.unwrap_or_else(|| json!({"nodes": [], "edges": []}));

    let pipeline: PipelineRow = sqlx::query_as(&format!(
        "INSERT INTO pipelines (id, name, description, graph_json) VALUES ($1, $2, $3, $4) RETURNING {PIPELINE_COLS}"
    ))
    .bind(mf_db::new_id())
    .bind(&name)
    .bind(description.clone())
    .bind(Json(graph_value))
    .fetch_one(&state.db)
    .await?;

    audit::audit(
        &state,
        &actor,
        AuditOptions::new("pipeline.create", "pipeline")
            .resource_id(Some(&pipeline.id))
            .resource_name(Some(&pipeline.name)),
    )
    .await;

    Ok(json_created(json!({ "pipeline": crate::state::serialize_pipeline_basic(&pipeline) })))
}

// ─── GET/PUT/PATCH/DELETE /api/pipelines/{id} ──────────────────────────

/// GET /api/pipelines/{id} — detail with latest 20 runs + versioning fields.
pub async fn pipeline_detail(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    Ok(json_ok(pipeline_detail_payload(&state, &id).await?))
}

pub async fn pipeline_detail_payload(state: &AppState, id: &str) -> Result<Value, ApiError> {
    let pipeline: Option<PipelineRow> =
        sqlx::query_as(&format!("SELECT {PIPELINE_COLS} FROM pipelines WHERE id = $1"))
            .bind(id)
            .fetch_optional(&state.db)
            .await?;
    let Some(pipeline) = pipeline else {
        return Err(ApiError::not_found(format!("Pipeline '{id}' not found")));
    };
    let runs: Vec<RunRow> = sqlx::query_as(&format!(
        "SELECT {RUN_COLS} FROM pipeline_runs WHERE pipeline_id = $1 ORDER BY started_at DESC LIMIT 20"
    ))
    .bind(id)
    .fetch_all(&state.db)
    .await?;
    let latest = versions::latest_version_number(state, id).await?;
    let version_count: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM pipeline_versions WHERE pipeline_id = $1")
            .bind(id)
            .fetch_one(&state.db)
            .await?;

    Ok(json!({
        "pipeline": crate::state::serialize_pipeline_detail(&pipeline, latest, version_count.0),
        "runs": runs.iter().map(crate::state::serialize_run).collect::<Vec<_>>(),
    }))
}

/// PUT/PATCH /api/pipelines/{id} — shared update handler (editor+); every
/// graph-changing save snapshots an immutable version (pre-save graph is
/// backfilled as v1 first when the pipeline has zero versions).
pub async fn update_pipeline(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;

    let existing: Option<(String,)> =
        sqlx::query_as("SELECT id FROM pipelines WHERE id = $1")
            .bind(&id)
            .fetch_optional(&state.db)
            .await?;
    if existing.is_none() {
        return Err(ApiError::not_found(format!("Pipeline '{id}' not found")));
    }

    let v = parse_body(&body)?;
    let m = as_object(v)?;

    let mut issues = Vec::new();
    let name = collect(&mut issues, opt_string_min1(&m, "name"));
    let description = collect(&mut issues, opt_string(&m, "description"));
    let graph = collect(&mut issues, opt_graph(&m, "graph"));
    let version_note = collect(&mut issues, nullish_string(&m, "versionNote"));
    let trigger_mode = collect(&mut issues, opt_enum(&m, "triggerMode", &["manual", "upstream"]));
    let upstream_ids = collect(&mut issues, opt_string_array(&m, "upstreamDatasetIds", 50));
    let max_retries = collect(
        &mut issues,
        opt_int_range(
            &m,
            "maxRetries",
            &IntRange {
                min: 0,
                max: 5,
                int_msg: "Invalid input: expected int",
                min_msg: "Too small: expected number to be >=0",
                max_msg: "Too big: expected number to be <=5",
            },
        ),
    );
    if !issues.is_empty() {
        return Err(ApiError::bad_request(issues.join("; ")));
    }

    let graph_changed = graph.is_some();

    // M3.1: backfill the PRE-save graph as v1 before the new graph becomes v2+.
    if graph_changed {
        versions::ensure_pipeline_version(&state, &id).await.map_err(internal_err)?;
    }

    // Dynamic update of only the provided fields (+ updated_at always).
    // Typed binds keep sqlx's PG type inference exact (TEXT vs INTEGER vs JSONB).
    enum Bind {
        Text(Option<String>),
        Int(i32),
        Jsonb(Value),
    }
    let mut sets: Vec<String> = vec!["updated_at = now()".into()];
    let mut binds: Vec<Bind> = Vec::new();
    macro_rules! add_set {
        ($col:expr, $val:expr) => {{
            sets.push(format!("{} = ${}", $col, binds.len() + 1));
            binds.push($val);
        }};
    }
    if let Some(n) = &name {
        add_set!("name", Bind::Text(Some(n.clone())));
    }
    if description.is_some() {
        add_set!("description", Bind::Text(description.clone()));
    }
    if let Some(g) = &graph {
        add_set!("graph_json", Bind::Jsonb(g.clone()));
    }
    if let Some(t) = trigger_mode {
        add_set!("trigger_mode", Bind::Text(Some(t.to_string())));
    }
    if let Some(u) = &upstream_ids {
        add_set!("upstream_dataset_ids", Bind::Jsonb(json!(u)));
    }
    if let Some(r) = max_retries {
        add_set!("max_retries", Bind::Int(r as i32));
    }
    let id_param = binds.len() + 1;
    let sql = format!(
        "UPDATE pipelines SET {} WHERE id = ${id_param} RETURNING {PIPELINE_COLS}",
        sets.join(", ")
    );
    let mut q = sqlx::query_as::<_, PipelineRow>(&sql);
    for b in &binds {
        q = match b {
            Bind::Text(s) => q.bind(s.clone()),
            Bind::Int(i) => q.bind(*i),
            Bind::Jsonb(v) => q.bind(Json(v.clone())),
        };
    }
    let pipeline: PipelineRow = q.bind(&id).fetch_one(&state.db).await?;

    // M3.1: snapshot the NEW graph on every graph-changing save.
    let mut version: Option<PipelineVersionRow> = None;
    if let Some(g) = &graph {
        let created_by = actor.email.clone().unwrap_or_else(|| actor.role.clone());
        version = Some(
            versions::snapshot_pipeline_version(
                &state,
                &id,
                g,
                version_note.as_deref(),
                Some(&created_by),
            )
            .await
            .map_err(internal_err)?,
        );
    }

    let mut detail_parts: Vec<String> = Vec::new();
    if name.is_some() {
        detail_parts.push("name".into());
    }
    if description.is_some() {
        detail_parts.push("description".into());
    }
    if graph_changed {
        detail_parts.push("graph".into());
    }
    if let Some(v) = &version {
        detail_parts.push(format!("version={}", v.version_number));
    }
    if trigger_mode.is_some() {
        detail_parts.push("triggerMode".into());
    }
    if upstream_ids.is_some() {
        detail_parts.push("upstreamDatasetIds".into());
    }
    if max_retries.is_some() {
        detail_parts.push("maxRetries".into());
    }
    let detail = format!("updated {}", detail_parts.join(", "));
    audit::audit(
        &state,
        &actor,
        AuditOptions::new("pipeline.update", "pipeline")
            .resource_id(Some(&pipeline.id))
            .resource_name(Some(&pipeline.name))
            .detail(Some(&detail)),
    )
    .await;

    Ok(json_ok(json!({ "pipeline": crate::state::serialize_pipeline_basic(&pipeline) })))
}

fn collect<T: Default>(issues: &mut Vec<String>, r: Result<T, String>) -> T {
    // T defaults on validation failure — the issues list short-circuits before use.
    match r {
        Ok(v) => v,
        Err(i) => {
            issues.push(i);
            Default::default()
        }
    }
}

/// DELETE /api/pipelines/{id} — editor+; runs/schedules cascade via FK,
/// version snapshots are removed explicitly (legacy also removed dataset
/// lineage edges — those live in catalog now; see the report).
pub async fn delete_pipeline(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;

    let existing: Option<(String, String)> =
        sqlx::query_as("SELECT id, name FROM pipelines WHERE id = $1")
            .bind(&id)
            .fetch_optional(&state.db)
            .await?;
    let Some((pid, name)) = existing else {
        return Err(ApiError::not_found(format!("Pipeline '{id}' not found")));
    };

    sqlx::query("DELETE FROM pipeline_versions WHERE pipeline_id = $1")
        .bind(&id)
        .execute(&state.db)
        .await?;
    sqlx::query("DELETE FROM pipelines WHERE id = $1")
        .bind(&id)
        .execute(&state.db)
        .await?;

    audit::audit(
        &state,
        &actor,
        AuditOptions::new("pipeline.delete", "pipeline")
            .resource_id(Some(&pid))
            .resource_name(Some(&name)),
    )
    .await;

    Ok(json_ok(json!({ "ok": true, "deleted": pid, "name": name })))
}

// ─── POST /api/pipelines/{id}/run ───────────────────────────────────────

/// POST /api/pipelines/{id}/run — enqueue a pinned pipeline version (202).
/// Service-token callers bypass the editor guard (the scheduler has no user
/// session); scheduled runs in shared mode REQUIRE the service token.
pub async fn run_pipeline(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    let service_authorized = actor.is_service || service_token_authorized(&state, &headers);
    if !service_authorized {
        require_role(&actor, "editor")?;
    }

    let pipeline: Option<(String, String)> =
        sqlx::query_as("SELECT id, name FROM pipelines WHERE id = $1")
            .bind(&id)
            .fetch_optional(&state.db)
            .await?;
    let Some((_, pipeline_name)) = pipeline else {
        return Err(ApiError::not_found(format!("Pipeline '{id}' not found")));
    };

    // Body is optional for backward compatibility (manual runs POST no body).
    let v = parse_body_or_empty(&body)?;
    let m = as_object(v)?;
    let mut issues = Vec::new();
    let schedule_id = match nullish_string_min1(&m, "scheduleId") {
        Ok(s) => s,
        Err(i) => {
            issues.push(i);
            None
        }
    };
    let cascade_depth = match opt_int_range(
        &m,
        "cascadeDepth",
        &IntRange {
            min: 0,
            max: 10,
            int_msg: "Invalid input: expected int",
            min_msg: "Too small: expected number to be >=0",
            max_msg: "Too big: expected number to be <=10",
        },
    ) {
        Ok(d) => d,
        Err(i) => {
            issues.push(i);
            None
        }
    };
    if !issues.is_empty() {
        return Err(ApiError::bad_request(issues.join("; ")));
    }
    if cascade_depth.unwrap_or(0) != 0 {
        return Err(ApiError::bad_request("cascadeDepth is not supported for queued runs"));
    }

    if let Some(schedule_id) = schedule_id {
        if !state.mode.demo && !service_authorized {
            return Err(ApiError::bad_request("A service token is required for scheduled runs"));
        }
        let schedule: Option<ScheduleRow> = sqlx::query_as(&format!(
            "SELECT {SCHEDULE_COLS} FROM schedules WHERE id = $1"
        ))
        .bind(&schedule_id)
        .fetch_optional(&state.db)
        .await?;
        let due = schedule.as_ref().and_then(|s| {
            if s.pipeline_id == id && s.enabled {
                s.next_run_at
            } else {
                None
            }
        });
        let Some(due_at) = due.filter(|d| *d <= Utc::now()) else {
            return Err(ApiError::bad_request("Schedule is not due for this pipeline"));
        };
        let schedule = schedule.expect("checked");

        let event_key = format!("schedule:{schedule_id}:{}", mf_types::ts::format(&due_at));
        let job = jobs::enqueue_pipeline_job(
            &state,
            &id,
            EnqueueOptions {
                trigger: "schedule",
                event_key,
                schedule_id: Some(schedule_id.clone()),
                max_attempts: Some(1),
                graph_version_number: None,
                payload: json!({}),
            },
        )
        .await
        .map_err(|e| internal_err(e.to_string()))?;

        // Reserve this window AFTER the job is safely stored (CAS on nextRunAt —
        // a repeated POST for the same window returns the same job via eventKey).
        scheduler::reserve_schedule_window(&state, &schedule_id, due_at)
            .await
            .map_err(|e| internal_err(e.to_string()))?;

        audit::audit(
            &state,
            &actor,
            AuditOptions::new("pipeline.run", "pipeline")
                .actor_role("system")
                .resource_id(Some(&id))
                .resource_name(Some(&pipeline_name))
                .detail(Some(&format!("schedule {} job={}", schedule.name, job.id))),
        )
        .await;
        return Ok(json_accepted(job_accepted(&job)));
    }

    let request_key = headers
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    if let Some(key) = &request_key {
        if key.chars().count() > 128 {
            return Err(ApiError::bad_request("Idempotency-Key must be at most 128 characters"));
        }
    }
    let suffix = request_key.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let event_key = format!("manual:{id}:{suffix}");
    let job = jobs::enqueue_pipeline_job(
        &state,
        &id,
        EnqueueOptions {
            trigger: "manual",
            event_key,
            schedule_id: None,
            max_attempts: Some(1),
            graph_version_number: None,
            payload: json!({}),
        },
    )
    .await
    .map_err(|e| internal_err(e.to_string()))?;

    // Manual runs use the caller's role in the audit log.
    audit::audit(
        &state,
        &actor,
        AuditOptions::new("pipeline.run", "pipeline")
            .resource_id(Some(&id))
            .resource_name(Some(&pipeline_name))
            .detail(Some(&format!("job={}", job.id))),
    )
    .await;
    Ok(json_accepted(job_accepted(&job)))
}

/// `z.string().min(1).nullish()` (run-route scheduleId).
fn nullish_string_min1(m: &Map<String, Value>, field: &str) -> Result<Option<String>, String> {
    match m.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.is_empty() => {
            Err(format!("{field}: Too small: expected string to have >=1 chars"))
        }
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(other) => Err(format!(
            "{field}: Invalid input: expected string, received {}",
            crate::routes::kind_of(other)
        )),
    }
}

fn job_accepted(job: &crate::state::JobRow) -> Value {
    json!({ "job": { "id": job.id, "status": job.status, "eventKey": job.event_key } })
}

// ─── POST /api/pipelines/{id}/restore ───────────────────────────────────

pub async fn restore_pipeline(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;

    let pipeline: Option<(String, String)> =
        sqlx::query_as("SELECT id, name FROM pipelines WHERE id = $1")
            .bind(&id)
            .fetch_optional(&state.db)
            .await?;
    let Some((_, pipeline_name)) = pipeline else {
        return Err(ApiError::not_found(format!("Pipeline '{id}' not found")));
    };

    let v = parse_body(&body)?;
    let m = as_object(v)?;
    let version_number = req_int_min1(&m, "versionNumber").map_err(ApiError::bad_request)?;

    let snapshot = versions::get_pipeline_version(&state, &id, version_number as i32)
        .await
        .map_err(|e| internal_err(e.to_string()))?;
    let Some(snapshot) = snapshot else {
        return Err(ApiError::not_found(format!(
            "Version '{version_number}' not found for pipeline '{id}'"
        )));
    };

    // Restore = set the pipeline's graph to the snapshot, then append the
    // restore as a new version (history stays append-only).
    let updated: PipelineRow = sqlx::query_as(&format!(
        "UPDATE pipelines SET graph_json = $1, updated_at = now() WHERE id = $2 RETURNING {PIPELINE_COLS}"
    ))
    .bind(Json(snapshot.graph_json.0.clone()))
    .bind(&id)
    .fetch_one(&state.db)
    .await?;

    let created_by = actor.email.clone().unwrap_or_else(|| actor.role.clone());
    let note = format!("restored from v{}", snapshot.version_number);
    let version = versions::snapshot_pipeline_version(
        &state,
        &id,
        &snapshot.graph_json.0,
        Some(&note),
        Some(&created_by),
    )
    .await
    .map_err(internal_err)?;

    audit::audit(
        &state,
        &actor,
        AuditOptions::new("pipeline.restore", "pipeline")
            .resource_id(Some(&id))
            .resource_name(Some(&pipeline_name))
            .detail(Some(&format!(
                "from={} to={}",
                snapshot.version_number, version.version_number
            ))),
    )
    .await;

    Ok(json_ok(json!({
        "pipeline": crate::state::serialize_pipeline_basic(&updated),
        "version": {
            "versionNumber": version.version_number,
            "nodeCount": version.node_count,
            "note": version.note,
            "createdBy": version.created_by,
            "createdAt": mf_types::ts::format(&version.created_at),
        },
    })))
}

// ─── GET /api/pipelines/{id}/versions[/{version}] ───────────────────────

pub async fn list_versions(State(state): State<AppState>, Path(id): Path<String>) -> ApiResult<Response> {
    let pipeline: Option<(String,)> = sqlx::query_as("SELECT id FROM pipelines WHERE id = $1")
        .bind(&id)
        .fetch_optional(&state.db)
        .await?;
    if pipeline.is_none() {
        return Err(ApiError::not_found(format!("Pipeline '{id}' not found")));
    }

    // Lazily backfills v1 (no-op once the pipeline has versions).
    versions::ensure_pipeline_version(&state, &id).await.map_err(internal_err)?;

    let version_rows: Vec<PipelineVersionRow> = sqlx::query_as(&format!(
        "SELECT {VERSION_COLS} FROM pipeline_versions WHERE pipeline_id = $1 ORDER BY version_number DESC"
    ))
    .bind(&id)
    .fetch_all(&state.db)
    .await?;
    let run_groups: Vec<(Option<i32>, i64)> = sqlx::query_as(
        "SELECT version_number, COUNT(*) FROM pipeline_runs WHERE pipeline_id = $1 GROUP BY version_number",
    )
    .bind(&id)
    .fetch_all(&state.db)
    .await?;
    let counts: std::collections::HashMap<Option<i32>, i64> = run_groups.into_iter().collect();

    let items: Vec<Value> = version_rows
        .iter()
        .map(|v| {
            json!({
                "versionNumber": v.version_number,
                "nodeCount": v.node_count,
                "note": v.note,
                "createdBy": v.created_by,
                "createdAt": mf_types::ts::format(&v.created_at),
                "runCount": counts.get(&Some(v.version_number)).copied().unwrap_or(0),
            })
        })
        .collect();
    Ok(json_ok(json!({ "versions": items })))
}

pub async fn version_detail(
    State(state): State<AppState>,
    Path((id, version)): Path<(String, String)>,
) -> ApiResult<Response> {
    let not_found = || {
        ApiError::not_found(format!("Version '{version}' not found for pipeline '{id}'"))
    };
    // Number(version): NaN / non-integer / < 1 all 404 (legacy behavior).
    let version_number = parse_js_version_param(&version).ok_or_else(not_found)?;
    let snapshot = versions::get_pipeline_version(&state, &id, version_number)
        .await
        .map_err(|e| internal_err(e.to_string()))?
        .ok_or_else(not_found)?;

    Ok(json_ok(json!({
        "version": {
            "versionNumber": snapshot.version_number,
            "nodeCount": snapshot.node_count,
            "note": snapshot.note,
            "createdBy": snapshot.created_by,
            "createdAt": mf_types::ts::format(&snapshot.created_at),
            "graph": crate::state::graph_value(&snapshot.graph_json.0),
        },
    })))
}

/// JS `Number(param)` + `Number.isInteger(n) && n >= 1` (i32 column range).
fn parse_js_version_param(raw: &str) -> Option<i32> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None; // Number("") === 0 → < 1
    }
    let n = crate::values::to_number(&Value::String(trimmed.to_string()));
    if !n.is_finite() || n != n.trunc() || n < 1.0 || n > i32::MAX as f64 {
        return None;
    }
    Some(n as i32)
}

// ─── GET/DELETE /api/pipelines/{id}/runs/{runId}/output ─────────────────

/// Output-removal assessment. Ports the legacy `assess()` using the data
/// domains available to this service:
/// - run/job/pipeline-consumer checks run against the orchestration schema;
/// - dataset/version facts come from catalog's internal detail endpoint;
/// - cross-service reference checks the monolith had (version-lineage
///   downstream count, branches, pending approvals, transforms, dashboards,
///   ontology) have no internal endpoints yet — they are SKIPPED (recorded as
///   a change request; deletion here is more permissive than legacy for those
///   specific reasons).
struct Assessment {
    state: &'static str, // none | removed | available
    dataset_id: Option<String>,
    dataset_name: Option<String>,
    version_number: Option<i64>,
    row_count: Option<i64>,
    mode: &'static str, // version | dataset
    reasons: Vec<String>,
    allowed: bool,
}

async fn assess(state: &AppState, id: &str, run_id: &str) -> Result<Option<Assessment>, ApiError> {
    let run: Option<RunRow> = sqlx::query_as(&format!(
        "SELECT {RUN_COLS} FROM pipeline_runs WHERE id = $1 AND pipeline_id = $2"
    ))
    .bind(run_id)
    .bind(id)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| internal_err(e.to_string()))?;
    let Some(run) = run else { return Ok(None) };

    let (Some(dataset_id), Some(version_number)) =
        (run.output_dataset_id.clone(), run.output_version_number)
    else {
        return Ok(Some(Assessment {
            state: "none",
            dataset_id: None,
            dataset_name: None,
            version_number: None,
            row_count: None,
            mode: "dataset",
            reasons: vec![],
            allowed: false,
        }));
    };
    let version_number = version_number as i64;

    let detail = match state.catalog.dataset_detail(&dataset_id).await {
        Ok(d) => d,
        Err(e) if crate::catalog::is_not_found(&e) => {
            return Ok(Some(Assessment {
                state: "removed",
                dataset_id: None,
                dataset_name: None,
                version_number: None,
                row_count: None,
                mode: "dataset",
                reasons: vec![],
                allowed: false,
            }))
        }
        Err(e) => return Err(internal_err(crate::catalog::internal_error_message(&e))),
    };
    let dataset = detail.get("dataset").cloned().unwrap_or_else(|| detail.clone());
    let dataset_name = dataset.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
    let versions_arr = detail
        .get("versions")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let Some(version) = versions_arr.iter().find(|v| {
        v.get("versionNumber").and_then(|n| n.as_i64()) == Some(version_number)
    }) else {
        return Ok(Some(Assessment {
            state: "removed",
            dataset_id: Some(dataset_id),
            dataset_name: Some(dataset_name),
            version_number: Some(version_number),
            row_count: None,
            mode: "dataset",
            reasons: vec![],
            allowed: false,
        }));
    };

    let mut reasons: Vec<String> = Vec::new();
    let created_by = version.get("createdBy").and_then(|v| v.as_str());
    if created_by != Some(run.id.as_str()) {
        reasons.push("This run is not the recorded writer of the version.".into());
    }
    let branch = version.get("branch").and_then(|v| v.as_str()).unwrap_or("main");
    if branch != "main" {
        reasons.push("Branch versions require branch cleanup.".into());
    }
    let latest = versions_arr
        .iter()
        .filter_map(|v| v.get("versionNumber").and_then(|n| n.as_i64()))
        .max();
    if latest != Some(version_number) {
        reasons.push("Only the latest dataset version can be removed.".into());
    }
    let previous = versions_arr
        .iter()
        .filter(|v| {
            v.get("branch").and_then(|b| b.as_str()).unwrap_or("main") == "main"
                && v.get("versionNumber").and_then(|n| n.as_i64()).unwrap_or(0) < version_number
        })
        .max_by_key(|v| v.get("versionNumber").and_then(|n| n.as_i64()).unwrap_or(0));
    let mode = if previous.is_some() { "version" } else { "dataset" };
    let published_version = dataset.get("publishedVersion").and_then(|v| v.as_i64());
    if let Some(prev) = previous {
        let prev_lifecycle = prev.get("lifecycle").and_then(|v| v.as_str());
        if published_version == Some(version_number) && prev_lifecycle != Some("published") {
            reasons.push("The preceding version is not published.".into());
        }
    }

    // The output job is still active (queued/running) — legacy keyed on
    // version.outputJobId; the run's own job is the equivalent here.
    let active_jobs: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM execution_jobs WHERE last_run_id = $1 AND status IN ('queued', 'running')",
    )
    .bind(run_id)
    .fetch_one(&state.db)
    .await
    .map_err(|e| internal_err(e.to_string()))?;
    if active_jobs.0 > 0 {
        reasons.push("The output job is still active.".into());
    }

    let other_outputs: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM pipeline_runs WHERE output_dataset_id = $1 AND output_version_number = $2 AND id <> $3",
    )
    .bind(&dataset_id)
    .bind(version_number as i32)
    .bind(run_id)
    .fetch_one(&state.db)
    .await
    .map_err(|e| internal_err(e.to_string()))?;
    if other_outputs.0 > 0 {
        reasons.push("Another run references this output version.".into());
    }

    // Pipeline consumers: graphJson/upstreamDatasetIds substring matches
    // (legacy raw-string includes over the stored JSON).
    let consumers: Vec<(String,)> = sqlx::query_as(
        "SELECT name FROM pipelines WHERE graph_json::text LIKE '%' || $1 || '%' \
            OR upstream_dataset_ids::text LIKE '%' || $1 || '%' ORDER BY created_at ASC",
    )
    .bind(&dataset_id)
    .fetch_all(&state.db)
    .await
    .map_err(|e| internal_err(e.to_string()))?;
    if !consumers.is_empty() {
        let names: Vec<&str> = consumers.iter().map(|(n,)| n.as_str()).collect();
        reasons.push(format!("Referenced by pipeline: {}.", names.join(", ")));
    }

    let row_count = version.get("rowCount").and_then(|n| n.as_i64()).unwrap_or(0);
    Ok(Some(Assessment {
        state: "available",
        dataset_id: Some(dataset_id),
        dataset_name: Some(dataset_name),
        version_number: Some(version_number),
        row_count: Some(row_count),
        mode,
        allowed: reasons.is_empty(),
        reasons,
    }))
}

pub async fn output_status(
    State(state): State<AppState>,
    Path((id, run_id)): Path<(String, String)>,
) -> ApiResult<Response> {
    let Some(result) = assess(&state, &id, &run_id).await? else {
        return Err(ApiError::not_found("Run not found"));
    };
    if result.state != "available" {
        return Ok(json_ok(json!({ "state": result.state, "allowed": false })));
    }
    Ok(json_ok(json!({
        "state": result.state,
        "allowed": result.allowed,
        "mode": result.mode,
        "datasetName": result.dataset_name,
        "datasetId": result.dataset_id,
        "versionNumber": result.version_number,
        "rowCount": result.row_count,
        "reasons": result.reasons,
    })))
}

pub async fn output_delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, run_id)): Path<(String, String)>,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;

    let Some(result) = assess(&state, &id, &run_id).await? else {
        return Err(ApiError::not_found("Run not found"));
    };
    if result.state != "available" {
        return Err(ApiError::conflict("This run has no output to remove"));
    }
    if !result.allowed {
        return Err(ApiError::conflict(result.reasons.join(" ")));
    }
    let dataset_id = result.dataset_id.clone().unwrap_or_default();
    let version_number = result.version_number.unwrap_or(0);

    // The actual storage removal belongs to catalog (single write path); these
    // internal DELETEs are the natural REST complement of POST versions and
    // are recorded as a catalog change request (see the report).
    let remove = if result.mode == "dataset" {
        state.catalog.delete_dataset(&dataset_id).await
    } else {
        state.catalog.delete_version(&dataset_id, version_number).await
    };
    remove.map_err(|e| internal_err(crate::catalog::internal_error_message(&e)))?;

    audit::audit(
        &state,
        &actor,
        AuditOptions::new("pipeline.output.delete", "pipeline")
            .resource_id(Some(&id))
            .resource_name(result.dataset_name.as_deref())
            .detail(Some(&format!(
                "run={run_id} dataset={dataset_id} version={version_number} mode={}",
                result.mode
            ))),
    )
    .await;

    Ok(json_ok(json!({ "removed": result.mode, "datasetId": dataset_id, "versionNumber": version_number })))
}

// ─── shared run enqueue helpers used by runs.rs (replay/retry) ──────────

/// eventKey formats kept in one place (legacy `replay:<runId>:<Date.now()>` /
/// `retry:<runId>:<Date.now()>`).
pub fn replay_event_key(run_id: &str) -> String {
    format!("replay:{run_id}:{}", jobs::now_millis())
}

pub fn retry_event_key(run_id: &str) -> String {
    format!("retry:{run_id}:{}", jobs::now_millis())
}
