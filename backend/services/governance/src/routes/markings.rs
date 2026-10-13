//! /api/markings* — M9 column markings (ports of the legacy markings routes).
//!
//! GET list (any role) · POST create (admin) · DELETE (admin) ·
//! POST attach/detach (admin). Attach/detach verify the target dataset via
//! the catalog internal API; a catalog 404 is the legacy
//! `Dataset '<id>' not found`, while a transport failure DEGRADES (attach
//! proceeds without name verification, warn-logged) so governance stays
//! usable while catalog is down. After any attachment change (and after a
//! marking delete cascades) `mf.markings.changed` is published per dataset.

use axum::body::Bytes;
use axum::extract::Path;
use axum::http::HeaderMap;
use axum::response::Response;
use mf_web::TenantState as State;
use mf_web::{
    actor_from_headers, json_created, json_ok, no_content, require_role, ApiError, ApiResult,
};
use serde_json::Value;

use crate::state::{
    audit_local, AppState, AuditOptions, ColumnMarkingRow, MarkingRow, MARKING_COLS,
};

/// GET /api/markings — markings with the columns they mark (any role).
pub async fn list_markings(State(state): State<AppState>) -> ApiResult<Response> {
    let markings: Vec<MarkingRow> = sqlx::query_as(&format!(
        "SELECT {MARKING_COLS} FROM markings ORDER BY created_at ASC, id ASC"
    ))
    .fetch_all(&state.db)
    .await?;

    let cms: Vec<ColumnMarkingRow> = sqlx::query_as(
        "SELECT dataset_id, column_name, marking_id FROM column_markings \
         ORDER BY column_name ASC, id ASC",
    )
    .fetch_all(&state.db)
    .await?;

    // datasetName lives in the catalog now — resolve id→name best-effort.
    let names = dataset_name_map(&state).await;

    let mut out: Vec<Value> = Vec::new();
    for m in &markings {
        let columns: Vec<Value> = cms
            .iter()
            .filter(|cm| cm.marking_id == m.id)
            .map(|cm| {
                serde_json::json!({
                    "datasetId": cm.dataset_id,
                    "datasetName": names.get(&cm.dataset_id).map(|s| Value::String(s.clone())).unwrap_or(Value::Null),
                    "columnName": cm.column_name,
                })
            })
            .collect();
        out.push(serde_json::json!({
            "id": m.id,
            "name": m.name,
            "description": m.description,
            "color": m.color,
            "minRole": m.min_role,
            "createdAt": mf_types::ts::format(&m.created_at),
            "columns": columns,
        }));
    }
    Ok(json_ok(serde_json::json!({ "markings": out })))
}

/// id→name map from the catalog's internal dataset list (empty on failure).
pub async fn dataset_name_map(state: &AppState) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    match state.clients.catalog.get("/internal/datasets").await {
        Ok(v) => {
            for d in crate::fanout::items_array(&v, "datasets") {
                if let (Some(id), Some(name)) = (
                    d.get("id").and_then(|x| x.as_str()),
                    d.get("name").and_then(|x| x.as_str()),
                ) {
                    map.insert(id.to_string(), name.to_string());
                }
            }
        }
        Err(e) => {
            tracing::warn!(error = %e, "catalog dataset list unavailable; datasetName degraded to null");
        }
    }
    map
}

