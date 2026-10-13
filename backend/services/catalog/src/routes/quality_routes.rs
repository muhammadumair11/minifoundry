//! /api/datasets/{id}/quality[...] — R14 quality rule routes (ports of
//! quality/route.ts, quality/[ruleId]/route.ts, quality/evaluate/route.ts).

use axum::body::Bytes;
use axum::extract::Path;
use axum::http::HeaderMap;
use axum::response::Response;
use mf_web::TenantState as State;
use mf_web::{actor_from_headers, json_created, json_ok, require_role, ApiError, ApiResult};
use serde_json::{json, Value};
use std::collections::HashMap;

use crate::audit::{audit, AuditOptions};
use crate::quality::{evaluate_rules, kind_requires_column, QUALITY_KINDS};
use crate::routes::require_dataset;
use crate::state::{
    serialize_result, serialize_rule, AppState, ResultRow, RuleRow, RESULT_COLS, RULE_COLS,
};
use crate::validate::{
    as_object, opt_bool, opt_enum, opt_object, opt_str_trim_bounded, parse_body, req_enum,
};

const SEVERITIES: [&str; 2] = ["warn", "error"];

/// GET /api/datasets/{id}/quality — rules (createdAt asc) + latest result per
/// rule + lastEvaluatedAt (any role).
pub async fn get_quality(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    require_dataset(&state.db, &id).await?;

    let rules: Vec<RuleRow> = sqlx::query_as(&format!(
        "SELECT {RULE_COLS} FROM quality_rules WHERE dataset_id = $1 ORDER BY created_at ASC, id ASC"
    ))
    .bind(&id)
    .fetch_all(&state.db)
    .await?;
    let latest: Option<(chrono::DateTime<chrono::Utc>,)> = sqlx::query_as(
        "SELECT created_at FROM quality_results WHERE dataset_id = $1 \
         ORDER BY created_at DESC, id DESC LIMIT 1",
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await?;

    let mut with_results: Vec<Value> = Vec::with_capacity(rules.len());
    for rule in &rules {
        let last: Option<ResultRow> = sqlx::query_as(&format!(
            "SELECT {RESULT_COLS} FROM quality_results WHERE rule_id = $1 \
             ORDER BY created_at DESC, id DESC LIMIT 1"
        ))
        .bind(&rule.id)
        .fetch_optional(&state.db)
        .await?;
        let mut item = serialize_rule(rule);
        item["lastResult"] = match &last {
            Some(r) => serialize_result(r),
            None => Value::Null,
        };
        with_results.push(item);
    }

    Ok(json_ok(json!({
        "rules": with_results,
        "lastEvaluatedAt": latest.map(|(t,)| crate::state::ts(&t)).unwrap_or(Value::Null),
    })))
}

/// POST /api/datasets/{id}/quality — editor+; create a rule (201).
pub async fn post_quality(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;
    let (_dataset_id, dataset_name) = require_dataset(&state.db, &id).await?;

    let v = parse_body(&body)?;
    let m = as_object(v)?;
    let name =
        opt_str_trim_bounded(&m, "name", 1, Some("name is required"), 120)?.ok_or_else(|| {
            ApiError::bad_request("name: Invalid input: expected string, received undefined")
        })?;
    let kind = req_enum(&m, "kind", &QUALITY_KINDS)?;
    let column = opt_str_trim_bounded(&m, "column", 1, None, usize::MAX)?;
    let config = opt_object(&m, "config")?.unwrap_or_default();
    let severity = opt_enum(&m, "severity", &SEVERITIES)?.unwrap_or("warn");
    let enabled = opt_bool(&m, "enabled")?.unwrap_or(true);

    if kind_requires_column(kind) && column.map(|c| c.is_empty()).unwrap_or(true) {
        return Err(ApiError::bad_request(format!(
            "kind '{kind}' requires a column"
        )));
    }

    let rule: RuleRow = sqlx::query_as(&format!(
        "INSERT INTO quality_rules (id, dataset_id, name, kind, column_name, config_json, severity, enabled) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING {RULE_COLS}"
    ))
    .bind(mf_db::new_id())
    .bind(&id)
    .bind(name)
    .bind(kind)
    .bind(column)
    .bind(serde_json::to_string(&Value::Object(config)).unwrap_or_else(|_| "{}".into()))
    .bind(severity)
    .bind(enabled)
    .fetch_one(&state.db)
    .await?;

    audit(
        &state,
        &actor,
        AuditOptions::new("dataset.quality.rule_create", "dataset")
            .resource_id(Some(&id))
            .resource_name(Some(&dataset_name))
            .detail(Some(&format!(
                "rule='{}' kind={} column={} severity={}",
                rule.name,
                rule.kind,
                rule.column_name.as_deref().unwrap_or("-"),
                rule.severity
            ))),
    )
    .await;

    Ok(json_created(serialize_rule(&rule)))
}

/// PATCH /api/datasets/{id}/quality/{ruleId} — editor+; update a rule.
pub async fn patch_quality_rule(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, rule_id)): Path<(String, String)>,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;

    let rule: Option<RuleRow> = sqlx::query_as(&format!(
        "SELECT {RULE_COLS} FROM quality_rules WHERE id = $1 AND dataset_id = $2"
    ))
    .bind(&rule_id)
    .bind(&id)
    .fetch_optional(&state.db)
    .await?;
    let Some(rule) = rule else {
        return Err(ApiError::not_found("Quality rule not found"));
    };

    let v = parse_body(&body)?;
    let m = as_object(v)?;
    let name = opt_str_trim_bounded(&m, "name", 1, None, 120)?;
    let kind = opt_enum(&m, "kind", &QUALITY_KINDS)?;
    // column: nullish — distinguish absent / null / value
    let column_present = m.contains_key("column");
    let column_null = matches!(m.get("column"), Some(Value::Null));
    let column = opt_str_trim_bounded(&m, "column", 1, None, usize::MAX)?;
    let config = opt_object(&m, "config")?;
    let severity = opt_enum(&m, "severity", &SEVERITIES)?;
    let enabled = opt_bool(&m, "enabled")?;

    let effective_kind = kind.unwrap_or(rule.kind.as_str());
    let effective_column: Option<&str> = if column_present && !column_null {
        column
    } else if column_present {
        None
    } else {
        rule.column_name.as_deref()
    };
    if kind_requires_column(effective_kind) && effective_column.is_none() {
        return Err(ApiError::bad_request(format!(
            "kind '{effective_kind}' requires a column"
        )));
    }

    let updated: RuleRow = sqlx::query_as(&format!(
        "UPDATE quality_rules SET \
         name = COALESCE($2, name), \
         kind = COALESCE($3, kind), \
         column_name = CASE WHEN $4::boolean THEN $5 ELSE column_name END, \
         config_json = COALESCE($6, config_json), \
         severity = COALESCE($7, severity), \
         enabled = COALESCE($8, enabled) \
         WHERE id = $1 RETURNING {RULE_COLS}"
    ))
    .bind(&rule.id)
    .bind(name)
    .bind(kind)
    .bind(column_present)
    .bind(if column_present && !column_null {
        column
    } else {
        None
    })
    .bind(config.map(|c| serde_json::to_string(&Value::Object(c)).unwrap_or_else(|_| "{}".into())))
    .bind(severity)
    .bind(enabled)
    .fetch_one(&state.db)
    .await?;

    audit(
        &state,
        &actor,
        AuditOptions::new("dataset.quality.rule_update", "dataset")
            .resource_id(Some(&id))
            .resource_name(Some(&rule.name))
            .detail(Some(&format!(
                "enabled={} severity={}",
                updated.enabled, updated.severity
            ))),
    )
    .await;

    Ok(json_ok(json!({ "ok": true, "id": updated.id })))
}

