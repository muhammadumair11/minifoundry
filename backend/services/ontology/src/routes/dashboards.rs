//! /api/dashboards — dashboard CRUD + server-side widget aggregation
//! (ports of dashboards/route.ts, [id]/route.ts and [id]/data/route.ts).

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::Response;
use mf_types::{Row, Value};
use mf_web::{actor_from_headers, json_created, json_ok, require_role, ApiError, ApiResult};

use crate::audit::{self, AuditOptions};
use crate::dbx;
use crate::jsonutil::{as_object, check_max_len, kind_of, nullish_str, parse_body};
use crate::routes::effective_role;
use crate::serialize::{dashboard_widget_count, serialize_dashboard};
use crate::state::*;
use crate::widgets::{compute_widget_rows, validate_widget, validate_widgets};

async fn fetch_dashboard(db: &sqlx::PgPool, id: &str) -> Result<Option<DashboardRow>, ApiError> {
    let q = format!("SELECT {DASHBOARD_COLS} FROM dashboards WHERE id = $1");
    Ok(sqlx::query_as::<_, DashboardRow>(&q)
        .bind(id)
        .fetch_optional(db)
        .await?)
}

/// GET /api/dashboards — list with widgetCount (any role; updatedAt desc).
pub async fn list_dashboards(State(state): State<AppState>) -> ApiResult<Response> {
    let q = format!("SELECT {DASHBOARD_COLS} FROM dashboards ORDER BY updated_at DESC");
    let rows: Vec<DashboardRow> = sqlx::query_as(&q).fetch_all(&state.db).await?;
    let out: Vec<Value> = rows
        .iter()
        .map(|d| {
            serde_json::json!({
                "id": d.id,
                "title": d.title,
                "description": d.description,
                "createdAt": mf_types::ts::format(&d.created_at),
                "updatedAt": mf_types::ts::format(&d.updated_at),
                "widgetCount": dashboard_widget_count(d),
            })
        })
        .collect();
    Ok(json_ok(serde_json::json!({ "dashboards": out })))
}

/// POST /api/dashboards — create an empty dashboard (editor+).
pub async fn create_dashboard(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;

    let v = parse_body(&body)?;
    let m = as_object(v)?;
    let title = match m.get("title").and_then(|x| x.as_str()) {
        Some(s) if !s.is_empty() => {
            check_max_len("title", s, 200)?;
            s.to_string()
        }
        Some(_) => return Err(ApiError::bad_request("title: title is required")),
        None => return Err(ApiError::bad_request("title: title is required")),
    };
    let description = match nullish_str(&m, "description")? {
        Some(Some(s)) => {
            check_max_len("description", s, 2000)?;
            Some(s.to_string())
        }
        _ => None,
    };

    let id = mf_db::new_id();
    sqlx::query(
        "INSERT INTO dashboards (id, title, description, layout_json, created_by) \
         VALUES ($1, $2, $3, '[]', $4)",
    )
    .bind(&id)
    .bind(&title)
    .bind(&description)
    .bind(&actor.email)
    .execute(&state.db)
    .await?;

    let dashboard = fetch_dashboard(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::internal("dashboard vanished after create"))?;
    audit::audit(
        &state,
        &actor,
        AuditOptions::new("dashboard.create", "dashboard")
            .resource_id(Some(&dashboard.id))
            .resource_name(Some(&dashboard.title)),
    )
    .await;
    Ok(json_created(serde_json::json!({
        "dashboard": serialize_dashboard(&dashboard)
    })))
}

/// GET /api/dashboards/{id}
pub async fn get_dashboard(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let Some(dashboard) = fetch_dashboard(&state.db, &id).await? else {
        return Err(ApiError::not_found(format!("Dashboard '{id}' not found")));
    };
    Ok(json_ok(serde_json::json!({
        "dashboard": serialize_dashboard(&dashboard)
    })))
}

/// PATCH /api/dashboards/{id} — title/description/widgets (editor+).
pub async fn update_dashboard(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;

    let v = parse_body(&body)?;
    let m = as_object(v)?;
    let title = match m.get("title") {
        None => None,
        Some(Value::String(s)) => {
            if s.is_empty() {
                return Err(ApiError::bad_request("title: title is required"));
            }
            check_max_len("title", s, 200)?;
            Some(s.clone())
        }
        Some(other) => {
            return Err(ApiError::bad_request(format!(
                "title: Invalid input: expected string, received {}",
                kind_of(other)
            )))
        }
    };
    let description = nullish_str(&m, "description")?;
    if let Some(Some(s)) = &description {
        check_max_len("description", s, 2000)?;
    }
    let widgets = match m.get("widgets") {
        None => None,
        Some(v) => Some(validate_widgets("widgets", v)?),
    };

    let Some(existing) = fetch_dashboard(&state.db, &id).await? else {
        return Err(ApiError::not_found(format!("Dashboard '{id}' not found")));
    };

    let mut sets: Vec<String> = vec!["updated_at = now()".into()];
    let new_title = title.clone().unwrap_or_else(|| existing.title.clone());
    let new_description: Option<String> = match &description {
        Some(v) => v.map(String::from),
        None => existing.description.clone(),
    };
    let new_layout: Value = match &widgets {
        Some(w) => Value::Array(w.clone()),
        None => existing.layout_json.0.clone(),
    };
    sets.push("title = $1".to_string());
    sets.push("description = $2".to_string());
    sets.push("layout_json = $3".to_string());
    let sql = format!("UPDATE dashboards SET {} WHERE id = $4", sets.join(", "));
    sqlx::query(&sql)
        .bind(&new_title)
        .bind(&new_description)
        .bind(sqlx::types::Json(new_layout))
        .bind(&id)
        .execute(&state.db)
        .await?;

    let updated = fetch_dashboard(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::internal("dashboard vanished after update"))?;

    let detail: Option<String> = match &widgets {
        Some(w) => Some(format!(
            "widgets={}{}",
            w.len(),
            if title.is_some() { " (renamed)" } else { "" }
        )),
        None => {
            if title.is_some() {
                Some("renamed".to_string())
            } else {
                None
            }
        }
    };
    audit::audit(
        &state,
        &actor,
        AuditOptions::new("dashboard.update", "dashboard")
            .resource_id(Some(&updated.id))
            .resource_name(Some(&updated.title))
            .detail(detail.as_deref()),
    )
    .await;

    Ok(json_ok(serde_json::json!({
        "dashboard": serialize_dashboard(&updated)
    })))
}