/// POST /api/markings — create a marking (admin). Duplicate names → 400.
pub async fn create_marking(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "admin")?;

    let v = crate::routes::parse_body(&body)?;
    let m = crate::routes::as_object(v)?;
    let name = crate::routes::req_str_min1(&m, "name", "name is required")?;
    let description = crate::routes::opt_str(&m, "description")?;
    let color =
        crate::routes::opt_enum_default(&m, "color", &["rose", "amber", "teal", "zinc"], "rose")?;
    let min_role =
        crate::routes::opt_enum_default(&m, "minRole", &["viewer", "editor", "admin"], "editor")?;

    let existing: Option<(String,)> = sqlx::query_as("SELECT id FROM markings WHERE name = $1")
        .bind(name)
        .fetch_optional(&state.db)
        .await?;
    if existing.is_some() {
        return Err(ApiError::bad_request(format!(
            "Marking '{name}' already exists"
        )));
    }

    let id = mf_db::new_id();
    let marking: MarkingRow = sqlx::query_as(&format!(
        "INSERT INTO markings (id, name, description, color, min_role) \
         VALUES ($1,$2,$3,$4,$5) RETURNING {MARKING_COLS}"
    ))
    .bind(&id)
    .bind(name)
    .bind(description)
    .bind(color)
    .bind(min_role)
    .fetch_one(&state.db)
    .await?;

    audit_local(
        &state,
        &actor,
        AuditOptions::new("marking.create", "marking")
            .resource_id(Some(&marking.id))
            .resource_name(Some(&marking.name))
            .detail(Some(&format!(
                "minRole {}, color {}",
                marking.min_role, marking.color
            ))),
    )
    .await;

    Ok(json_created(serde_json::json!({
        "marking": {
            "id": marking.id,
            "name": marking.name,
            "description": marking.description,
            "color": marking.color,
            "minRole": marking.min_role,
            "columns": [],
        }
    })))
}

/// DELETE /api/markings/{id} — remove a marking (admin); column_markings
/// cascade. Publishes mf.markings.changed for every affected dataset.
pub async fn delete_marking(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "admin")?;

    let existing: Option<(String, String)> =
        sqlx::query_as("SELECT id, name FROM markings WHERE id = $1")
            .bind(&id)
            .fetch_optional(&state.db)
            .await?;
    let Some((mid, mname)) = existing else {
        return Err(ApiError::not_found(format!("Marking '{id}' not found")));
    };

    let affected: Vec<(String,)> =
        sqlx::query_as("SELECT DISTINCT dataset_id FROM column_markings WHERE marking_id = $1")
            .bind(&mid)
            .fetch_all(&state.db)
            .await?;

    sqlx::query("DELETE FROM markings WHERE id = $1")
        .bind(&mid)
        .execute(&state.db)
        .await?;

    audit_local(
        &state,
        &actor,
        AuditOptions::new("marking.delete", "marking")
            .resource_id(Some(&mid))
            .resource_name(Some(&mname)),
    )
    .await;

    for (dataset_id,) in affected {
        mf_events::publish_json_quiet(
            &state.nats,
            mf_events::subject::MARKINGS_CHANGED,
            &mf_events::MarkingsChangedEvent { dataset_id },
        )
        .await;
    }

    Ok(no_content())
}

/// Resolve + verify the target dataset through the catalog.
/// Ok((name)) on success; Err(Some(ApiError)) for a definite catalog answer
/// (404/other API error → pass-through); Err(None) = transport failure →
/// caller degrades (name falls back to the dataset id).
async fn resolve_dataset(state: &AppState, dataset_id: &str) -> Result<String, Option<ApiError>> {
    match state
        .clients
        .catalog
        .get(&format!("/internal/datasets/{dataset_id}"))
        .await
    {
        Ok(v) => {
            let name = v
                .get("name")
                .and_then(|x| x.as_str())
                .or_else(|| {
                    v.get("dataset")
                        .and_then(|d| d.get("name"))
                        .and_then(|x| x.as_str())
                })
                .unwrap_or(dataset_id)
                .to_string();
            Ok(name)
        }
        Err(e) if e.is_transport() => {
            tracing::warn!(dataset_id, error = %e, "catalog unreachable; skipping dataset existence check");
            Err(None)
        }
        Err(e) => Err(Some(crate::fanout::pass_through(e))),
    }
}

