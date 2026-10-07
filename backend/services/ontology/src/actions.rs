//! Action execution engine — port of applyAction + applyTargetWriteback
//! (ontology-service.ts). Validates/coerces params against the action's
//! parameter definitions, mutates object rows or writes back into a target
//! dataset, and persists ActionLog rows. Version writes go through catalog's
//! single write path (POST /internal/datasets/{id}/versions) with
//! outputJobId = the pre-generated action-log id for idempotency.

use mf_types::{Row, Value};
use mf_web::ApiError;
use serde_json::Map;

use crate::state::{ActionTypeRow, AppState, ObjectTypeRow};
use crate::values::{
    find_row_index_by_pk, format_cell, generate_pk, js_num, js_number_string, loose_equal,
    normalize_rows,
};

/// Learning-scale row cap (legacy MAX_ROWS, env-overridable).
pub fn max_rows() -> usize {
    std::env::var("MAX_ROWS")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|n: &usize| *n > 0)
        .unwrap_or(5000)
}

/// One validated + coerced parameter (def metadata retained for mapping).
#[derive(Debug, Clone)]
pub struct Provided {
    pub api_name: String,
    pub maps_to: String,
    pub is_pk: bool,
    pub value: Value,
}

fn def_str(def: &Value, key: &str) -> Option<String> {
    def.get(key).and_then(|v| v.as_str()).map(String::from)
}

