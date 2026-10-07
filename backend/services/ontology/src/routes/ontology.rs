//! /api/ontology + /api/ontology/{id} — object type list/detail/create/delete
//! (ports of src/app/api/ontology/route.ts and [id]/route.ts).

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::Response;
use mf_web::{
    actor_from_headers, json_created, json_ok, no_content, require_role, ApiError, ApiResult,
};
use serde_json::Value;

use crate::assemble::{dataset_map, full_for_list, full_for_one};
use crate::audit::{self, AuditOptions};
use crate::jsonutil::{as_object, check_regex, nullish_str, opt_str, parse_body, req_str_min1_msg};
use crate::serialize::{derive_properties, serialize_object_type, slug_re, slugify, SLUG_MSG};
use crate::state::*;

/// GET /api/ontology — all object types (createdAt asc) with nested
/// properties, links and actions.
pub async fn list_object_types(State(state): State<AppState>) -> ApiResult<Response> {
    let rows: Vec<ObjectTypeRow> = sqlx::query_as(&format!(
        "SELECT {OBJECT_TYPE_COLS} FROM object_types ORDER BY created_at ASC"
    ))
    .fetch_all(&state.db)
    .await?;
    let datasets = dataset_map(&state).await;
    let fulls = full_for_list(&state, &rows, &datasets).await?;
    let out: Vec<Value> = fulls.iter().map(serialize_object_type).collect();
    Ok(json_ok(serde_json::json!({ "objectTypes": out })))
}

