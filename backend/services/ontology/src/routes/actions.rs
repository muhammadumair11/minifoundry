//! Action routes:
//! - /api/ontology/actions [GET,POST] + /{id} [PATCH,DELETE] — admin CRUD
//!   (full serializer with write-back config), editor+ for writes.
//! - /api/actions [GET], /api/actions/logs [GET], /api/actions/{apiName} [GET]
//!   — public reads.
//! - /api/actions/{apiName}/apply [POST] — execution (editor+).

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, Uri};
use axum::response::Response;
use mf_types::Value;
use mf_web::{
    actor_from_headers, json_created, json_ok, no_content, require_role, ApiError, ApiResult,
};
use serde_json::Map;

use crate::actions::apply_action;
use crate::assemble::dataset_map;
use crate::audit::{self, AuditOptions};
use crate::dbx;
use crate::jsonutil::{
    as_object, check_max_len, check_regex, enum_or_err, kind_of, nullish_str, opt_bool, parse_body,
    query_param,
};
use crate::serialize::{
    normalize_parameters, serialize_action_full, serialize_action_public, serialize_action_summary,
    slug_re, slugify, SLUG_MSG,
};
use crate::state::*;

const OPERATIONS: [&str; 3] = ["create", "update", "delete"];
const WRITE_MODES: [&str; 2] = ["append", "upsert"];

/// Find an action by ID first, then apiName (admin [id] routes' order).
async fn find_action_id_first(
    db: &sqlx::PgPool,
    id_or_api: &str,
) -> Result<Option<ActionTypeRow>, ApiError> {
    let q = format!("SELECT {ACTION_COLS} FROM action_types WHERE id = $1");
    if let Some(row) = sqlx::query_as::<_, ActionTypeRow>(&q)
        .bind(id_or_api)
        .fetch_optional(db)
        .await?
    {
        return Ok(Some(row));
    }
    dbx::find_action_type(db, id_or_api).await
}

async fn action_by_id(db: &sqlx::PgPool, id: &str) -> Result<Option<ActionTypeRow>, ApiError> {
    let q = format!("SELECT {ACTION_COLS} FROM action_types WHERE id = $1");
    Ok(sqlx::query_as::<_, ActionTypeRow>(&q)
        .bind(id)
        .fetch_optional(db)
        .await?)
}

async fn object_type_for(
    db: &sqlx::PgPool,
    action: &ActionTypeRow,
) -> Result<ObjectTypeRow, ApiError> {
    dbx::object_type_by_id(db, &action.object_type_id)
        .await?
        .ok_or_else(|| ApiError::internal("action's object type vanished"))
}

// ─── GET /api/ontology/actions ────────────────────────────────────────────

pub async fn list_action_types(State(state): State<AppState>) -> ApiResult<Response> {
    let q = format!("SELECT {ACTION_COLS} FROM action_types ORDER BY created_at ASC, api_name ASC");
    let actions: Vec<ActionTypeRow> = sqlx::query_as(&q).fetch_all(&state.db).await?;
    let datasets = dataset_map(&state).await;
    let mut out = Vec::with_capacity(actions.len());
    for a in &actions {
        let ot = object_type_for(&state.db, a).await?;
        let target_name = a
            .target_dataset_id
            .as_ref()
            .and_then(|id| datasets.get(id))
            .map(|d| d.name.clone());
        out.push(serialize_action_full(a, &ot, target_name.as_deref()));
    }
    Ok(json_ok(serde_json::json!({ "actions": out })))
}

// ─── POST /api/ontology/actions ───────────────────────────────────────────

/// Parsed write-back config input.
struct WritebackInput {
    target_dataset_id: String,
    write_mode: String,
    key_property: Option<String>,
}

