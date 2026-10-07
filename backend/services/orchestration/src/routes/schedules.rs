//! /api/schedules* — interval schedules (ports of src/app/api/schedules/**)
//! including the scheduler-service read endpoint /api/schedules/due.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::Response;
use chrono::Utc;
use mf_web::{
    actor_from_headers, json_created, json_ok, no_content, require_role, ApiError, ApiResult,
};
use serde_json::{json, Value};

use crate::audit::{self, AuditOptions};
use crate::routes::{
    as_object, opt_bool, opt_int_range, opt_string_min1, parse_body, req_string_min1_custom,
    service_token_authorized, IntRange,
};
use crate::state::{
    serialize_schedule, serialize_schedule_named, AppState, ScheduleNamedRow, ScheduleRow,
    SCHEDULE_COLS,
};

const INTERVAL_RANGE: IntRange = IntRange {
    min: 5,
    max: 10080,
    int_msg: "intervalMinutes must be an integer",
    min_msg: "intervalMinutes must be at least 5",
    max_msg: "intervalMinutes must be at most 10080 (7 days)",
};

const SCHEDULE_NAMED_COLS: &str =
    "s.id, s.pipeline_id, s.name, s.enabled, s.interval_minutes, s.last_run_at, s.next_run_at, p.name AS pipeline_name";

fn collect<T: Default>(issues: &mut Vec<String>, r: Result<T, String>) -> T {
    match r {
        Ok(v) => v,
        Err(i) => {
            issues.push(i);
            T::default()
        }
    }
}

/// GET /api/schedules — all schedules, createdAt asc, with pipeline names.
pub async fn list_schedules(State(state): State<AppState>) -> ApiResult<Response> {
    let schedules: Vec<ScheduleNamedRow> = sqlx::query_as(&format!(
        "SELECT {SCHEDULE_NAMED_COLS} FROM schedules s LEFT JOIN pipelines p ON p.id = s.pipeline_id \
         ORDER BY s.created_at ASC"
    ))
    .fetch_all(&state.db)
    .await?;
    let items: Vec<Value> = schedules.iter().map(serialize_schedule_named).collect();
    Ok(json_ok(json!({ "schedules": items })))
}

