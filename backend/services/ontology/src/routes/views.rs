//! /api/objects/views — saved object views (R14.8). Port of
//! src/app/api/objects/views/route.ts + [viewId]/route.ts.

use axum::body::Bytes;
use axum::extract::Path;
use axum::http::{HeaderMap, Uri};
use axum::response::Response;
use mf_types::Value;
use mf_web::TenantState as State;
use mf_web::{
    actor_from_headers, json_created, json_ok, no_content, require_role, ApiError, ApiResult,
};
use serde_json::Map;

use crate::dbx;
use crate::filters::{MAX_VIEW_FILTERS, VIEW_FILTER_OPS};
use crate::jsonutil::{
    as_object, check_max_len, enum_or_err, kind_of, nullish_str, parse_body, query_param,
};
use crate::serialize::serialize_view;
use crate::state::*;

/// GET /api/objects/views?type={objectTypeId|apiName} — views for one type
/// (any role may READ; creation order).
pub async fn list_views(State(state): State<AppState>, uri: Uri) -> ApiResult<Response> {
    let type_param = query_param(&uri, "type")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let Some(type_param) = type_param else {
        return Err(ApiError::bad_request(
            "Missing required query parameter 'type'",
        ));
    };
    let Some(object_type) = dbx::find_object_type(&state.db, &type_param).await? else {
        return Err(ApiError::not_found(format!(
            "Object type '{type_param}' not found"
        )));
    };
    let views: Vec<ObjectViewRow> = sqlx::query_as(&format!(
        "SELECT {VIEW_COLS} FROM object_views WHERE object_type_id = $1 \
         ORDER BY created_at ASC, id ASC"
    ))
    .bind(&object_type.id)
    .fetch_all(&state.db)
    .await?;
    let out: Vec<Value> = views.iter().map(serialize_view).collect();
    Ok(json_ok(serde_json::json!({ "views": out })))
}