fn parse_writeback(v: &Value, path: &str) -> Result<WritebackInput, ApiError> {
    let Value::Object(m) = v else {
        return Err(ApiError::bad_request(format!(
            "{path}: Invalid input: expected object, received {}",
            kind_of(v)
        )));
    };
    let target_dataset_id = match m.get("targetDatasetId").and_then(|x| x.as_str()) {
        Some(s) if !s.is_empty() => s.to_string(),
        Some(_) => {
            return Err(ApiError::bad_request(format!(
                "{path}.targetDatasetId: Too small: expected string to have >=1 chars"
            )))
        }
        None => {
            return Err(ApiError::bad_request(format!(
                "{path}.targetDatasetId: Invalid input: expected string, received undefined"
            )))
        }
    };
    let write_mode = match m.get("writeMode").and_then(|x| x.as_str()) {
        Some(s) => enum_or_err(s, &format!("{path}.writeMode"), &WRITE_MODES)?.to_string(),
        None => {
            return Err(ApiError::bad_request(format!(
                "{path}.writeMode: Invalid input: expected string, received undefined"
            )))
        }
    };
    let key_property = match m.get("keyProperty") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => {
            if s.is_empty() {
                return Err(ApiError::bad_request(format!(
                    "{path}.keyProperty: Too small: expected string to have >=1 chars"
                )));
            }
            Some(s.clone())
        }
        Some(other) => {
            return Err(ApiError::bad_request(format!(
                "{path}.keyProperty: Invalid input: expected string, received {}",
                kind_of(other)
            )))
        }
    };
    Ok(WritebackInput {
        target_dataset_id,
        write_mode,
        key_property,
    })
}

/// Resolve + validate the write-back target against the catalog schema.
/// Returns (targetDatasetId, writeMode, keyProperty, datasetName, columns).
async fn resolve_writeback(
    state: &AppState,
    wb: &WritebackInput,
) -> Result<(String, String, Option<String>, String, Vec<String>), ApiError> {
    let Some(dataset) = state.catalog.get_dataset(&wb.target_dataset_id).await? else {
        return Err(ApiError::not_found(format!(
            "Target dataset '{}' not found",
            wb.target_dataset_id
        )));
    };
    let Some(version) = state.catalog.head_version(&wb.target_dataset_id).await? else {
        return Err(ApiError::bad_request(format!(
            "Target dataset '{}' has no versions yet",
            dataset.name
        )));
    };
    let columns: Vec<String> = version.schema.iter().map(|c| c.name.clone()).collect();
    let mut key_property: Option<String> = None;
    if wb.write_mode == "upsert" {
        let key = wb
            .key_property
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let Some(key) = key else {
            return Err(ApiError::bad_request(
                "upsert write-back needs a keyProperty (column of the target dataset)",
            ));
        };
        if !columns.iter().any(|c| c == key) {
            return Err(ApiError::bad_request(format!(
                "keyProperty '{key}' is not a column of '{}' (columns: {})",
                dataset.name,
                columns_label(&columns)
            )));
        }
        key_property = Some(key.to_string());
    }
    Ok((
        wb.target_dataset_id.clone(),
        wb.write_mode.clone(),
        key_property,
        dataset.name.clone(),
        columns,
    ))
}

fn columns_label(columns: &[String]) -> String {
    if columns.is_empty() {
        "none".to_string()
    } else {
        columns.join(", ")
    }
}

/// Validate that every parameter's mapsTo is a column of the target.
fn check_maps_to_columns(
    params: &[Value],
    columns: &[String],
    dataset_name: &str,
) -> Result<(), ApiError> {
    for p in params {
        let api = p.get("apiName").and_then(|v| v.as_str()).unwrap_or("");
        let maps_to = p.get("mapsTo").and_then(|v| v.as_str()).unwrap_or("");
        if !columns.iter().any(|c| c == maps_to) {
            return Err(ApiError::bad_request(format!(
                "parameter '{api}' maps to column '{maps_to}' which is not in dataset '{dataset_name}' (columns: {})",
                columns_label(columns)
            )));
        }
    }
    Ok(())
}