/// DELETE /api/datasets/{id}/quality/{ruleId} — editor+.
pub async fn delete_quality_rule(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, rule_id)): Path<(String, String)>,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;

    let rule: Option<RuleRow> = sqlx::query_as(&format!(
        "SELECT {RULE_COLS} FROM quality_rules WHERE id = $1 AND dataset_id = $2"
    ))
    .bind(&rule_id)
    .bind(&id)
    .fetch_optional(&state.db)
    .await?;
    let Some(rule) = rule else {
        return Err(ApiError::not_found("Quality rule not found"));
    };

    sqlx::query("DELETE FROM quality_rules WHERE id = $1")
        .bind(&rule.id)
        .execute(&state.db)
        .await?;

    audit(
        &state,
        &actor,
        AuditOptions::new("dataset.quality.rule_delete", "dataset")
            .resource_id(Some(&id))
            .resource_name(Some(&rule.name))
            .detail(Some(&format!("kind={}", rule.kind))),
    )
    .await;

    Ok(json_ok(
        json!({ "ok": true, "deleted": rule.id, "name": rule.name }),
    ))
}

/// POST /api/datasets/{id}/quality/evaluate — editor+; run all ENABLED rules
/// against ?version= (default main head, fallback newest) with trigger 'manual'.
pub async fn evaluate_quality(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    query: axum::extract::Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;
    let (_dataset_id, dataset_name) = require_dataset(&state.db, &id).await?;

    let version_param = query.get("version").filter(|s| !s.is_empty());
    let version_number: i32 = match version_param {
        Some(raw) => {
            let n = crate::jsval::js_parse_number(raw);
            if !n.is_finite() || n.fract() != 0.0 || n < 1.0 {
                return Err(ApiError::bad_request("Invalid 'version' parameter"));
            }
            n as i32
        }
        None => {
            let main_head: Option<i32> = sqlx::query_scalar(
                "SELECT max(version_number) FROM dataset_versions WHERE dataset_id = $1 AND branch = 'main'",
            )
            .bind(&id)
            .fetch_one(&state.db)
            .await?;
            let any_head: Option<i32> = sqlx::query_scalar(
                "SELECT max(version_number) FROM dataset_versions WHERE dataset_id = $1",
            )
            .bind(&id)
            .fetch_one(&state.db)
            .await?;
            match main_head.or(any_head) {
                Some(n) => n,
                None => return Err(ApiError::bad_request("Dataset has no versions to evaluate")),
            }
        }
    };

    let result = evaluate_rules(&state, &id, version_number, "manual")
        .await
        .map_err(|e| {
            ApiError::new(
                match e.status {
                    404 => axum::http::StatusCode::NOT_FOUND,
                    _ => axum::http::StatusCode::BAD_REQUEST,
                },
                e.message,
            )
        })?;

    audit(
        &state,
        &actor,
        AuditOptions::new("dataset.quality.evaluate", "dataset")
            .resource_id(Some(&id))
            .resource_name(Some(&dataset_name))
            .detail(Some(&format!(
                "v{version_number}: {} passed / {} failed",
                result.passed, result.failed
            ))),
    )
    .await;

    Ok(json_ok(json!({
        "qualityState": result.quality_state,
        "versionNumber": result.version_number,
        "results": result.results,
        "passed": result.passed,
        "failed": result.failed,
    })))
}
