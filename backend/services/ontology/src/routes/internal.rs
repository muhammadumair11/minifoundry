//! /internal/* — service-to-service endpoints (public-api v1 reads,
//! governance search/stats/curriculum/reset). Guarded by the shared service
//! token (pattern copied from services/auth internal routes).

use axum::extract::{Path, State};
use axum::http::{HeaderMap, Uri};
use axum::response::Response;
use mf_types::Value;
use mf_web::{json_ok, ApiError, ApiResult};

use crate::assemble::{dataset_map, full_for_list};
use crate::jsonutil::query_param;
use crate::serialize::serialize_object_type;
use crate::state::*;

/// Internal endpoints require the shared service token (both runtime modes);
/// compose always provisions MF_SERVICE_TOKEN.
pub fn require_service(state: &AppState, headers: &HeaderMap) -> Result<(), ApiError> {
    let provided = headers
        .get(mf_auth::SERVICE_TOKEN_HEADER)
        .and_then(|v| v.to_str().ok());
    if state.mode.is_service_authorized(provided) {
        Ok(())
    } else {
        Err(ApiError::forbidden("service token required"))
    }
}

/// GET /internal/ontology — object types + flattened actions (the exact body
/// public-api serves at /api/foundry/v1/ontology).
pub async fn internal_ontology(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    require_service(&state, &headers)?;

    let rows: Vec<ObjectTypeRow> = sqlx::query_as(&format!(
        "SELECT {OBJECT_TYPE_COLS} FROM object_types ORDER BY created_at ASC"
    ))
    .fetch_all(&state.db)
    .await?;
    let datasets = dataset_map(&state).await;
    let fulls = full_for_list(&state, &rows, &datasets).await?;
    let serialized: Vec<Value> = fulls.iter().map(serialize_object_type).collect();

    let actions: Vec<Value> = serialized
        .iter()
        .flat_map(|ot| {
            let meta = serde_json::json!({
                "id": ot["id"],
                "apiName": ot["apiName"],
                "displayName": ot["displayName"],
            });
            ot["actions"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(move |a| {
                    let mut m = a.as_object().cloned().unwrap_or_default();
                    m.insert("objectType".into(), meta.clone());
                    Value::Object(m)
                })
        })
        .collect();

    Ok(json_ok(serde_json::json!({
        "objectTypes": serialized,
        "actions": actions,
    })))
}

/// GET /internal/objects/{type}?q=&limit=&page=&pageSize=&role= — object rows
/// for public-api + governance search. `role` (when present) is forwarded to
/// catalog so rows arrive masked at that level.
pub async fn internal_objects(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(type_id): Path<String>,
    uri: Uri,
) -> ApiResult<Response> {
    require_service(&state, &headers)?;

    let type_param = type_id.trim().to_string();
    if type_param.is_empty() {
        return Err(ApiError::bad_request(
            "Missing required query parameter 'type'",
        ));
    }
    let role = query_param(&uri, "role")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let q = query_param(&uri, "q").or_else(|| query_param(&uri, "query"));
    let page = {
        let raw = query_param(&uri, "page");
        let n = raw
            .as_deref()
            .and_then(|s| s.trim().parse::<f64>().ok())
            .unwrap_or(1.0);
        if n.is_nan() || n == 0.0 {
            1.0
        } else {
            n.max(1.0)
        }
    };
    let page_size = {
        let raw = query_param(&uri, "pageSize").or_else(|| query_param(&uri, "limit"));
        let n = raw
            .as_deref()
            .and_then(|s| s.trim().parse::<f64>().ok())
            .unwrap_or(50.0);
        if n.is_nan() || n == 0.0 {
            50.0
        } else {
            n.clamp(1.0, 200.0)
        }
    };

    let body = crate::routes::objects::objects_listing(
        &state,
        &type_param,
        q,
        page,
        page_size,
        vec![],
        None,
        "asc",
        role.as_deref(),
    )
    .await?;
    Ok(json_ok(body))
}

/// GET /internal/search?q= — object type / dashboard / application matches
/// (governance merges them into the public /api/search response; item shapes
/// match the legacy SearchResultItem serializers exactly).
pub async fn internal_search(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
) -> ApiResult<Response> {
    require_service(&state, &headers)?;

    let q = query_param(&uri, "q").unwrap_or_default();
    let q = q.trim();
    if q.is_empty() {
        return Ok(json_ok(serde_json::json!({ "results": [] })));
    }
    let needle = format!("%{}%", q.to_lowercase());

    let object_types: Vec<(String, String, String, Option<String>)> = sqlx::query_as(
        "SELECT id, api_name, display_name, description FROM object_types \
         WHERE LOWER(display_name) LIKE $1 OR LOWER(api_name) LIKE $1 \
         ORDER BY display_name ASC LIMIT 10",
    )
    .bind(&needle)
    .fetch_all(&state.db)
    .await?;
    let dashboards: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT id, title, description FROM dashboards \
         WHERE LOWER(title) LIKE $1 OR (description IS NOT NULL AND LOWER(description) LIKE $1) \
         ORDER BY updated_at DESC LIMIT 10",
    )
    .bind(&needle)
    .fetch_all(&state.db)
    .await?;
    let applications: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT id, name, description FROM applications \
         WHERE LOWER(name) LIKE $1 OR (description IS NOT NULL AND LOWER(description) LIKE $1) \
         ORDER BY updated_at DESC LIMIT 10",
    )
    .bind(&needle)
    .fetch_all(&state.db)
    .await?;

    let mut results: Vec<Value> = Vec::new();
    for (id, api_name, display_name, description) in object_types {
        results.push(serde_json::json!({
            "type": "objectType",
            "id": id,
            "title": display_name,
            "subtitle": description.unwrap_or_else(|| api_name.clone()),
            "href": format!("/objects/{api_name}"),
        }));
    }
    for (id, title, description) in dashboards {
        results.push(serde_json::json!({
            "type": "dashboard",
            "id": id,
            "title": title,
            "subtitle": description,
            "href": format!("/dashboards/{id}"),
        }));
    }
    for (id, name, description) in applications {
        results.push(serde_json::json!({
            "type": "application",
            "id": id,
            "title": name,
            "subtitle": description,
            "href": format!("/applications/{id}"),
        }));
    }
    Ok(json_ok(serde_json::json!({ "results": results })))
}