pub async fn create_action_type(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;

    let v = parse_body(&body)?;
    let m = as_object(v)?;

    let display_name = match m.get("displayName").and_then(|x| x.as_str()) {
        Some(s) if !s.is_empty() => {
            check_max_len("displayName", s, 120)?;
            s.to_string()
        }
        Some(_) => {
            return Err(ApiError::bad_request(
                "displayName: Too small: expected string to have >=1 chars",
            ))
        }
        None => {
            return Err(ApiError::bad_request(
                "displayName: Invalid input: expected string, received undefined",
            ))
        }
    };
    let explicit_api_name = match m.get("apiName") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => {
            check_regex("apiName", s, slug_re(), SLUG_MSG)?;
            Some(s.clone())
        }
        Some(other) => {
            return Err(ApiError::bad_request(format!(
                "apiName: Invalid input: expected string, received {}",
                kind_of(other)
            )))
        }
    };
    let description = match nullish_str(&m, "description")? {
        Some(Some(s)) => {
            check_max_len("description", s, 500)?;
            Some(s.to_string())
        }
        _ => None,
    };
    let object_type_id = match m.get("objectTypeId").and_then(|x| x.as_str()) {
        Some(s) if !s.is_empty() => s.to_string(),
        Some(_) => {
            return Err(ApiError::bad_request(
                "objectTypeId: Too small: expected string to have >=1 chars",
            ))
        }
        None => {
            return Err(ApiError::bad_request(
                "objectTypeId: Invalid input: expected string, received undefined",
            ))
        }
    };
    let operation = match m.get("operation").and_then(|x| x.as_str()) {
        Some(s) => enum_or_err(s, "operation", &OPERATIONS)?.to_string(),
        None => {
            return Err(ApiError::bad_request(
                "operation: Invalid input: expected string, received undefined",
            ))
        }
    };
    let enabled = opt_bool(&m, "enabled")?.unwrap_or(true);
    let parameters_in = match m.get("parameters") {
        None | Some(Value::Null) => Value::Array(vec![]),
        Some(v) => v.clone(),
    };
    let parameters = normalize_parameters("parameters", &parameters_in)?;
    let writeback_input = match m.get("writeback") {
        None | Some(Value::Null) => None,
        Some(v) => Some(parse_writeback(v, "writeback")?),
    };

    let api_name = match &explicit_api_name {
        Some(a) => a.clone(),
        None => {
            let derived = slugify(&display_name);
            if !slug_re().is_match(&derived) {
                return Err(ApiError::bad_request(format!(
                    "Could not derive a valid apiName from displayName '{display_name}' — provide apiName explicitly"
                )));
            }
            derived
        }
    };
    let taken: Option<(String,)> =
        sqlx::query_as("SELECT id FROM action_types WHERE api_name = $1")
            .bind(&api_name)
            .fetch_optional(&state.db)
            .await?;
    if taken.is_some() {
        return Err(ApiError::bad_request(format!(
            "apiName '{api_name}' is already in use"
        )));
    }

    let Some(object_type) = dbx::object_type_by_id(&state.db, &object_type_id).await? else {
        return Err(ApiError::not_found(format!(
            "Object type '{object_type_id}' not found"
        )));
    };

    let pk_count = parameters
        .iter()
        .filter(|p| p.get("isPk").and_then(|v| v.as_bool()) == Some(true))
        .count();
    if pk_count > 1 {
        return Err(ApiError::bad_request(
            "At most one parameter can be marked isPk",
        ));
    }
    if writeback_input.is_none()
        && (operation == "update" || operation == "delete")
        && pk_count == 0
    {
        return Err(ApiError::bad_request(format!(
            "{operation} actions need one parameter marked isPk (maps to the object key column)"
        )));
    }

    let mut target_dataset_id: Option<String> = None;
    let mut write_mode: Option<String> = None;
    let mut key_property: Option<String> = None;
    let mut target_name: Option<String> = None;
    if let Some(wb) = &writeback_input {
        let (tid, wm, kp, name, columns) = resolve_writeback(&state, wb).await?;
        check_maps_to_columns(&parameters, &columns, &name)?;
        target_dataset_id = Some(tid);
        write_mode = Some(wm);
        key_property = kp;
        target_name = Some(name);
    }

    let id = mf_db::new_id();
    sqlx::query(
        "INSERT INTO action_types (id, api_name, display_name, description, object_type_id, \
         operation, parameters_json, enabled, target_dataset_id, write_mode, key_property) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
    )
    .bind(&id)
    .bind(&api_name)
    .bind(&display_name)
    .bind(&description)
    .bind(&object_type.id)
    .bind(&operation)
    .bind(sqlx::types::Json(Value::Array(parameters)))
    .bind(enabled)
    .bind(&target_dataset_id)
    .bind(&write_mode)
    .bind(&key_property)
    .execute(&state.db)
    .await?;

    let action = action_by_id(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::internal("action vanished after create"))?;

    let detail = match (&target_dataset_id, &write_mode) {
        (Some(_), Some(wm)) => format!(
            "{} ({operation}) with write-back to a target dataset ({wm}{})",
            action.api_name,
            match &key_property {
                Some(k) => format!(", key {k}"),
                None => String::new(),
            }
        ),
        _ => format!(
            "{} ({operation}) on {}",
            action.api_name, object_type.display_name
        ),
    };
    audit::audit(
        &state,
        &actor,
        AuditOptions::new("ontology.action_create", "ontology")
            .resource_id(Some(&action.id))
            .resource_name(Some(&action.display_name))
            .detail(Some(&detail)),
    )
    .await;

    Ok(json_created(serde_json::json!({
        "action": serialize_action_full(&action, &object_type, target_name.as_deref())
    })))
}

