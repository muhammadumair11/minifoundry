//! /api/settings/* — Task 12-a Settings service ports.
//!
//! GET  /api/settings/overview — platform-wide counts (any role). Counts
//! owned by sibling services come from their /internal/stats; a missing
//! service degrades to zeros (legacy Promise.all had no such failure mode;
//! the fixture keys are always present).
//! POST /api/settings/reset — admin-only workspace wipe: fan-out to every
//! service's /internal/reset (tolerant per service; users live in auth and
//! are NEVER reset), then the governance tables are wiped locally and ONE
//! workspace.reset audit row documents the wipe with the non-zero counts.

use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::Response;
use mf_web::{actor_from_headers, json_ok, require_role, ApiResult};
use serde_json::{Map, Value};

use crate::fanout::service_admin_actor;
use crate::state::AppState;

/// Legacy ResetCounts key order (settings-service.ts insertion order).
pub const LEGACY_COUNT_ORDER: [&str; 33] = [
    "actionLogs",
    "linkTypes",
    "properties",
    "objectTypes",
    "columnMarkings",
    "qualityResults",
    "qualityRules",
    "datasetBranches",
    "datasetComments",
    "datasetWatchers",
    "datasetVersions",
    "lineageEdges",
    "versionLineageEdges",
    "datasets",
    "pipelineVersions",
    "pipelineRuns",
    "schedules",
    "pipelines",
    "transformRuns",
    "transforms",
    "ingestions",
    "connectors",
    "approvalRequests",
    "markings",
    "apiRequestLogs",
    "apiTokens",
    "auditEntries",
    "projects",
    "dashboards",
    "objectViews",
    "resourceAcls",
    "notifications",
    "curriculumProgress",
];

fn num(v: &Value, key: &str) -> i64 {
    v.get(key).and_then(|x| x.as_i64()).unwrap_or(0)
}

/// GET /api/settings/overview — every fixture key, zeros on degradation.
pub async fn overview(State(state): State<AppState>) -> ApiResult<Response> {
    // Local (governance-owned) counts.
    let local: (i64, i64, i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM markings), \
                (SELECT count(*) FROM column_markings), \
                (SELECT count(*) FROM approval_requests), \
                (SELECT count(*) FROM approval_requests WHERE status = 'pending'), \
                (SELECT count(*) FROM audit_entries)",
    )
    .fetch_one(&state.db)
    .await?;

    // Sibling-service counts (parallel, tolerant).
    let (catalog, orchestration, compute, ontology, auth) = futures::join!(
        state.clients.catalog.get("/internal/stats"),
        state.clients.orchestration.get("/internal/stats"),
        state.clients.compute.get("/internal/stats"),
        state.clients.ontology.get("/internal/stats"),
        auth_counts(&state),
    );
    let catalog = ok_or_zero(catalog, "catalog");
    let orchestration = ok_or_zero(orchestration, "orchestration");
    let compute = ok_or_zero(compute, "compute");
    let ontology = ok_or_zero(ontology, "ontology");
    let auth = auth.unwrap_or_default();

    let overview = serde_json::json!({
        "projects": num(&catalog, "projects"),
        "connectors": num(&catalog, "connectors"),
        "datasets": num(&catalog, "datasets"),
        "datasetVersions": num(&catalog, "datasetVersions"),
        "pipelines": num(&orchestration, "pipelines"),
        "pipelineVersions": num(&orchestration, "pipelineVersions"),
        "pipelineRuns": num(&orchestration, "runs").max(num(&orchestration, "pipelineRuns")),
        "schedules": num(&orchestration, "schedules"),
        "transforms": num(&compute, "transforms"),
        "transformRuns": num(&compute, "transformRuns"),
        "objectTypes": num(&ontology, "objectTypes"),
        "properties": num(&ontology, "properties"),
        "linkTypes": num(&ontology, "linkTypes"),
        "actions": num(&ontology, "actionTypes").max(num(&ontology, "actions")),
        "actionLogs": num(&ontology, "actionLogs"),
        "markings": local.0,
        "columnMarkings": local.1,
        "approvalRequests": local.2,
        "pendingApprovals": local.3,
        "auditEntries": local.4,
        "apiTokens": num(&auth, "apiTokens"),
        "activeTokens": num(&auth, "activeTokens"),
        "apiRequestLogs": num(&auth, "apiRequestLogs"),
        "users": num(&auth, "users"),
    });
    Ok(json_ok(overview))
}