/// GET /internal/stats — { objectTypes, linkTypes, actionTypes, dashboards,
/// applications } (+ additive properties/actionLogs/objectViews counts used
/// by governance's workspace overview).
pub async fn internal_stats(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    require_service(&state, &headers)?;
    let counts: (i64, i64, i64, i64, i64, i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM object_types), (SELECT COUNT(*) FROM link_types), \
         (SELECT COUNT(*) FROM action_types), (SELECT COUNT(*) FROM dashboards), \
         (SELECT COUNT(*) FROM applications), (SELECT COUNT(*) FROM properties), \
         (SELECT COUNT(*) FROM action_logs), (SELECT COUNT(*) FROM object_views)",
    )
    .fetch_one(&state.db)
    .await?;
    Ok(json_ok(serde_json::json!({
        "objectTypes": counts.0,
        "linkTypes": counts.1,
        "actionTypes": counts.2,
        "dashboards": counts.3,
        "applications": counts.4,
        "properties": counts.5,
        "actionLogs": counts.6,
        "objectViews": counts.7,
    })))
}

/// GET /internal/curriculum-state — live-state flags for the curriculum
/// auto-verifier (audit-evidence checks stay in governance; these supplement
/// with real platform state).
pub async fn internal_curriculum_state(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    require_service(&state, &headers)?;
    let (
        object_types,
        link_types,
        action_types,
        action_logs_success,
        object_views,
        dashboards,
        dashboards_with_widgets,
        applications,
    ): (i64, i64, i64, i64, i64, i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM object_types), (SELECT COUNT(*) FROM link_types), \
         (SELECT COUNT(*) FROM action_types), \
         (SELECT COUNT(*) FROM action_logs WHERE result = 'success'), \
         (SELECT COUNT(*) FROM object_views), (SELECT COUNT(*) FROM dashboards), \
         (SELECT COUNT(*) FROM dashboards WHERE jsonb_array_length(layout_json) > 0), \
         (SELECT COUNT(*) FROM applications)",
    )
    .fetch_one(&state.db)
    .await?;
    Ok(json_ok(serde_json::json!({
        "objectTypes": object_types,
        "linkTypes": link_types,
        "actionTypes": action_types,
        "actionLogsSuccess": action_logs_success,
        "objectViews": object_views,
        "dashboards": dashboards,
        "dashboardsWithWidgets": dashboards_with_widgets,
        "applications": applications,
        "flags": {
            "objectTypeCreated": object_types > 0,
            "linkCreated": link_types > 0,
            "actionApplied": action_logs_success > 0,
            "viewSaved": object_views > 0,
            "dashboardBuilt": dashboards_with_widgets > 0,
            "applicationCreated": applications > 0,
        },
    })))
}

/// POST /internal/reset — truncate every ontology table (governance
/// settings/reset fan-out; users are NOT owned here).
pub async fn internal_reset(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    require_service(&state, &headers)?;
    sqlx::query(
        "TRUNCATE action_logs, action_types, object_views, link_types, properties, \
         object_types, dashboards, applications",
    )
    .execute(&state.db)
    .await?;
    Ok(json_ok(serde_json::json!({ "ok": true })))
}