/// POST /api/ontology — create an object type backed by a dataset (editor+).
pub async fn create_object_type(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;

    let v = parse_body(&body)?;
    let m = as_object(v)?;

    let display_name = req_str_min1_msg(&m, "displayName", "displayName", None)?.to_string();
    // apiName optional slug
    let explicit_api_name = match m.get("apiName") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => {
            check_regex("apiName", s, slug_re(), SLUG_MSG)?;
            Some(s.clone())
        }
        Some(other) => {
            return Err(ApiError::bad_request(format!(
                "apiName: Invalid input: expected string, received {}",
                crate::jsonutil::kind_of(other)
            )))
        }
    };
    let source_dataset_id =
        req_str_min1_msg(&m, "sourceDatasetId", "sourceDatasetId", None)?.to_string();
    let primary_key = req_str_min1_msg(&m, "primaryKey", "primaryKey", None)?.to_string();
    let title_property = match opt_str(&m, "titleProperty")? {
        Some(s) => {
            if s.is_empty() {
                return Err(ApiError::bad_request(
                    "titleProperty: Too small: expected string to have >=1 chars",
                ));
            }
            Some(s.to_string())
        }
        None => None,
    };
    let description = match nullish_str(&m, "description")? {
        Some(v) => v.map(String::from),
        None => None,
    };
    let icon = match opt_str(&m, "icon")? {
        Some(s) if !s.is_empty() => Some(s.to_string()),
        Some(_) => {
            return Err(ApiError::bad_request(
                "icon: Too small: expected string to have >=1 chars",
            ))
        }
        None => None,
    };
    let color = match opt_str(&m, "color")? {
        Some(s) if !s.is_empty() => Some(s.to_string()),
        Some(_) => {
            return Err(ApiError::bad_request(
                "color: Too small: expected string to have >=1 chars",
            ))
        }
        None => None,
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

    // apiName uniqueness
    let taken: Option<(String,)> =
        sqlx::query_as("SELECT id FROM object_types WHERE api_name = $1")
            .bind(&api_name)
            .fetch_optional(&state.db)
            .await?;
    if taken.is_some() {
        return Err(ApiError::bad_request(format!(
            "apiName '{api_name}' is already in use"
        )));
    }

    // backing dataset (catalog)
    let Some(dataset) = state.catalog.get_dataset(&source_dataset_id).await? else {
        return Err(ApiError::not_found(format!(
            "Dataset '{source_dataset_id}' not found"
        )));
    };
    let Some(version) = state.catalog.head_version(&source_dataset_id).await? else {
        return Err(ApiError::bad_request(format!(
            "Dataset '{}' has no versions to derive properties from",
            dataset.name
        )));
    };
    let schema = version.schema;
    let title = title_property.clone().unwrap_or_else(|| primary_key.clone());

    let columns_label = || {
        let names: Vec<&str> = schema.iter().map(|c| c.name.as_str()).collect();
        if names.is_empty() {
            "none".to_string()
        } else {
            names.join(", ")
        }
    };
    if !schema.iter().any(|c| c.name == primary_key) {
        return Err(ApiError::bad_request(format!(
            "Primary key '{primary_key}' not found in dataset '{}' (columns: {})",
            dataset.name,
            columns_label()
        )));
    }
    if !schema.iter().any(|c| c.name == title) {
        return Err(ApiError::bad_request(format!(
            "titleProperty '{title}' not found in dataset '{}' (columns: {})",
            dataset.name,
            columns_label()
        )));
    }

    // create type + derived properties in one transaction
    let id = mf_db::new_id();
    let mut tx = state.db.begin().await?;
    sqlx::query(
        "INSERT INTO object_types (id, api_name, display_name, description, source_dataset_id, \
         primary_key, icon, color) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(&id)
    .bind(&api_name)
    .bind(&display_name)
    .bind(&description)
    .bind(&source_dataset_id)
    .bind(&primary_key)
    .bind(icon.as_deref().unwrap_or("box"))
    .bind(color.as_deref().unwrap_or("emerald"))
    .execute(&mut *tx)
    .await?;
    for p in derive_properties(&schema, &primary_key, title_property.as_deref()) {
        sqlx::query(
            "INSERT INTO properties (id, object_type_id, api_name, display_name, data_type, \
             is_title, hide_in_table) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(mf_db::new_id())
        .bind(&id)
        .bind(&p.api_name)
        .bind(&p.display_name)
        .bind(&p.data_type)
        .bind(p.is_title)
        .bind(p.hide_in_table)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    let row = crate::dbx::object_type_by_id(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::internal("object type vanished after create"))?;

    audit::audit(
        &state,
        &actor,
        AuditOptions::new("ontology.create", "ontology")
            .resource_id(Some(&row.id))
            .resource_name(Some(&row.display_name))
            .detail(Some(&format!(
                "apiName '{}' backed by dataset '{}'",
                row.api_name, dataset.name
            ))),
    )
    .await;

    let mut datasets = std::collections::HashMap::new();
    datasets.insert(
        dataset.id.clone(),
        crate::catalog::DatasetSummary {
            row_count: version.row_count,
            id: dataset.id.clone(),
            name: dataset.name.clone(),
        },
    );
    let full = full_for_one(&state, &row, &datasets).await?;
    Ok(json_created(serde_json::json!({
        "objectType": serialize_object_type(&full)
    })))
}

/// GET /api/ontology/{id} — single object type by id OR apiName.
pub async fn get_object_type(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let Some(row) = crate::dbx::find_object_type(&state.db, &id).await? else {
        return Err(ApiError::not_found(format!("Object type '{id}' not found")));
    };
    let datasets = dataset_map(&state).await;
    let full = full_for_one(&state, &row, &datasets).await?;
    Ok(json_ok(serde_json::json!({
        "objectType": serialize_object_type(&full)
    })))
}

/// DELETE /api/ontology/{id} — remove an object type (204; properties, links,
/// actions and their logs cascade). Editor+.
pub async fn delete_object_type(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;

    let Some(existing) = crate::dbx::find_object_type(&state.db, &id).await? else {
        return Err(ApiError::not_found(format!("Object type '{id}' not found")));
    };
    sqlx::query("DELETE FROM object_types WHERE id = $1")
        .bind(&existing.id)
        .execute(&state.db)
        .await?;

    audit::audit(
        &state,
        &actor,
        AuditOptions::new("ontology.delete", "ontology")
            .resource_id(Some(&existing.id))
            .resource_name(Some(&existing.display_name))
            .detail(Some(&format!("apiName '{}'", existing.api_name))),
    )
    .await;

    Ok(no_content())
}