/// JS String(raw) coercion for string-typed params.
fn js_str_coerce(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => js_number_string(n),
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".to_string(),
        Value::Array(items) => items
            .iter()
            .map(|i| match i {
                Value::Null => String::new(),
                other => js_str_coerce(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// Validate + coerce request params against the parameter definitions.
/// Err carries the EXACT legacy failure message (caller writes the failed
/// ActionLog and maps it to 400).
pub fn validate_params(defs: &[Value], params: &Map<String, Value>) -> Result<Vec<Provided>, String> {
    let mut provided = Vec::new();
    for def in defs {
        let Some(api_name) = def_str(def, "apiName") else { continue };
        let data_type = def_str(def, "dataType").unwrap_or_else(|| "string".into());
        let required = def.get("required").and_then(|v| v.as_bool()) == Some(true);
        let maps_to = def_str(def, "mapsTo").unwrap_or_else(|| api_name.clone());
        let is_pk = def.get("isPk").and_then(|v| v.as_bool()) == Some(true);
        let one_of: Option<Vec<String>> = def
            .get("oneOf")
            .and_then(|v| v.as_array())
            .map(|items| items.iter().map(crate::values::js_string).collect())
            .filter(|v: &Vec<String>| !v.is_empty());

        let raw = params.get(&api_name);
        let missing = match raw {
            None | Some(Value::Null) => true,
            Some(Value::String(s)) => s.trim().is_empty(),
            _ => false,
        };
        if missing {
            if required {
                return Err(format!("Parameter '{api_name}' is required"));
            }
            continue;
        }
        let raw = raw.unwrap();

        let value = if data_type == "number" {
            let n = match raw {
                Value::Number(num) => num.as_f64().unwrap_or(f64::NAN),
                Value::String(s) => s.trim().parse::<f64>().ok().filter(|f| f.is_finite()).unwrap_or(f64::NAN),
                Value::Bool(b) => {
                    if *b {
                        1.0
                    } else {
                        0.0
                    }
                }
                _ => f64::NAN,
            };
            if !n.is_finite() {
                return Err(format!(
                    "Parameter '{api_name}' must be a number (got '{}')",
                    format_cell(raw)
                ));
            }
            js_num(n)
        } else if data_type == "boolean" {
            match raw {
                Value::Bool(true) => Value::Bool(true),
                Value::String(s) if s == "true" => Value::Bool(true),
                Value::Bool(false) => Value::Bool(false),
                Value::String(s) if s == "false" => Value::Bool(false),
                _ => {
                    return Err(format!(
                        "Parameter '{api_name}' must be a boolean (got '{}')",
                        format_cell(raw)
                    ))
                }
            }
        } else {
            Value::String(js_str_coerce(raw))
        };

        if let Some(options) = &one_of {
            let allowed = options
                .iter()
                .any(|o| loose_equal(&Value::String(o.clone()), &value));
            if !allowed {
                return Err(format!(
                    "Parameter '{api_name}' must be one of: {} (got '{}')",
                    options.join(", "),
                    format_cell(&value)
                ));
            }
        }
        provided.push(Provided { api_name, maps_to, is_pk, value });
    }
    Ok(provided)
}

/// Write a FAILED action log (never masks the original error).
async fn log_failure(state: &AppState, action_id: &str, params: &Map<String, Value>, message: &str) {    let result = sqlx::query(
        "INSERT INTO action_logs (id, action_type_id, params_json, result, message) \
         VALUES ($1, $2, $3, 'failed', $4)",
    )
    .bind(mf_db::new_id())
    .bind(action_id)
    .bind(sqlx::types::Json(Value::Object(params.clone())))
    .bind(message)
    .execute(&state.db)
    .await;
    if let Err(e) = result {
        tracing::warn!(error = %e, "failed-action log insert failed (swallowed)");
    }
}

/// Validation failure → write the FAILED ActionLog, then the 400 ApiError
/// (legacy logFailure semantics: logging must never mask the original error).
async fn fail(
    state: &AppState,
    action_id: &str,
    params: &Map<String, Value>,
    message: String,
) -> ApiError {
    log_failure(state, action_id, params, &message).await;
    ApiError::bad_request(message)
}

fn is_empty_cell(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => true,
        Some(Value::String(s)) => s.is_empty(),
        _ => false,
    }
}

/// Apply an action: full legacy pipeline (disabled check → param validation →
/// write-back branch OR object operation → new dataset version → success log).
/// ROW READS ON THIS PATH ARE RAW (no `role` param): legacy applyAction
/// mutated unmasked dataJson rows — masking exists only on display surfaces,
/// and a masked read here would round-trip "------" into the new version.
/// Ok carries the response fields { versionNumber, rowCount, objectPk,
/// writeback? }; Err is the 400 `{ error }` (failed log already written for
/// validation failures, matching legacy logFailure semantics).
pub async fn apply_action(
    state: &AppState,
    action: &ActionTypeRow,
    object_type: &ObjectTypeRow,
    params: &Map<String, Value>,
) -> Result<Value, ApiError> {
    if !action.enabled {
        return Err(fail(state, &action.id, params, format!("Action '{}' is disabled", action.api_name)).await);
    }

    let defs: Vec<Value> = action
        .parameters_json
        .0
        .as_array()
        .cloned()
        .unwrap_or_default();
    let provided = match validate_params(&defs, params) {
        Ok(p) => p,
        Err(message) => return Err(fail(state, &action.id, params, message).await),
    };

    // R14.6: target-dataset write-back replaces the object operation.
    if action.target_dataset_id.is_some() && action.write_mode.is_some() {
        return apply_target_writeback(state, action, &provided, params).await;
    }

    // ── object operation on the backing dataset ────────────────────────
    let Some(dataset_id) = object_type.source_dataset_id.as_deref() else {
        return Err(fail(state, &action.id, params, format!("Object type '{}' has no backing dataset", object_type.api_name),
        )
        .await);
    };
    let summary = state.catalog.get_dataset(dataset_id).await?;
    let Some(dataset) = summary else {
        return Err(fail(state, &action.id, params, format!("Object type '{}' has no backing dataset", object_type.api_name),
        )
        .await);
    };
    let Some(mut rows) = state.catalog.head_rows(dataset_id, None).await? else {
        return Err(fail(state, &action.id, params, format!("Dataset '{}' has no versions to write back onto", dataset.name),
        )
        .await);
    };

    let pk_def = defs.iter().find(|d| d.get("isPk").and_then(|v| v.as_bool()) == Some(true));
    let pk_def_api = pk_def.and_then(|d| def_str(d, "apiName"));
    let pk_def_maps_to = pk_def.and_then(|d| def_str(d, "mapsTo"));
    let pk_entry = pk_def_api
        .as_ref()
        .and_then(|api| provided.iter().find(|p| &p.api_name == api));

    let operation = action.operation.as_str();
    let mut object_pk: Option<String> = None;
    let message_head: String;

    if operation == "update" || operation == "delete" {
        let (Some(pk_api), Some(pk_maps_to), Some(entry)) =
            (pk_def_api.clone(), pk_def_maps_to.clone(), pk_entry.cloned())
        else {
            let message = match (&pk_def_api, &pk_def_maps_to) {
                (None, _) => format!(
                    "Action '{}' is misconfigured: no isPk parameter defined",
                    action.api_name
                ),
                (Some(api), _) => format!("Parameter '{api}' is required"),
            };
            return Err(fail(state, &action.id, params, message).await);
        };
        let _ = pk_api;
        let pk = crate::values::js_string(&entry.value);
        object_pk = Some(pk.clone());
        let Some(idx) = find_row_index_by_pk(&rows, &pk_maps_to, &entry.value) else {
            return Err(fail(state, &action.id, params, format!(
                    "{} '{}' not found in dataset '{}'",
                    object_type.display_name, pk, dataset.name
                ),
            )
            .await);
        };
        if operation == "delete" {
            rows.remove(idx);
            message_head = format!("deleted {} {}", object_type.display_name, pk);
        } else {
            let changes: Vec<&Provided> = provided.iter().filter(|p| !p.is_pk).collect();
            if changes.is_empty() {
                return Err(fail(state, &action.id, params, "No fields to update: provide at least one non-primary-key parameter".into(),
                )
                .await);
            }
            let mut row = rows[idx].clone();
            let mut parts: Vec<String> = Vec::with_capacity(changes.len());
            for c in changes {
                let before = match row.get(&c.maps_to) {
                    Some(v) => format_cell(v),
                    None => "(missing)".to_string(),
                };
                row.insert(c.maps_to.clone(), c.value.clone());
                parts.push(format!("{}: {before} -> {}", c.maps_to, format_cell(&c.value)));
            }
            rows[idx] = row;
            message_head = format!(
                "updated {} {}: {}",
                object_type.display_name,
                pk,
                parts.join(", ")
            );
        }
    } else if operation == "create" {
        let mut new_row = Row::new();
        for p in &provided {
            new_row.insert(p.maps_to.clone(), p.value.clone());
        }
        let pk_column = pk_def_maps_to
            .clone()
            .or_else(|| object_type.primary_key.clone());
        if let Some(col) = &pk_column {
            if is_empty_cell(new_row.get(col)) {
                let generated = generate_pk(&rows, col);
                new_row.insert(col.clone(), generated);
            }
            object_pk = new_row.get(col).map(crate::values::js_string);
        }
        rows.push(new_row);
        message_head = match &object_pk {
            Some(pk) if !pk.is_empty() => format!("created {} {}", object_type.display_name, pk),
            _ => format!("created {}", object_type.display_name),
        };
    } else {
        return Err(fail(state, &action.id, params, format!(
                "Action '{}' has unknown operation '{}'",
                action.api_name, operation
            ),
        )
        .await);
    };

    // ── write NEW version on the SAME dataset (immutable versioning) ───
    let cap = max_rows();
    if rows.len() > cap {
        // legacy createDatasetFromRows guard: raw error, no failed log
        return Err(ApiError::bad_request(format!(
            "Dataset version has {} rows; the current storage limit is {cap}. No rows were written.",
            rows.len()
        )));
    }
    let normalized = normalize_rows(&rows);
    let log_id = mf_db::new_id();
    let result = state
        .catalog
        .append_version(
            dataset_id,
            &serde_json::json!({
                "rows": normalized,
                "createdBy": format!("action:{}", action.api_name),
                "outputJobId": log_id,
            }),
        )
        .await?;
    let message = format!("{message_head} (v{})", result.version_number);

    let coerced = coerced_params(&provided);
    insert_success_log(
        state,
        &log_id,
        &action.id,
        &coerced,
        &message,
        object_pk.as_deref(),
        result.version_number,
    )
    .await;

    Ok(serde_json::json!({
        "versionNumber": result.version_number,
        "rowCount": result.row_count,
        "objectPk": object_pk,
    }))
}

/// R14.6 — target-dataset write-back (append or upsert into the TARGET
/// dataset as a new version). Reads RAW rows (see apply_action docs).
async fn apply_target_writeback(
    state: &AppState,
    action: &ActionTypeRow,
    provided: &[Provided],
    raw_params: &Map<String, Value>,
) -> Result<Value, ApiError> {
    let target_id = action.target_dataset_id.clone().unwrap_or_default();
    let Some(target) = state.catalog.get_dataset(&target_id).await? else {
        return Err(fail(state, &action.id, raw_params, format!("Write-back target dataset '{target_id}' not found"),
        )
        .await);
    };
    // head rows (RAW — write path) carry the resolved version's schema too
    let Some(payload) = state.catalog.head_rows_full(&target_id, None).await? else {
        return Err(fail(state, &action.id, raw_params, format!("Target dataset '{}' has no versions to write back onto", target.name),
        )
        .await);
    };
    let schema = payload.schema;
    let mut rows = payload.rows;

    let mode = if action.write_mode.as_deref() == Some("upsert") {
        "upsert"
    } else {
        "append"
    };
    let key_property = action
        .key_property
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);

    if mode == "upsert" {
        let Some(key) = key_property.as_deref() else {
            return Err(fail(state, &action.id, raw_params, format!(
                    "Action '{}' is misconfigured: upsert write-back needs a key property",
                    action.api_name
                ),
            )
            .await);
        };
        if !schema.iter().any(|c| c.name == key) {
            return Err(fail(state, &action.id, raw_params, format!("Key property '{key}' is not a column of dataset '{}'", target.name),
            )
            .await);
        }
    }

    // Row built from the mapped parameters (key column included when mapped).
    let mut mapped = Row::new();
    for p in provided {
        mapped.insert(p.maps_to.clone(), p.value.clone());
    }

    // The parameter carrying the upsert key: isPk param or mapsTo===keyProperty.
    let key_entry = if mode == "upsert" {
        provided.iter().find(|p| {
            p.is_pk || (key_property.as_deref().is_some_and(|k| p.maps_to == k))
        })
    } else {
        None
    };
    if mode == "upsert" && key_entry.is_none() {
        return Err(fail(state, &action.id, raw_params, format!(
                "No parameter maps to the key property '{}' — add an isPk parameter mapped to it",
                key_property.clone().unwrap_or_default()
            ),
        )
        .await);
    }

    let mut object_pk: Option<String> = None;
    let mut outcome = "appended";

    if mode == "upsert" {
        let entry = key_entry.unwrap();
        let key = key_property.clone().unwrap_or_default();
        let key_value = entry.value.clone();
        let idx = find_row_index_by_pk(&rows, &key, &key_value);
        object_pk = Some(crate::values::js_string(&key_value));
        match idx {
            Some(i) => {
                // merge: existing keys keep position, mapped values overwrite
                for (k, v) in &mapped {
                    rows[i].insert(k.clone(), v.clone());
                }
                outcome = "merged";
            }
            None => {
                let mut new_row = Row::new();
                for col in &schema {
                    new_row.insert(col.name.clone(), Value::Null); // unmapped schema columns
                }
                for (k, v) in &mapped {
                    new_row.insert(k.clone(), v.clone());
                }
                if is_empty_cell(new_row.get(&key)) {
                    new_row.insert(key.clone(), key_value);
                }
                rows.push(new_row);
            }
        }
    } else {
        // append
        let mut new_row = Row::new();
        for col in &schema {
            new_row.insert(col.name.clone(), Value::Null); // unmapped schema columns
        }
        for (k, v) in &mapped {
            new_row.insert(k.clone(), v.clone());
        }
        if let Some(key) = &key_property {
            if is_empty_cell(new_row.get(key)) {
                let generated = generate_pk(&rows, key);
                new_row.insert(key.clone(), generated);
            }
            object_pk = new_row.get(key).map(crate::values::js_string);
        }
        rows.push(new_row);
    }

    // legacy appendDatasetVersion guard (raw error, no failed log)
    let cap = max_rows();
    if rows.len() > cap {
        return Err(ApiError::bad_request(format!(
            "Write-back has {} rows; the current storage limit is {cap}. No version was written.",
            rows.len()
        )));
    }
    let normalized = normalize_rows(&rows);
    let log_id = mf_db::new_id();
    let mut body = serde_json::json!({
        "rows": normalized,
        "createdBy": format!("action:{}", action.api_name),
        "outputJobId": log_id,
    });
    if !schema.is_empty() {
        // write-backs extend a typed dataset: carry the schema over instead of
        // re-deriving it (legacy appendDatasetVersion behavior)
        body["schema"] = serde_json::to_value(&schema).unwrap_or(Value::Null);
    }
    let result = state.catalog.append_version(&target_id, &body).await?;

    let message = if mode == "upsert" {
        format!(
            "Wrote back to {} v{} (upsert, {outcome})",
            target.name, result.version_number
        )
    } else {
        format!("Wrote back to {} v{} (append)", target.name, result.version_number)
    };

    let coerced = coerced_params(provided);
    insert_success_log(
        state,
        &log_id,
        &action.id,
        &coerced,
        &message,
        object_pk.as_deref(),
        result.version_number,
    )
    .await;

    Ok(serde_json::json!({
        "versionNumber": result.version_number,
        "rowCount": result.row_count,
        "objectPk": object_pk,
        "writeback": {
            "datasetId": target_id,
            "datasetName": target.name,
            "mode": mode,
            "outcome": outcome,
        },
    }))
}

/// The coerced param map stored on success logs (apiName → coerced value).
fn coerced_params(provided: &[Provided]) -> Map<String, Value> {
    let mut m = Map::new();
    for p in provided {
        m.insert(p.api_name.clone(), p.value.clone());
    }
    m
}

async fn insert_success_log(
    state: &AppState,
    log_id: &str,
    action_type_id: &str,
    params: &Map<String, Value>,
    message: &str,
    object_pk: Option<&str>,
    version_number: i64,
) {
    let result = sqlx::query(
        "INSERT INTO action_logs (id, action_type_id, params_json, result, message, object_pk, version_number) \
         VALUES ($1, $2, $3, 'success', $4, $5, $6)",
    )
    .bind(log_id)
    .bind(action_type_id)
    .bind(sqlx::types::Json(Value::Object(params.clone())))
    .bind(message)
    .bind(object_pk)
    .bind(version_number as i32)
    .execute(&state.db)
    .await;
    if let Err(e) = result {
        tracing::warn!(error = %e, "success action-log insert failed (swallowed)");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn def(v: Value) -> Value {
        v
    }

    fn params(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn required_and_missing() {
        let defs = vec![def(json!({"apiName": "a", "dataType": "string", "mapsTo": "ca", "required": true})),
                        def(json!({"apiName": "b", "dataType": "string", "mapsTo": "cb"}))];
        // missing required
        let e = validate_params(&defs, &params(json!({}))).unwrap_err();
        assert_eq!(e, "Parameter 'a' is required");
        // blank string counts as missing
        let e = validate_params(&defs, &params(json!({"a": "  "}))).unwrap_err();
        assert_eq!(e, "Parameter 'a' is required");
        // optional skipped
        let p = validate_params(&defs, &params(json!({"a": "x"}))).unwrap();
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].value, json!("x"));
        // null counts as missing
        let e = validate_params(&defs, &params(json!({"a": null}))).unwrap_err();
        assert_eq!(e, "Parameter 'a' is required");
    }

    #[test]
    fn number_coercion() {
        let defs = vec![def(json!({"apiName": "n", "dataType": "number", "mapsTo": "c", "required": true}))];
        let p = validate_params(&defs, &params(json!({"n": 42}))).unwrap();
        assert_eq!(p[0].value, json!(42));
        let p = validate_params(&defs, &params(json!({"n": " 3.5 "}))).unwrap();
        assert_eq!(p[0].value, json!(3.5));
        let p = validate_params(&defs, &params(json!({"n": true}))).unwrap();
        assert_eq!(p[0].value, json!(1));
        let e = validate_params(&defs, &params(json!({"n": "abc"}))).unwrap_err();
        assert_eq!(e, "Parameter 'n' must be a number (got 'abc')");
        let e = validate_params(&defs, &params(json!({"n": {"x":1}}))).unwrap_err();
        assert_eq!(e, r#"Parameter 'n' must be a number (got '{"x":1}')"#);
    }

    #[test]
    fn boolean_coercion() {
        let defs = vec![def(json!({"apiName": "b", "dataType": "boolean", "mapsTo": "c", "required": true}))];
        assert_eq!(validate_params(&defs, &params(json!({"b": true}))).unwrap()[0].value, json!(true));
        assert_eq!(validate_params(&defs, &params(json!({"b": "false"}))).unwrap()[0].value, json!(false));
        let e = validate_params(&defs, &params(json!({"b": "yes"}))).unwrap_err();
        assert_eq!(e, "Parameter 'b' must be a boolean (got 'yes')");
        let e = validate_params(&defs, &params(json!({"b": 1}))).unwrap_err();
        assert_eq!(e, "Parameter 'b' must be a boolean (got '1')");
    }

    #[test]
    fn string_coercion_keeps_scalars() {
        let defs = vec![def(json!({"apiName": "s", "dataType": "string", "mapsTo": "c", "required": true}))];
        assert_eq!(validate_params(&defs, &params(json!({"s": 5}))).unwrap()[0].value, json!("5"));
        assert_eq!(validate_params(&defs, &params(json!({"s": true}))).unwrap()[0].value, json!("true"));
        // no trim on coercion (only the missing-check trims)
        assert_eq!(validate_params(&defs, &params(json!({"s": " x "}))).unwrap()[0].value, json!(" x "));
    }

    #[test]
    fn one_of_validation() {
        let defs = vec![def(json!({
            "apiName": "newStatus", "dataType": "string", "mapsTo": "status", "required": true,
            "oneOf": ["in_transit", "delivered", "delayed", "customs"]
        }))];
        let p = validate_params(&defs, &params(json!({"newStatus": "delivered"}))).unwrap();
        assert_eq!(p[0].value, json!("delivered"));
        let e = validate_params(&defs, &params(json!({"newStatus": "nope"}))).unwrap_err();
        assert_eq!(
            e,
            "Parameter 'newStatus' must be one of: in_transit, delivered, delayed, customs (got 'nope')"
        );
        // numeric loose match against string options
        let num_defs = vec![def(json!({"apiName": "n", "dataType": "number", "mapsTo": "c", "oneOf": ["5"]}))];
        assert!(validate_params(&num_defs, &params(json!({"n": 5}))).is_ok());
    }

    #[test]
    fn pk_and_maps_to_metadata() {
        let defs = vec![def(json!({"apiName": "id", "dataType": "string", "mapsTo": "pk_col", "isPk": true, "required": true}))];
        let p = validate_params(&defs, &params(json!({"id": "A1"}))).unwrap();
        assert!(p[0].is_pk);
        assert_eq!(p[0].maps_to, "pk_col");
    }

    #[test]
    fn js_str_coerce_matches_js_string() {
        assert_eq!(js_str_coerce(&json!(5)), "5");
        assert_eq!(js_str_coerce(&json!(5.5)), "5.5");
        assert_eq!(js_str_coerce(&json!(true)), "true");
        assert_eq!(js_str_coerce(&json!([1, "a", null])), "1,a,");
        assert_eq!(js_str_coerce(&json!({"a": 1})), "[object Object]");
    }

    #[test]
    fn empty_cell_detection() {
        assert!(is_empty_cell(None));
        assert!(is_empty_cell(Some(&Value::Null)));
        assert!(is_empty_cell(Some(&json!(""))));
        assert!(!is_empty_cell(Some(&json!(0))));
        assert!(!is_empty_cell(Some(&json!("x"))));
    }

    #[test]
    fn max_rows_default() {
        assert_eq!(max_rows(), 5000);
    }
}