// ─── PATCH /api/ontology/actions/{id} ─────────────────────────────────────

pub async fn update_action_type(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;

    let Some(existing) = find_action_id_first(&state.db, &id).await? else {
        return Err(ApiError::not_found(format!("Action '{id}' not found")));
    };

    let v = parse_body(&body)?;
    let m = as_object(v)?;

    let display_name = match m.get("displayName") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => {
            if s.is_empty() {
                return Err(ApiError::bad_request(
                    "displayName: Too small: expected string to have >=1 chars",
                ));
            }
            check_max_len("displayName", s, 120)?;
            Some(s.clone())
        }
        Some(other) => {
            return Err(ApiError::bad_request(format!(
                "displayName: Invalid input: expected string, received {}",
                kind_of(other)
            )))
        }
    };
    let description = nullish_str(&m, "description")?;
    if let Some(Some(s)) = &description {
        check_max_len("description", s, 500)?;
    }
    let operation = match m.get("operation") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(enum_or_err(s, "operation", &OPERATIONS)?.to_string()),
        Some(other) => {
            return Err(ApiError::bad_request(format!(
                "operation: Invalid input: expected string, received {}",
                kind_of(other)
            )))
        }
    };
    let enabled = opt_bool(&m, "enabled")?;
    let parameters_in = match m.get("parameters") {
        None | Some(Value::Null) => None,
        Some(v) => Some(v.clone()),
    };
    let parameters = match &parameters_in {
        Some(v) => Some(normalize_parameters("parameters", v)?),
        None => None,
    };
    // writeback: absent = keep; null = clear; object = set (validated)
    let writeback_present = m.get("writeback").is_some();
    let writeback_value = m.get("writeback").cloned();

    let mut wb: Option<(Option<String>, Option<String>, Option<String>)> = None;
    let mut resolved_columns: Option<(String, Vec<String>)> = None;
    if writeback_present {
        match writeback_value {
            None | Some(Value::Null) => wb = Some((None, None, None)),
            Some(v) => {
                let input = parse_writeback(&v, "writeback")?;
                let (tid, wm, kp, name, columns) = resolve_writeback(&state, &input).await?;
                resolved_columns = Some((name, columns));
                wb = Some((Some(tid), Some(wm), kp));
            }
        }
    }

    let operation_eff = operation
        .clone()
        .unwrap_or_else(|| existing.operation.clone());
    let parameters_eff: Vec<Value> = match &parameters {
        Some(p) => p.clone(),
        None => existing
            .parameters_json
            .0
            .as_array()
            .cloned()
            .unwrap_or_default(),
    };
    let pk_count = parameters_eff
        .iter()
        .filter(|p| p.get("isPk").and_then(|v| v.as_bool()) == Some(true))
        .count();
    if pk_count > 1 {
        return Err(ApiError::bad_request(
            "At most one parameter can be marked isPk",
        ));
    }
    let has_writeback = match &wb {
        Some((tid, ..)) => tid.is_some(),
        None => existing.target_dataset_id.is_some(),
    };
    if !has_writeback && (operation_eff == "update" || operation_eff == "delete") && pk_count == 0 {
        return Err(ApiError::bad_request(format!(
            "{operation_eff} actions need one parameter marked isPk (maps to the object key column)"
        )));
    }
    // When the parameters themselves changed, every mapsTo must be a column
    // of the (current or new) write-back target. A MISSING target dataset
    // silently skips the check (legacy `if (dataset)` guard).
    if parameters.is_some() && has_writeback {
        let target_id = match &wb {
            Some((tid, ..)) => tid.clone(),
            None => existing.target_dataset_id.clone(),
        };
        if let Some(tid) = target_id {
            let reuse = resolved_columns
                .clone()
                .filter(|_| wb.as_ref().and_then(|w| w.0.as_deref()) == Some(tid.as_str()));
            let (name, cols) = match reuse {
                Some(c) => c,
                None => match state.catalog.get_dataset(&tid).await? {
                    Some(ds) => {
                        let cols = state
                            .catalog
                            .head_version(&tid)
                            .await?
                            .map(|v| v.schema.iter().map(|c| c.name.clone()).collect::<Vec<_>>())
                            .unwrap_or_default();
                        (ds.name, cols)
                    }
                    None => (String::new(), Vec::new()),
                },
            };
            if !name.is_empty() {
                check_maps_to_columns(&parameters_eff, &cols, &name)?;
            }
        }
    }

    // UPDATE — build the statement dynamically over the provided fields.
    let mut sets: Vec<String> = vec!["updated_at = now()".into()];
    let mut idx = 1usize;
    let mut binds: Vec<Value> = Vec::new();
    macro_rules! push_set {
        ($col:expr, $val:expr) => {{
            sets.push(format!("{} = ${idx}", $col));
            binds.push($val);
            idx += 1;
        }};
    }
    if let Some(dn) = &display_name {
        push_set!("display_name", Value::String(dn.clone()));
    }
    if let Some(desc) = &description {
        push_set!(
            "description",
            match *desc {
                Some(s) => Value::String(s.to_string()),
                None => Value::Null,
            }
        );
    }
    if let Some(op) = &operation {
        push_set!("operation", Value::String(op.clone()));
    }
    if let Some(en) = enabled {
        push_set!("enabled", Value::Bool(en));
    }
    if let Some(params) = &parameters {
        push_set!("parameters_json", Value::Array(params.clone()));
    }
    if let Some((tid, wm, kp)) = &wb {
        push_set!(
            "target_dataset_id",
            tid.clone().map(Value::String).unwrap_or(Value::Null)
        );
        push_set!(
            "write_mode",
            wm.clone().map(Value::String).unwrap_or(Value::Null)
        );
        push_set!(
            "key_property",
            kp.clone().map(Value::String).unwrap_or(Value::Null)
        );
    }
    let sql = format!(
        "UPDATE action_types SET {} WHERE id = ${idx}",
        sets.join(", ")
    );
    binds.push(Value::String(existing.id.clone()));
    let mut q = sqlx::query(&sql);
    for b in &binds {
        q = match b {
            Value::String(s) => {
                // parameters_json / description stored via JSON binding below;
                // plain strings elsewhere — disambiguate by column set
                q.bind(s.clone())
            }
            Value::Bool(b) => q.bind(*b),
            Value::Null => q.bind(None::<String>),
            Value::Array(a) => q.bind(sqlx::types::Json(Value::Array(a.clone()))),
            _ => q.bind(b.to_string()),
        };
    }
    q.execute(&state.db).await?;

    let action = action_by_id(&state.db, &existing.id)
        .await?
        .ok_or_else(|| ApiError::internal("action vanished after update"))?;
    let object_type = object_type_for(&state.db, &action).await?;

    let mut target_name: Option<String> = None;
    if let Some(tid) = &action.target_dataset_id {
        target_name = state
            .catalog
            .get_dataset(tid)
            .await
            .ok()
            .flatten()
            .map(|d| d.name);
    }

    let detail = format!(
        "{} updated (operation {}{})",
        action.api_name,
        action.operation,
        match (&action.target_dataset_id, &action.write_mode) {
            (Some(_), Some(wm)) => format!(", write-back {wm}"),
            _ => ", no write-back".to_string(),
        }
    );
    audit::audit(
        &state,
        &actor,
        AuditOptions::new("ontology.action_update", "ontology")
            .resource_id(Some(&action.id))
            .resource_name(Some(&action.display_name))
            .detail(Some(&detail)),
    )
    .await;

    Ok(json_ok(serde_json::json!({
        "action": serialize_action_full(&action, &object_type, target_name.as_deref())
    })))
}