/// DELETE /api/dashboards/{id} — editor+; legacy returns { ok, deleted }.
pub async fn delete_dashboard(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;

    let Some(existing) = fetch_dashboard(&state.db, &id).await? else {
        return Err(ApiError::not_found(format!("Dashboard '{id}' not found")));
    };
    sqlx::query("DELETE FROM dashboards WHERE id = $1")
        .bind(&id)
        .execute(&state.db)
        .await?;
    audit::audit(
        &state,
        &actor,
        AuditOptions::new("dashboard.delete", "dashboard")
            .resource_id(Some(&existing.id))
            .resource_name(Some(&existing.title)),
    )
    .await;
    Ok(json_ok(
        serde_json::json!({ "ok": true, "deleted": existing.id }),
    ))
}

/// POST /api/dashboards/{id}/data — server-side widget aggregation.
/// Masking happens in catalog (role param) BEFORE any aggregation, so a
/// marked column never leaks through table rows, group labels or aggregates.
pub async fn widget_data(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    let role = effective_role(&actor);

    let v = parse_body(&body)?;
    let m = as_object(v)?;
    let widget_value = match m.get("widget") {
        Some(w) => w.clone(),
        None => {
            return Err(ApiError::bad_request(
                "widget: Invalid input: expected object, received undefined",
            ))
        }
    };
    let widget = validate_widget("widget", &widget_value)?;

    if fetch_dashboard(&state.db, &id).await?.is_none() {
        return Err(ApiError::not_found(format!("Dashboard '{id}' not found")));
    }

    // Resolve the widget's source dataset (+ ontology projection).
    let mut source_dataset_id: Option<String> = widget.dataset_id.clone();
    let mut source_name: Option<String> = None;
    let mut ontology_properties: Option<Vec<String>> = None;

    if widget.source_type == "objectType" {
        let ot_id = widget.object_type_id.clone().unwrap_or_default();
        let Some(object_type) = dbx::find_object_type(&state.db, &ot_id).await? else {
            return Err(ApiError::not_found(format!(
                "Object type '{ot_id}' not found"
            )));
        };
        let Some(ds) = object_type.source_dataset_id.clone() else {
            return Err(ApiError::bad_request(format!(
                "Object type '{}' has no backing dataset",
                object_type.display_name
            )));
        };
        let properties = dbx::load_properties(&state.db, &object_type.id).await?;
        source_dataset_id = Some(ds);
        source_name = Some(object_type.display_name.clone());
        ontology_properties = Some(properties.iter().map(|p| p.api_name.clone()).collect());
    }

    let Some(dataset_id) = source_dataset_id else {
        return Err(ApiError::bad_request("Widget source is missing"));
    };

    // Consumer rows (masked at the caller's role by catalog — the single
    // masking authority; its envelope carries the masked column list) plus
    // the resolved version's rowCount.
    let Some(payload) = state
        .catalog
        .head_rows_full(&dataset_id, Some(&role))
        .await?
    else {
        return Err(ApiError::bad_request(format!(
            "Source '{}' has no published data",
            source_name.clone().unwrap_or_else(|| dataset_id.clone())
        )));
    };
    let Some(dataset) = state.catalog.get_dataset(&dataset_id).await? else {
        return Err(ApiError::not_found(format!(
            "Dataset '{dataset_id}' not found"
        )));
    };
    if source_name.is_none() {
        source_name = Some(dataset.name.clone());
    }

    let masked_columns = payload.masked_columns;
    let all_rows_raw = payload.rows;
    // legacy: version.rowCount ?? allRows.length — the envelope `total` IS the
    // resolved version's row count (parser falls back to rows.len()).
    let row_count = payload.total;

    // Ontology widgets project rows onto the object type's property columns
    // (missing columns drop out, exactly like the legacy Object.fromEntries +
    // JSON serialization of undefined).
    let all_rows: Vec<Row> = match &ontology_properties {
        Some(props) => all_rows_raw
            .iter()
            .map(|row| {
                let mut out = Row::new();
                for name in props {
                    if let Some(v) = row.get(name) {
                        out.insert(name.clone(), v.clone());
                    }
                }
                out
            })
            .collect(),
        None => all_rows_raw,
    };

    let rows = compute_widget_rows(
        &widget.widget_type,
        &widget.agg,
        widget.group_by.as_deref(),
        widget.value_column.as_deref(),
        widget.top_n,
        &widget.sort_dir,
        &all_rows,
        row_count,
        &dataset.name,
    )?;

    Ok(json_ok(serde_json::json!({
        "rows": rows,
        "datasetName": dataset.name,
        "sourceName": source_name,
        "sourceType": widget.source_type,
        "rowCount": row_count,
        "maskedColumns": masked_columns,
    })))
}
