//! /api/applications — app CRUD + chart aggregation (ports of
//! applications/route.ts, [id]/route.ts and data/route.ts).

use axum::body::Bytes;
use axum::extract::Path;
use axum::http::HeaderMap;
use axum::response::Response;
use mf_types::Value;
use mf_web::TenantState as State;
use mf_web::{actor_from_headers, json_created, json_ok, require_role, ApiError, ApiResult};
use serde_json::Map;

use crate::audit::{self, AuditOptions};
use crate::dbx;
use crate::filters::ObjectViewFilter;
use crate::jsonutil::{as_object, check_max_len, enum_or_err, kind_of, nullish_str, parse_body};
use crate::objects::{get_object_rows, GetObjectRowsOpts};
use crate::routes::effective_role;
use crate::serialize::{
    referenced_object_types, serialize_application, template_defaults, validate_app_config,
};
use crate::state::*;
use crate::values::{cell_number, js_num, js_string};

const TEMPLATES: [&str; 2] = ["blank", "supply-chain"];
const APP_AGGS: [&str; 5] = ["count", "sum", "avg", "min", "max"];
const FILTER_OPS: [&str; 7] = ["eq", "neq", "contains", "gt", "lt", "gte", "lte"];

async fn fetch_application(
    db: &sqlx::PgPool,
    id: &str,
) -> Result<Option<ApplicationRow>, ApiError> {
    let q = format!("SELECT {APPLICATION_COLS} FROM applications WHERE id = $1");
    Ok(sqlx::query_as::<_, ApplicationRow>(&q)
        .bind(id)
        .fetch_optional(db)
        .await?)
}

/// GET /api/applications — list with widget counts (updatedAt desc).
pub async fn list_applications(State(state): State<AppState>) -> ApiResult<Response> {
    let q = format!("SELECT {APPLICATION_COLS} FROM applications ORDER BY updated_at DESC");
    let rows: Vec<ApplicationRow> = sqlx::query_as(&q).fetch_all(&state.db).await?;
    let mut out = Vec::with_capacity(rows.len());
    for a in &rows {
        // legacy: parseJsonSafe → safeParse → fallback to defaults when invalid
        let safe = validate_app_config("config", &a.config_json.0).unwrap_or_else(|_| {
            serde_json::json!({
                "pages": crate::serialize::default_app_pages(),
                "widgets": [],
                "filters": [],
            })
        });
        let widget_count = safe
            .get("widgets")
            .and_then(|w| w.as_array())
            .map(|w| w.len())
            .unwrap_or(0);
        out.push(serde_json::json!({
            "id": a.id,
            "name": a.name,
            "description": a.description,
            "widgetCount": widget_count,
            "objectTypeApiNames": referenced_object_types(&safe),
            "createdAt": mf_types::ts::format(&a.created_at),
            "updatedAt": mf_types::ts::format(&a.updated_at),
        }));
    }
    Ok(json_ok(serde_json::json!({ "applications": out })))
}

/// POST /api/applications — create from a template (editor+).
pub async fn create_application(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;

    let v = parse_body(&body)?;
    let m = as_object(v)?;
    let name = match m.get("name") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => {
            if s.is_empty() {
                return Err(ApiError::bad_request("name: name is required"));
            }
            check_max_len("name", s, 200)?;
            Some(s.clone())
        }
        Some(other) => {
            return Err(ApiError::bad_request(format!(
                "name: Invalid input: expected string, received {}",
                kind_of(other)
            )))
        }
    };
    let description = match nullish_str(&m, "description")? {
        Some(Some(s)) => {
            check_max_len("description", s, 2000)?;
            Some(Some(s.to_string()))
        }
        Some(None) => Some(None),
        None => None,
    };
    let template = match m.get("template") {
        None | Some(Value::Null) => "blank".to_string(),
        Some(Value::String(s)) => enum_or_err(s, "template", &TEMPLATES)?.to_string(),
        Some(other) => {
            return Err(ApiError::bad_request(format!(
                "template: Invalid input: expected string, received {}",
                kind_of(other)
            )))
        }
    };

    let (t_name, t_description, t_config) = template_defaults(&template);
    let final_name = name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .unwrap_or_else(|| t_name.to_string());
    let final_description: Option<String> = match description {
        Some(d) => d, // explicit (null clears)
        None => {
            if t_description.is_empty() {
                None
            } else {
                Some(t_description.to_string())
            }
        }
    };

    let id = mf_db::new_id();
    sqlx::query(
        "INSERT INTO applications (id, name, description, config_json, created_by) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(&id)
    .bind(&final_name)
    .bind(&final_description)
    .bind(sqlx::types::Json(t_config))
    .bind(&actor.email)
    .execute(&state.db)
    .await?;

    let application = fetch_application(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::internal("application vanished after create"))?;
    audit::audit(
        &state,
        &actor,
        AuditOptions::new("application.create", "application")
            .resource_id(Some(&application.id))
            .resource_name(Some(&application.name))
            .detail(Some(&format!("template={template}"))),
    )
    .await;
    Ok(json_created(serde_json::json!({
        "application": serialize_application(&application)
    })))
}