// ─── DELETE /api/ontology/actions/{id} ────────────────────────────────────

pub async fn delete_action_type(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;

    let Some(existing) = find_action_id_first(&state.db, &id).await? else {
        return Err(ApiError::not_found(format!("Action '{id}' not found")));
    };
    sqlx::query("DELETE FROM action_types WHERE id = $1")
        .bind(&existing.id)
        .execute(&state.db)
        .await?;
    audit::audit(
        &state,
        &actor,
        AuditOptions::new("ontology.action_delete", "ontology")
            .resource_id(Some(&existing.id))
            .resource_name(Some(&existing.display_name))
            .detail(Some(&format!(
                "apiName '{}' (its action logs cascaded)",
                existing.api_name
            ))),
    )
    .await;
    Ok(no_content())
}

// ─── Public reads ─────────────────────────────────────────────────────────

/// GET /api/actions — all action types with object type + param count.
pub async fn list_actions_public(State(state): State<AppState>) -> ApiResult<Response> {
    let q = format!("SELECT {ACTION_COLS} FROM action_types ORDER BY created_at ASC, api_name ASC");
    let actions: Vec<ActionTypeRow> = sqlx::query_as(&q).fetch_all(&state.db).await?;
    let mut out = Vec::with_capacity(actions.len());
    for a in &actions {
        let ot = object_type_for(&state.db, a).await?;
        out.push(serialize_action_summary(a, &ot));
    }
    Ok(json_ok(serde_json::json!({ "actions": out })))
}

