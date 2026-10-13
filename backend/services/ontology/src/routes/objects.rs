//! /api/objects — object explorer list + detail (ports of
//! src/app/api/objects/route.ts and [type]/[pk]/route.ts). Masking is applied
//! by catalog (role query param); the rows envelope's `maskedColumns` (single
//! masking authority) is surfaced as the additive `_masked` list.

use axum::extract::Path;
use axum::http::{HeaderMap, Uri};
use axum::response::Response;
use mf_types::Value;
use mf_web::TenantState as State;
use mf_web::{actor_from_headers, json_ok, ApiError, ApiResult};

use crate::dbx;
use crate::filters::parse_filters_param;
use crate::jsonutil::query_param;
use crate::objects::{
    columns_json, find_row_by_pk, get_object_rows, load_link_sides, title_column_of,
    GetObjectRowsOpts,
};
use crate::routes::effective_role;
use crate::state::AppState;
use crate::values::js_num;

/// JS `Number(param) || fallback` with max/min clamps (page/pageSize parsing).
fn js_page_number(raw: Option<String>, fallback: f64) -> f64 {
    let n = match raw {
        Some(s) => {
            let t = s.trim();
            if t.is_empty() {
                0.0 // Number('') === 0 → falsy → fallback
            } else {
                t.parse::<f64>().unwrap_or(f64::NAN)
            }
        }
        None => fallback,
    };
    if n.is_nan() || n == 0.0 {
        fallback
    } else {
        n
    }
}

/// objectType summary block shared by list + detail responses.
fn object_type_summary(core: &crate::links::TypeCore) -> Value {
    let title_property = title_column_of(core);
    serde_json::json!({
        "id": core.id,
        "apiName": core.api_name,
        "displayName": core.display_name,
        "primaryKey": core.primary_key,
        "icon": core.icon,
        "color": core.color,
        "titleProperty": title_property,
    })
}

/// Shared objects-listing pipeline for the public route and the internal
/// endpoint (role=None → raw rows, `_masked` empty; role=Some → catalog masks
/// at that role and `_masked` lists the columns).
#[allow(clippy::too_many_arguments)]
pub async fn objects_listing(
    state: &AppState,
    type_param: &str,
    query: Option<String>,
    page: f64,
    page_size: f64,
    filters: Vec<crate::filters::ObjectViewFilter>,
    sort_by: Option<String>,
    sort_dir: &str,
    role: Option<&str>,
) -> Result<Value, ApiError> {
    let Some(row) = dbx::find_object_type(&state.db, type_param).await? else {
        return Err(ApiError::not_found(format!(
            "Object type '{type_param}' not found"
        )));
    };
    let properties = dbx::load_properties(&state.db, &row.id).await?;
    let core = dbx::type_core_of(&row, &properties);

    let result = get_object_rows(
        state,
        &core,
        role,
        GetObjectRowsOpts {
            query: query.as_deref(),
            page,
            page_size,
            all: false,
            filters: &filters,
            sort_by: sort_by.as_deref(),
            sort_dir,
        },
    )
    .await?;

    let rows: Vec<Value> = result
        .rows
        .iter()
        .map(|r| r.to_json(&result.masked_columns))
        .collect();
    Ok(serde_json::json!({
        "objectType": object_type_summary(&core),
        "columns": columns_json(&result.columns),
        "rows": rows,
        "total": result.total,
        "page": js_num(page),
        "pageSize": js_num(page_size),
    }))
}

/// GET /api/objects?type={id|apiName}&query=&page=&pageSize=
///                &filters=<JSON>&sortBy=&sortDir=
pub async fn list_objects(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    let role = effective_role(&actor);

    let type_param = query_param(&uri, "type")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let Some(type_param) = type_param else {
        return Err(ApiError::bad_request(
            "Missing required query parameter 'type'",
        ));
    };

    let page = js_page_number(query_param(&uri, "page"), 1.0).max(1.0);
    let page_size = js_page_number(query_param(&uri, "pageSize"), 50.0).clamp(1.0, 200.0);
    // legacy reads ?query=; ?q= is accepted as an alias (additive)
    let query = query_param(&uri, "query").or_else(|| query_param(&uri, "q"));
    let filters = parse_filters_param(query_param(&uri, "filters").as_deref())?;
    let sort_by = query_param(&uri, "sortBy")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let sort_dir = match query_param(&uri, "sortDir").as_deref().map(str::trim) {
        Some("desc") => "desc",
        _ => "asc",
    };

    let body = objects_listing(
        &state,
        &type_param,
        query,
        page,
        page_size,
        filters,
        sort_by,
        sort_dir,
        Some(&role),
    )
    .await?;
    Ok(json_ok(body))
}

/// GET /api/objects/{type}/{pk} — single object instance + resolved links in
/// BOTH directions (R14.8 entries with total + sample targets).
pub async fn get_object(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((type_id, pk)): Path<(String, String)>,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    let role = effective_role(&actor);

    let Some(row) = dbx::find_object_type(&state.db, &type_id).await? else {
        return Err(ApiError::not_found(format!(
            "Object type '{type_id}' not found"
        )));
    };
    let properties = dbx::load_properties(&state.db, &row.id).await?;
    let core = dbx::type_core_of(&row, &properties);

    let Some(pk_column) = core.primary_key.clone() else {
        return Err(ApiError::bad_request(format!(
            "Object type '{}' has no primary key configured",
            core.api_name
        )));
    };
    let Some(dataset_id) = core.source_dataset_id.clone() else {
        return Err(ApiError::not_found(format!(
            "Object type '{}' has no backing dataset",
            core.api_name
        )));
    };

    // P2: consumer read — catalog resolves the gated head; rows arrive masked
    // at the caller's role and the envelope carries the masked column list.
    let Some(payload) = state
        .catalog
        .head_rows_full(&dataset_id, Some(&role))
        .await?
    else {
        return Err(ApiError::not_found(format!(
            "Dataset for object type '{}' has no versions",
            core.api_name
        )));
    };
    let rows = payload.rows;
    let masked_columns = payload.masked_columns;
    let Some(viewed_row) = find_row_by_pk(&rows, &pk_column, &pk) else {
        return Err(ApiError::not_found(format!(
            "Object '{pk}' not found in type '{}'",
            core.api_name
        )));
    };
    let pk_value = viewed_row.get(&pk_column).cloned().unwrap_or(Value::Null);

    let (out_links, in_links) = load_link_sides(&state.db, &core.id).await?;
    let entries = crate::objects::get_links_for(
        &state,
        Some(viewed_row),
        &pk_value,
        &role,
        out_links,
        in_links,
    )
    .await?;

    let mut values = serde_json::Map::new();
    for (k, v) in viewed_row {
        values.insert(k.clone(), v.clone());
    }
    Ok(json_ok(serde_json::json!({
        "objectType": object_type_summary(&core),
        "object": {
            "pk": viewed_row.get(&pk_column).cloned().unwrap_or(Value::Null),
            "values": Value::Object(values),
            "_masked": masked_columns,
        },
        "links": entries.iter().map(|e| e.to_json()).collect::<Vec<_>>(),
    })))
}