fn ok_or_zero(r: Result<Value, crate::fanout::FanOutError>, service: &str) -> Value {
    match r {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(service, error = %e, "stats unavailable; counts degrade to zero");
            Value::Null
        }
    }
}

/// Auth owns no /internal/stats (frozen service) — derive the four overview
/// counts from its public admin routes with the trusted service actor:
/// /api/tokens (apiTokens/activeTokens), /api/users (users),
/// /api/tokens/usage (apiRequestLogs — 24h window total; documented
/// deviation, legacy counted ALL rows which it also pruned at 48h).
async fn auth_counts(state: &AppState) -> Result<Value, ()> {
    let actor = service_admin_actor();
    // Prefer a future auth /internal/stats when it exists.
    if let Ok(v) = state.clients.auth.get("/internal/stats").await {
        if v.get("apiTokens").is_some() || v.get("users").is_some() {
            return Ok(v);
        }
    }
    let (tokens, users, usage) = futures::join!(
        state.clients.auth.get_as("/api/tokens", &actor),
        state.clients.auth.get_as("/api/users", &actor),
        state.clients.auth.get_as("/api/tokens/usage", &actor),
    );
    if tokens.is_err() && users.is_err() && usage.is_err() {
        return Err(());
    }
    let token_items = tokens
        .map(|v| crate::fanout::items_array(&v, "tokens"))
        .unwrap_or_default();
    let api_tokens = token_items.len() as i64;
    let active_tokens = token_items
        .iter()
        .filter(|t| t.get("revokedAt").map(|r| r.is_null()).unwrap_or(true))
        .count() as i64;
    let users = users
        .map(|v| crate::fanout::items_array(&v, "users").len() as i64)
        .unwrap_or(0);
    let api_request_logs = usage
        .ok()
        .and_then(|v| v.get("total").and_then(|t| t.as_i64()))
        .unwrap_or(0);
    Ok(serde_json::json!({
        "apiTokens": api_tokens,
        "activeTokens": active_tokens,
        "apiRequestLogs": api_request_logs,
        "users": users,
    }))
}