#[derive(sqlx::FromRow)]
struct LogJoin {
    id: String,
    params_json: sqlx::types::Json<Value>,
    result: String,
    message: Option<String>,
    object_pk: Option<String>,
    version_number: Option<i32>,
    created_at: chrono::DateTime<chrono::Utc>,
    api_name: String,
    display_name: String,
    object_type_display_name: String,
}

/// GET /api/actions/logs?limit=50 — latest log entries, newest first.
pub async fn list_action_logs(State(state): State<AppState>, uri: Uri) -> ApiResult<Response> {
    let limit = {
        let raw = query_param(&uri, "limit");
        let n = match raw {
            Some(s) => s.trim().parse::<f64>().unwrap_or(f64::NAN),
            None => 50.0,
        };
        let n = if n.is_nan() { 0.0 } else { n.floor() };
        let n = if n == 0.0 { 50.0 } else { n };
        (n.clamp(1.0, 200.0)) as i64
    };
    let logs: Vec<LogJoin> = sqlx::query_as(
        "SELECT l.id, l.params_json, l.result, l.message, l.object_pk, l.version_number, \
         l.created_at, a.api_name, a.display_name, ot.display_name AS object_type_display_name \
         FROM action_logs l \
         JOIN action_types a ON a.id = l.action_type_id \
         JOIN object_types ot ON ot.id = a.object_type_id \
         ORDER BY l.created_at DESC, l.id DESC LIMIT $1",
    )
    .bind(limit)
    .fetch_all(&state.db)
    .await?;
    let out: Vec<Value> = logs
        .iter()
        .map(|l| {
            let params = match &l.params_json.0 {
                Value::Object(o) => Value::Object(o.clone()),
                _ => serde_json::json!({}),
            };
            serde_json::json!({
                "id": l.id,
                "actionApiName": l.api_name,
                "actionDisplayName": l.display_name,
                "objectTypeDisplayName": l.object_type_display_name,
                "result": l.result,
                "message": l.message,
                "objectPk": l.object_pk,
                "versionNumber": l.version_number,
                "params": params,
                "createdAt": mf_types::ts::format(&l.created_at),
            })
        })
        .collect();
    Ok(json_ok(serde_json::json!({ "logs": out })))
}