/// GET /api/applications/{id}
pub async fn get_application(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let Some(application) = fetch_application(&state.db, &id).await? else {
        return Err(ApiError::not_found(format!("Application '{id}' not found")));
    };
    Ok(json_ok(serde_json::json!({
        "application": serialize_application(&application)
    })))
}

/// PATCH /api/applications/{id} — name/description/config (editor+).
pub async fn update_application(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;

    let v = parse_body(&body)?;
    let m = as_object(v)?;
    let name = match m.get("name") {
        None => None,
        Some(Value::String(s)) => {
            if s.is_empty() {
                return Err(ApiError::bad_request("name: name is required"));
            }
            check_max_len("name", s, 200)?;
            Some(s.clone())
        }
        Some(other) => {
            return Err(ApiError::bad_request(format!(
                "name: Invalid input: expected string, received {}",
                kind_of(other)
            )))
        }
    };
    let description = nullish_str(&m, "description")?;
    if let Some(Some(s)) = &description {
        check_max_len("description", s, 2000)?;
    }
    let config = match m.get("config") {
        None => None,
        Some(v) => Some(validate_app_config("config", v)?),
    };

    let Some(existing) = fetch_application(&state.db, &id).await? else {
        return Err(ApiError::not_found(format!("Application '{id}' not found")));
    };

    let new_name = name.clone().unwrap_or_else(|| existing.name.clone());
    let new_description: Option<String> = match &description {
        Some(v) => v.map(String::from),
        None => existing.description.clone(),
    };
    let new_config: Value = match &config {
        Some(c) => c.clone(),
        None => existing.config_json.0.clone(),
    };
    sqlx::query(
        "UPDATE applications SET name = $1, description = $2, config_json = $3, \
         updated_at = now() WHERE id = $4",
    )
    .bind(&new_name)
    .bind(&new_description)
    .bind(sqlx::types::Json(new_config))
    .bind(&id)
    .execute(&state.db)
    .await?;

    let updated = fetch_application(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::internal("application vanished after update"))?;

    let detail: Option<String> = match &config {
        Some(c) => {
            let widgets = c
                .get("widgets")
                .and_then(|w| w.as_array())
                .map(|w| w.len())
                .unwrap_or(0);
            let filters = c
                .get("filters")
                .and_then(|f| f.as_array())
                .map(|f| f.len())
                .unwrap_or(0);
            Some(format!(
                "widgets={widgets} filters={filters}{}",
                if name.is_some() { " (renamed)" } else { "" }
            ))
        }
        None => {
            if name.is_some() {
                Some("renamed".to_string())
            } else {
                None
            }
        }
    };
    audit::audit(
        &state,
        &actor,
        AuditOptions::new("application.update", "application")
            .resource_id(Some(&updated.id))
            .resource_name(Some(&updated.name))
            .detail(detail.as_deref()),
    )
    .await;

    Ok(json_ok(serde_json::json!({
        "application": serialize_application(&updated)
    })))
}

/// DELETE /api/applications/{id} — editor+; legacy returns { ok, deleted }.
pub async fn delete_application(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;

    let Some(existing) = fetch_application(&state.db, &id).await? else {
        return Err(ApiError::not_found(format!("Application '{id}' not found")));
    };
    sqlx::query("DELETE FROM applications WHERE id = $1")
        .bind(&id)
        .execute(&state.db)
        .await?;
    audit::audit(
        &state,
        &actor,
        AuditOptions::new("application.delete", "application")
            .resource_id(Some(&existing.id))
            .resource_name(Some(&existing.name)),
    )
    .await;
    Ok(json_ok(
        serde_json::json!({ "ok": true, "deleted": existing.id }),
    ))
}