/// POST /api/schedules — create (editor+). First scheduled run fires one
/// interval from now; disabled schedules keep nextRunAt null.
pub async fn create_schedule(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;

    let v = parse_body(&body)?;
    let m = as_object(v)?;

    let mut issues = Vec::new();
    let pipeline_id = match req_string_min1_custom(&m, "pipelineId", "pipelineId is required") {
        Ok(p) => Some(p),
        Err(i) => {
            issues.push(i);
            None
        }
    };
    let name = collect(&mut issues, opt_string_min1(&m, "name"));
    let interval = collect(
        &mut issues,
        opt_int_range(&m, "intervalMinutes", &INTERVAL_RANGE),
    )
    .unwrap_or(60);
    let enabled = collect(&mut issues, opt_bool(&m, "enabled")).unwrap_or(true);
    if !issues.is_empty() {
        return Err(ApiError::bad_request(issues.join("; ")));
    }
    let pipeline_id = pipeline_id.expect("validated");

    let pipeline: Option<(String, String)> =
        sqlx::query_as("SELECT id, name FROM pipelines WHERE id = $1")
            .bind(&pipeline_id)
            .fetch_optional(&state.db)
            .await?;
    let Some((_, pipeline_name)) = pipeline else {
        return Err(ApiError::bad_request(format!(
            "Pipeline '{pipeline_id}' not found"
        )));
    };

    let name = name.unwrap_or_else(|| format!("{pipeline_name} schedule"));
    let now = Utc::now();
    let next_run_at = if enabled {
        Some(now + chrono::Duration::minutes(interval))
    } else {
        None
    };
    let id = mf_db::new_id();
    sqlx::query(
        "INSERT INTO schedules (id, pipeline_id, name, enabled, interval_minutes, next_run_at) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(&id)
    .bind(&pipeline_id)
    .bind(&name)
    .bind(enabled)
    .bind(interval as i32)
    .bind(next_run_at)
    .execute(&state.db)
    .await?;
    let schedule: ScheduleRow = sqlx::query_as(&format!(
        "SELECT {SCHEDULE_COLS} FROM schedules WHERE id = $1"
    ))
    .bind(&id)
    .fetch_one(&state.db)
    .await?;

    audit::audit(
        &state,
        &actor,
        AuditOptions::new("schedule.create", "schedule")
            .resource_id(Some(&schedule.id))
            .resource_name(Some(&schedule.name))
            .detail(Some(&format!(
                "pipeline '{pipeline_name}', every {} min",
                schedule.interval_minutes
            ))),
    )
    .await;

    Ok(json_created(
        json!({ "schedule": serialize_schedule(&schedule, Some(&pipeline_name)) }),
    ))
}

/// PATCH /api/schedules/{id} — update; when intervalMinutes or enabled is
/// sent, nextRunAt = enabled ? now + interval : null.
pub async fn update_schedule(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;

    let existing: Option<ScheduleRow> = sqlx::query_as(&format!(
        "SELECT {SCHEDULE_COLS} FROM schedules WHERE id = $1"
    ))
    .bind(&id)
    .fetch_optional(&state.db)
    .await?;
    let Some(existing) = existing else {
        return Err(ApiError::not_found(format!("Schedule '{id}' not found")));
    };

    let v = parse_body(&body)?;
    let m = as_object(v)?;
    let mut issues = Vec::new();
    let name = collect(&mut issues, opt_string_min1(&m, "name"));
    let enabled = collect(&mut issues, opt_bool(&m, "enabled"));
    let interval = collect(
        &mut issues,
        opt_int_range(&m, "intervalMinutes", &INTERVAL_RANGE),
    );
    if !issues.is_empty() {
        return Err(ApiError::bad_request(issues.join("; ")));
    }
    if name.is_none() && enabled.is_none() && interval.is_none() {
        return Err(ApiError::bad_request(
            "Nothing to update: provide name, enabled and/or intervalMinutes",
        ));
    }

    let enabled_eff = enabled.unwrap_or(existing.enabled);
    let interval_eff = interval.unwrap_or(existing.interval_minutes as i64);
    let recompute_window = enabled.is_some() || interval.is_some();
    let next_run_at = if recompute_window {
        if enabled_eff {
            Some(Utc::now() + chrono::Duration::minutes(interval_eff))
        } else {
            None
        }
    } else {
        existing.next_run_at
    };

    let updated: ScheduleRow = sqlx::query_as(&format!(
        "UPDATE schedules SET name = $1, enabled = $2, interval_minutes = $3, next_run_at = $4, updated_at = now() \
         WHERE id = $5 RETURNING {SCHEDULE_COLS}"
    ))
    .bind(name.clone().unwrap_or_else(|| existing.name.clone()))
    .bind(enabled_eff)
    .bind(interval_eff as i32)
    .bind(next_run_at)
    .bind(&id)
    .fetch_one(&state.db)
    .await?;

    let pipeline_name: Option<(String,)> =
        sqlx::query_as("SELECT name FROM pipelines WHERE id = $1")
            .bind(&updated.pipeline_id)
            .fetch_optional(&state.db)
            .await?;

    let mut detail_parts = Vec::new();
    if name.is_some() {
        detail_parts.push("name");
    }
    if enabled.is_some() {
        detail_parts.push("enabled");
    }
    if interval.is_some() {
        detail_parts.push("intervalMinutes");
    }
    audit::audit(
        &state,
        &actor,
        AuditOptions::new("schedule.update", "schedule")
            .resource_id(Some(&updated.id))
            .resource_name(Some(&updated.name))
            .detail(Some(&format!("updated {}", detail_parts.join(", ")))),
    )
    .await;

    Ok(json_ok(json!({
        "schedule": serialize_schedule(&updated, pipeline_name.as_ref().map(|(n,)| n.as_str())),
    })))
}

/// DELETE /api/schedules/{id} — editor+, 204 on success.
pub async fn delete_schedule(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;

    let existing: Option<(String, String)> =
        sqlx::query_as("SELECT id, name FROM schedules WHERE id = $1")
            .bind(&id)
            .fetch_optional(&state.db)
            .await?;
    let Some((sid, name)) = existing else {
        return Err(ApiError::not_found(format!("Schedule '{id}' not found")));
    };

    sqlx::query("DELETE FROM schedules WHERE id = $1")
        .bind(&id)
        .execute(&state.db)
        .await?;

    audit::audit(
        &state,
        &actor,
        AuditOptions::new("schedule.delete", "schedule")
            .resource_id(Some(&sid))
            .resource_name(Some(&name)),
    )
    .await;

    Ok(no_content())
}

/// GET /api/schedules/due — enabled schedules whose nextRunAt has passed.
/// Auth: viewer+ role OR the service token (legacy isServiceAuthorized);
/// demo mode passes anonymous callers through the gateway's admin fallback.
pub async fn due_schedules(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    let service_authorized = actor.is_service || service_token_authorized(&state, &headers);
    if !service_authorized {
        require_role(&actor, "viewer")?;
    }

    let schedules: Vec<ScheduleNamedRow> = sqlx::query_as(&format!(
        "SELECT {SCHEDULE_NAMED_COLS} FROM schedules s LEFT JOIN pipelines p ON p.id = s.pipeline_id \
         WHERE s.enabled AND s.next_run_at IS NOT NULL AND s.next_run_at <= now() \
         ORDER BY s.next_run_at ASC"
    ))
    .fetch_all(&state.db)
    .await?;
    let items: Vec<Value> = schedules.iter().map(serialize_schedule_named).collect();
    Ok(json_ok(json!({ "schedules": items })))
}