/// GET /api/actions/{api_name} — single action with parsed parameters
/// (apiName first, then id).
pub async fn get_action_public(
    State(state): State<AppState>,
    Path(api_name): Path<String>,
) -> ApiResult<Response> {
    let Some(action) = dbx::find_action_type(&state.db, &api_name).await? else {
        return Err(ApiError::not_found(format!(
            "Action '{api_name}' not found"
        )));
    };
    let ot = object_type_for(&state.db, &action).await?;
    Ok(json_ok(serde_json::json!({
        "action": serialize_action_public(&action, &ot)
    })))
}

/// POST /api/actions/{api_name}/apply — validate + execute (editor+).
pub async fn apply(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(api_name): Path<String>,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;

    let Some(action) = dbx::find_action_type(&state.db, &api_name).await? else {
        return Err(ApiError::not_found(format!(
            "Action '{api_name}' not found"
        )));
    };

    let v = parse_body(&body)?;
    let m = as_object(v)?;
    let params: Map<String, Value> = match m.get("params") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(o)) => o.clone(),
        Some(other) => {
            return Err(ApiError::bad_request(format!(
                "params: Invalid input: expected object, received {}",
                kind_of(other)
            )))
        }
    };

    let object_type = object_type_for(&state.db, &action).await?;
    match apply_action(&state, &action, &object_type, &params).await {
        Ok(mut result) => {
            let version_number = result
                .get("versionNumber")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            let row_count = result.get("rowCount").and_then(|v| v.as_i64()).unwrap_or(0);
            let object_pk = result
                .get("objectPk")
                .and_then(|v| v.as_str())
                .map(String::from);
            let detail = format!(
                "{} on {}{} -> v{version_number} ({row_count} rows)",
                action.api_name,
                object_type.display_name,
                match &object_pk {
                    Some(pk) => format!(" '{pk}'"),
                    None => String::new(),
                }
            );
            audit::audit(
                &state,
                &actor,
                AuditOptions::new("action.apply", "ontology")
                    .resource_id(Some(&action.id))
                    .resource_name(Some(&action.display_name))
                    .detail(Some(&detail)),
            )
            .await;
            // { ok: true, ...result } — ok FIRST, then the spread fields
            let mut out = Map::new();
            out.insert("ok".into(), Value::Bool(true));
            if let Value::Object(rm) = std::mem::replace(&mut result, Value::Null) {
                for (k, val) in rm {
                    out.insert(k, val);
                }
            }
            Ok(json_ok(Value::Object(out)))
        }
        Err(err) => {
            // applyAction already logged the failure (result: 'failed')
            let msg = err.message.clone();
            let detail = format!("FAILED {}: {msg}", action.api_name);
            audit::audit(
                &state,
                &actor,
                AuditOptions::new("action.apply", "ontology")
                    .resource_id(Some(&action.id))
                    .resource_name(Some(&action.display_name))
                    .detail(Some(&detail)),
            )
            .await;
            Err(err)
        }
    }
}