/// POST /api/applications/data — governed chart aggregation over ontology
/// objects (global filters applied through the same path as the explorer).
pub async fn app_data(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    let role = effective_role(&actor);

    let v = parse_body(&body)?;
    let m = as_object(v)?;

    let object_type_api_name = match m.get("objectTypeApiName").and_then(|x| x.as_str()) {
        Some(s) if !s.is_empty() => {
            check_max_len("objectTypeApiName", s, 200)?;
            s.to_string()
        }
        Some(_) => {
            return Err(ApiError::bad_request(
                "objectTypeApiName: Too small: expected string to have >=1 chars",
            ))
        }
        None => {
            return Err(ApiError::bad_request(
                "objectTypeApiName: Invalid input: expected string, received undefined",
            ))
        }
    };
    let group_by = match m.get("groupBy").and_then(|x| x.as_str()) {
        Some(s) if !s.is_empty() => {
            check_max_len("groupBy", s, 200)?;
            s.to_string()
        }
        Some(_) => {
            return Err(ApiError::bad_request(
                "groupBy: Too small: expected string to have >=1 chars",
            ))
        }
        None => {
            return Err(ApiError::bad_request(
                "groupBy: Invalid input: expected string, received undefined",
            ))
        }
    };
    let agg = match m.get("agg") {
        None | Some(Value::Null) => "count".to_string(),
        Some(Value::String(s)) => enum_or_err(s, "agg", &APP_AGGS)?.to_string(),
        Some(other) => {
            return Err(ApiError::bad_request(format!(
                "agg: Invalid input: expected string, received {}",
                kind_of(other)
            )))
        }
    };
    let value_property = match nullish_str(&m, "valueProperty")? {
        Some(Some(s)) => {
            check_max_len("valueProperty", s, 200)?;
            Some(s.to_string())
        }
        _ => None,
    };
    let top_n = match m.get("topN") {
        None | Some(Value::Null) => 10i64,
        Some(Value::Number(n)) => match n.as_i64() {
            Some(i) if (1..=100).contains(&i) => i,
            _ => {
                return Err(ApiError::bad_request(
                    "topN: Invalid input: expected int between 1 and 100",
                ))
            }
        },
        Some(other) => {
            return Err(ApiError::bad_request(format!(
                "topN: Invalid input: expected number, received {}",
                kind_of(other)
            )))
        }
    };
    let filters_in = match m.get("filters") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => {
            if items.len() > 8 {
                return Err(ApiError::bad_request(
                    "filters: Too big: expected array to have <=8 items",
                ));
            }
            let mut out = Vec::with_capacity(items.len());
            for (i, item) in items.iter().enumerate() {
                let path = format!("filters.{i}");
                let Value::Object(fm) = item else {
                    return Err(ApiError::bad_request(format!(
                        "{path}: Invalid input: expected object, received {}",
                        kind_of(item)
                    )));
                };
                let property = match fm.get("property").and_then(|x| x.as_str()) {
                    Some(s) if !s.is_empty() => {
                        check_max_len(&format!("{path}.property"), s, 200)?;
                        s.to_string()
                    }
                    Some(_) => {
                        return Err(ApiError::bad_request(format!(
                            "{path}.property: Too small: expected string to have >=1 chars"
                        )))
                    }
                    None => {
                        return Err(ApiError::bad_request(format!(
                            "{path}.property: Invalid input: expected string, received undefined"
                        )))
                    }
                };
                let op = match fm.get("op").and_then(|x| x.as_str()) {
                    Some(s) => enum_or_err(s, &format!("{path}.op"), &FILTER_OPS)?.to_string(),
                    None => {
                        return Err(ApiError::bad_request(format!(
                            "{path}.op: Invalid input: expected string, received undefined"
                        )))
                    }
                };
                let value = match fm.get("value") {
                    Some(Value::String(s)) => {
                        check_max_len(&format!("{path}.value"), s, 500)?;
                        s.clone()
                    }
                    Some(other) => {
                        return Err(ApiError::bad_request(format!(
                            "{path}.value: Invalid input: expected string, received {}",
                            kind_of(other)
                        )))
                    }
                    None => {
                        return Err(ApiError::bad_request(format!(
                            "{path}.value: Invalid input: expected string, received undefined"
                        )))
                    }
                };
                out.push(ObjectViewFilter {
                    property,
                    op,
                    value,
                });
            }
            out
        }
        Some(other) => {
            return Err(ApiError::bad_request(format!(
                "filters: Invalid input: expected array, received {}",
                kind_of(other)
            )))
        }
    };

    let Some(object_type) = dbx::find_object_type(&state.db, &object_type_api_name).await? else {
        return Err(ApiError::bad_request(format!(
            "Object type '{object_type_api_name}' not found"
        )));
    };
    let properties = dbx::load_properties(&state.db, &object_type.id).await?;
    let core = dbx::type_core_of(&object_type, &properties);
    let prop_names: Vec<&str> = properties.iter().map(|p| p.api_name.as_str()).collect();
    if !prop_names.contains(&group_by.as_str()) {
        return Err(ApiError::bad_request(format!(
            "Property '{group_by}' not found"
        )));
    }
    if agg != "count" {
        let ok = value_property
            .as_deref()
            .is_some_and(|vp| prop_names.contains(&vp));
        if !ok {
            return Err(ApiError::bad_request(
                "Select a numeric value property for this aggregation",
            ));
        }
    }
    if filters_in
        .iter()
        .any(|f| !prop_names.contains(&f.property.as_str()))
    {
        return Err(ApiError::bad_request("Filter property not found"));
    }

    // Governed read: catalog masks at the caller's role and the rows envelope
    // carries the masked column list (single masking authority). A chart over
    // a hidden property is refused (legacy 'hidden for your role' guard).
    let result = get_object_rows(
        &state,
        &core,
        Some(role.as_str()),
        GetObjectRowsOpts {
            all: true,
            filters: &filters_in,
            ..Default::default()
        },
    )
    .await?;
    let masked = &result.masked_columns;
    let uses_hidden = masked.contains(&group_by)
        || value_property
            .as_deref()
            .is_some_and(|vp| masked.iter().any(|c| c == vp))
        || filters_in.iter().any(|f| masked.contains(&f.property));
    if uses_hidden {
        return Err(ApiError::bad_request(
            "This chart uses a property hidden for your role",
        ));
    }

    // group aggregation (exact legacy semantics)
    let mut keys: Vec<String> = Vec::new();
    let mut groups: std::collections::HashMap<String, (usize, Vec<f64>)> =
        std::collections::HashMap::new();
    for object_row in &result.rows {
        let raw = object_row.values.get(&group_by);
        let key = match raw {
            None | Some(Value::Null) => "(empty)".to_string(),
            Some(Value::String(s)) if s.is_empty() => "(empty)".to_string(),
            Some(v) => js_string(v),
        };
        let g = groups.entry(key.clone()).or_insert_with(|| {
            keys.push(key.clone());
            (0, Vec::new())
        });
        g.0 += 1;
        if agg != "count" {
            if let Some(vp) = &value_property {
                if let Some(n) = object_row.values.get(vp).and_then(cell_number) {
                    g.1.push(n);
                }
            }
        }
    }
    let mut rows: Vec<(String, f64)> = keys
        .iter()
        .map(|k| {
            let (count, values) = groups.get(k).unwrap();
            (k.clone(), crate::values::aggregate(&agg, *count, values))
        })
        .collect();
    // b.value - a.value || a.name.localeCompare(b.name) — desc by value, ties
    // by name asc (localeCompare approximated)
    rows.sort_by(|a, b| {
        let by_value = b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal);
        by_value.then_with(|| {
            a.0.to_lowercase()
                .cmp(&b.0.to_lowercase())
                .then_with(|| a.0.cmp(&b.0))
        })
    });
    rows.truncate(top_n.max(1) as usize);
    let out: Vec<Value> = rows
        .into_iter()
        .map(|(name, value)| {
            let mut o = Map::new();
            o.insert("name".into(), Value::String(name));
            o.insert("value".into(), js_num(value));
            Value::Object(o)
        })
        .collect();

    Ok(json_ok(
        serde_json::json!({ "rows": out, "total": result.total }),
    ))
}