/// POST /api/objects/views — save a view (editor+). 409 when the name is
/// taken for this type.
pub async fn create_view(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;

    let v = parse_body(&body)?;
    let m = as_object(v)?;

    // type: z.string().min(1, 'type (object type id or apiName) is required')
    let type_ref = match m.get("type").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => s.to_string(),
        Some(_) => {
            return Err(ApiError::bad_request(
                "type: type (object type id or apiName) is required",
            ))
        }
        None => {
            return Err(ApiError::bad_request(
                "type: type (object type id or apiName) is required",
            ))
        }
    };
    // name: z.string().trim().min(1,'name is required').max(80)
    let name = match m.get("name").and_then(|v| v.as_str()) {
        Some(s) if !s.trim().is_empty() => {
            let t = s.trim().to_string();
            check_max_len("name", &t, 80)?;
            t
        }
        Some(_) => return Err(ApiError::bad_request("name: name is required")),
        None => return Err(ApiError::bad_request("name: name is required")),
    };
    // filters: array max MAX_VIEW_FILTERS of {property min1 max120, op enum, value string max500}, default []
    let filters: Vec<Value> = match m.get("filters") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => {
            if items.len() > MAX_VIEW_FILTERS {
                return Err(ApiError::bad_request(format!(
                    "filters: Too big: expected array to have <={MAX_VIEW_FILTERS} items"
                )));
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
                let property = match fm.get("property").and_then(|v| v.as_str()) {
                    Some(s) if !s.is_empty() => {
                        check_max_len(&format!("{path}.property"), s, 120)?;
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
                let op = match fm.get("op").and_then(|v| v.as_str()) {
                    Some(s) => enum_or_err(s, &format!("{path}.op"), &VIEW_FILTER_OPS)?.to_string(),
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
                let mut fo = Map::new();
                fo.insert("property".into(), Value::String(property));
                fo.insert("op".into(), Value::String(op));
                fo.insert("value".into(), Value::String(value));
                out.push(Value::Object(fo));
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
    // sortBy nullish max120; sortDir enum optional
    let sort_by = match nullish_str(&m, "sortBy")? {
        Some(Some(s)) => {
            check_max_len("sortBy", s, 120)?;
            Some(s.to_string())
        }
        _ => None,
    };
    let sort_dir = match m.get("sortDir") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(enum_or_err(s, "sortDir", &["asc", "desc"])?.to_string()),
        Some(other) => {
            return Err(ApiError::bad_request(format!(
                "sortDir: Invalid input: expected string, received {}",
                kind_of(other)
            )))
        }
    };

    let Some(object_type) = dbx::find_object_type(&state.db, &type_ref).await? else {
        return Err(ApiError::not_found(format!(
            "Object type '{type_ref}' not found"
        )));
    };

    let dup: Option<(String,)> =
        sqlx::query_as("SELECT id FROM object_views WHERE object_type_id = $1 AND name = $2")
            .bind(&object_type.id)
            .bind(&name)
            .fetch_optional(&state.db)
            .await?;
    if dup.is_some() {
        return Err(ApiError::conflict(format!(
            "A view named '{name}' already exists for {}",
            object_type.display_name
        )));
    }

    let id = mf_db::new_id();
    let sort_by_stored = sort_by
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);
    let sort_dir_stored = if sort_dir.as_deref() == Some("desc") {
        "desc"
    } else {
        "asc"
    };
    let created_by = actor.email.clone().unwrap_or_else(|| "simulator".into());
    sqlx::query(
        "INSERT INTO object_views (id, object_type_id, name, filters_json, sort_by, sort_dir, created_by) \
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(&id)
    .bind(&object_type.id)
    .bind(&name)
    .bind(sqlx::types::Json(Value::Array(filters.clone())))
    .bind(&sort_by_stored)
    .bind(sort_dir_stored)
    .bind(&created_by)
    .execute(&state.db)
    .await?;

    let view: ObjectViewRow = sqlx::query_as(&format!(
        "SELECT {VIEW_COLS} FROM object_views WHERE id = $1"
    ))
    .bind(&id)
    .fetch_one(&state.db)
    .await?;

    let filter_count = filters.len();
    let plural = if filter_count == 1 { "" } else { "s" };
    let sort_part = match &sort_by_stored {
        Some(sb) => format!(", sort {sb} {sort_dir_stored}"),
        None => String::new(),
    };
    crate::audit::audit(
        &state,
        &actor,
        crate::audit::AuditOptions::new("ontology.view_save", "ontology")
            .resource_id(Some(&view.id))
            .resource_name(Some(&view.name))
            .detail(Some(&format!(
                "saved view '{}' on {} ({filter_count} filter{plural}{sort_part})",
                view.name, object_type.api_name
            ))),
    )
    .await;

    Ok(json_created(
        serde_json::json!({ "view": serialize_view(&view) }),
    ))
}

/// DELETE /api/objects/views/{view_id} — remove a saved view (editor+).
pub async fn delete_view(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(view_id): Path<String>,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;

    let existing: Option<ObjectViewRow> = sqlx::query_as(&format!(
        "SELECT {VIEW_COLS} FROM object_views WHERE id = $1"
    ))
    .bind(&view_id)
    .fetch_optional(&state.db)
    .await?;
    let Some(existing) = existing else {
        return Err(ApiError::not_found(format!(
            "Object view '{view_id}' not found"
        )));
    };
    let object_type = dbx::object_type_by_id(&state.db, &existing.object_type_id).await?;
    let api_name = object_type
        .map(|t| t.api_name)
        .unwrap_or_else(|| "unknown".into());

    sqlx::query("DELETE FROM object_views WHERE id = $1")
        .bind(&existing.id)
        .execute(&state.db)
        .await?;

    crate::audit::audit(
        &state,
        &actor,
        crate::audit::AuditOptions::new("ontology.view_delete", "ontology")
            .resource_id(Some(&existing.id))
            .resource_name(Some(&existing.name))
            .detail(Some(&format!(
                "deleted view '{}' on {api_name}",
                existing.name
            ))),
    )
    .await;

    Ok(no_content())
}