/// POST /api/settings/reset — admin-only workspace wipe.
pub async fn reset(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "admin")?;

    // Fan-out to every sibling service (tolerant per service; auth's reset —
    // if it ever lands — must keep users: legacy parity).
    let (catalog, orchestration, compute, ontology, auth) = futures::join!(
        state.clients.catalog.post("/internal/reset", &Value::Null),
        state.clients.orchestration.post("/internal/reset", &Value::Null),
        state.clients.compute.post("/internal/reset", &Value::Null),
        state.clients.ontology.post("/internal/reset", &Value::Null),
        state.clients.auth.post("/internal/reset", &Value::Null),
    );

    let mut counts: Map<String, Value> = Map::new();
    for (r, service) in [
        (catalog, "catalog"),
        (orchestration, "orchestration"),
        (compute, "compute"),
        (ontology, "ontology"),
        (auth, "auth"),
    ] {
        match r {
            Ok(v) => merge_counts(&mut counts, &v),
            Err(e) if e.is_transport() => {
                tracing::warn!(service, error = %e, "reset fan-out: service unreachable (skipped)");
            }
            Err(e) => {
                tracing::warn!(service, error = %e, "reset fan-out: service refused (skipped)");
            }
        }
    }

    // Local governance wipe (FK-safe order), counted.
    let mut tx = state.db.begin().await?;
    let local_tables: [(&str, &str); 7] = [
        ("column_markings", "columnMarkings"),
        ("markings", "markings"),
        ("approval_requests", "approvalRequests"),
        ("resource_acls", "resourceAcls"),
        ("notifications", "notifications"),
        ("curriculum_progress", "curriculumProgress"),
        ("audit_entries", "auditEntries"),
    ];
    for (table, key) in local_tables {
        let n: i64 =
            sqlx::query_scalar(&format!("SELECT count(*) FROM (DELETE FROM {table} RETURNING id) d"))
                .fetch_one(&mut *tx)
                .await?;
        counts.insert(key.to_string(), Value::Number(n.into()));
    }

    // The ONE audit row that survives: the wipe itself, documented with its
    // non-zero counts (legacy detail JSON).
    let detail = ordered_counts(&counts, true);
    sqlx::query(
        "INSERT INTO audit_entries (id, actor_role, actor_email, action, resource_type, resource_name, detail) \
         VALUES ($1,$2,$3,'workspace.reset','platform','MiniFoundry',$4)",
    )
    .bind(mf_db::new_id())
    .bind(mf_web::audit_role(&actor))
    .bind(&actor.email)
    .bind(detail.to_string())
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    Ok(json_ok(serde_json::json!({
        "resetAt": mf_types::ts::format(&chrono::Utc::now()),
        "counts": ordered_counts(&counts, false),
    })))
}

/// Accept a sibling service's reset response as counts: either a flat
/// key→number object or `{ counts: {…} }`.
fn merge_counts(into: &mut Map<String, Value>, v: &Value) {
    let src = v
        .get("counts")
        .filter(|c| c.is_object())
        .unwrap_or(v)
        .as_object()
        .cloned()
        .unwrap_or_default();
    for (k, val) in src {
        if val.is_number() {
            into.insert(k, val);
        }
    }
}

/// Rebuild a counts map in the legacy key order (unknown keys appended in
/// their existing order); `non_zero_only` for the audit detail JSON.
pub fn ordered_counts(counts: &Map<String, Value>, non_zero_only: bool) -> Value {
    let mut out = Map::new();
    for key in LEGACY_COUNT_ORDER {
        if let Some(v) = counts.get(key) {
            if !non_zero_only || v.as_i64().unwrap_or(0) > 0 {
                out.insert(key.to_string(), v.clone());
            }
        }
    }
    for (k, v) in counts {
        if !LEGACY_COUNT_ORDER.contains(&k.as_str())
            && (!non_zero_only || v.as_i64().unwrap_or(0) > 0)
        {
            out.insert(k.clone(), v.clone());
        }
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_follow_legacy_order_and_zero_filter() {
        let mut counts = Map::new();
        counts.insert("markings".into(), serde_json::json!(2));
        counts.insert("datasets".into(), serde_json::json!(0));
        counts.insert("customThing".into(), serde_json::json!(7));
        let full = ordered_counts(&counts, false);
        let keys: Vec<&String> = full.as_object().unwrap().keys().collect();
        assert_eq!(keys, vec!["datasets", "markings", "customThing"]);
        let nz = ordered_counts(&counts, true);
        let keys: Vec<&String> = nz.as_object().unwrap().keys().collect();
        assert_eq!(keys, vec!["markings", "customThing"]);
    }

    #[test]
    fn merge_accepts_flat_or_nested() {
        let mut into = Map::new();
        merge_counts(&mut into, &serde_json::json!({ "datasets": 3, "junk": "x" }));
        merge_counts(&mut into, &serde_json::json!({ "counts": { "pipelines": 1 } }));
        assert_eq!(into.get("datasets").and_then(|v| v.as_i64()), Some(3));
        assert_eq!(into.get("pipelines").and_then(|v| v.as_i64()), Some(1));
        assert!(into.get("junk").is_none());
    }
}