/// POST /api/markings/{id}/attach — attach a marking to dataset columns
/// (admin). One ColumnMarking per (datasetId, columnName); re-attaching
/// re-points the column to this marking.
pub async fn attach(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "admin")?;

    let marking = load_marking(&state, &id).await?;

    let v = crate::routes::parse_body(&body)?;
    let m = crate::routes::as_object(v)?;
    let dataset_id = crate::routes::req_str_min1(&m, "datasetId", "datasetId is required")?;
    let columns = crate::routes::req_str_array(
        &m,
        "columns",
        "columns must not be empty",
        "column names must be non-empty",
    )?;

    let dataset_name = match resolve_dataset(&state, dataset_id).await {
        Ok(name) => name,
        Err(Some(err)) => return Err(err),
        Err(None) => dataset_id.to_string(),
    };

    // Dedupe while preserving order (legacy `[...new Set(columns)]`).
    let mut seen = std::collections::HashSet::new();
    let columns: Vec<String> = columns
        .into_iter()
        .filter(|c| seen.insert(c.clone()))
        .collect();

    let mut marked: i64 = 0;
    for column_name in &columns {
        let existing: Option<(String, String)> = sqlx::query_as(
            "SELECT id, marking_id FROM column_markings WHERE dataset_id = $1 AND column_name = $2",
        )
        .bind(dataset_id)
        .bind(column_name)
        .fetch_optional(&state.db)
        .await?;
        if existing.as_ref().is_some_and(|(_, mid)| mid == &marking.0) {
            continue; // already attached here
        }
        sqlx::query(
            "INSERT INTO column_markings (id, dataset_id, column_name, marking_id) \
             VALUES ($1,$2,$3,$4) \
             ON CONFLICT (dataset_id, column_name) DO UPDATE SET marking_id = $4",
        )
        .bind(mf_db::new_id())
        .bind(dataset_id)
        .bind(column_name)
        .bind(&marking.0)
        .execute(&state.db)
        .await?;
        marked += 1;
    }

    audit_local(
        &state,
        &actor,
        AuditOptions::new("marking.attach", "marking")
            .resource_id(Some(&marking.0))
            .resource_name(Some(&marking.1))
            .detail(Some(&format!(
                "dataset '{}': columns {} ({} newly marked)",
                dataset_name,
                columns.join(", "),
                marked
            ))),
    )
    .await;

    mf_events::publish_json_quiet(
        &state.nats,
        mf_events::subject::MARKINGS_CHANGED,
        &mf_events::MarkingsChangedEvent {
            dataset_id: dataset_id.to_string(),
        },
    )
    .await;

    Ok(json_ok(serde_json::json!({ "marked": marked })))
}

/// POST /api/markings/{id}/detach — remove a marking from dataset columns
/// (admin).
pub async fn detach(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "admin")?;

    let marking = load_marking(&state, &id).await?;

    let v = crate::routes::parse_body(&body)?;
    let m = crate::routes::as_object(v)?;
    let dataset_id = crate::routes::req_str_min1(&m, "datasetId", "datasetId is required")?;
    let columns = crate::routes::req_str_array(
        &m,
        "columns",
        "columns must not be empty",
        "column names must be non-empty",
    )?;

    let dataset_name = match resolve_dataset(&state, dataset_id).await {
        Ok(name) => name,
        Err(Some(err)) => return Err(err),
        Err(None) => dataset_id.to_string(),
    };

    let mut seen = std::collections::HashSet::new();
    let columns: Vec<String> = columns
        .into_iter()
        .filter(|c| seen.insert(c.clone()))
        .collect();

    let removed = sqlx::query(
        "DELETE FROM column_markings \
         WHERE dataset_id = $1 AND marking_id = $2 AND column_name = ANY($3)",
    )
    .bind(dataset_id)
    .bind(&marking.0)
    .bind(&columns)
    .execute(&state.db)
    .await?
    .rows_affected() as i64;

    audit_local(
        &state,
        &actor,
        AuditOptions::new("marking.detach", "marking")
            .resource_id(Some(&marking.0))
            .resource_name(Some(&marking.1))
            .detail(Some(&format!(
                "dataset '{}': columns {} ({} removed)",
                dataset_name,
                columns.join(", "),
                removed
            ))),
    )
    .await;

    mf_events::publish_json_quiet(
        &state.nats,
        mf_events::subject::MARKINGS_CHANGED,
        &mf_events::MarkingsChangedEvent {
            dataset_id: dataset_id.to_string(),
        },
    )
    .await;

    Ok(json_ok(serde_json::json!({ "unmarked": removed })))
}

/// (id, name) of a marking or the legacy 404 `Marking '<id>' not found`.
async fn load_marking(state: &AppState, id: &str) -> Result<(String, String), ApiError> {
    let row: Option<(String, String)> =
        sqlx::query_as("SELECT id, name FROM markings WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.db)
            .await?;
    row.ok_or_else(|| ApiError::not_found(format!("Marking '{id}' not found")))
}
