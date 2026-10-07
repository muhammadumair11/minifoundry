//! GET /api/audit — audit trail, latest first, with the legacy P5 scale
//! params (?resourceType= ?action= exact filters, ?limit= 1..200, ?offset=
//! 0..10_000 and a { total, limit, offset } meta block).

use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::response::Response;
use mf_web::{json_ok, ApiResult};
use std::collections::HashMap;

use crate::routes::bounded_number;
use crate::state::{serialize_audit, AppState, AuditRow, AUDIT_COLS};

pub async fn list_audit(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    let _ = headers; // any role (legacy had no guard on the audit read)
    let resource_type = params
        .get("resourceType")
        .filter(|s| !s.is_empty())
        .cloned();
    let action = params.get("action").filter(|s| !s.is_empty()).cloned();
    let limit = bounded_number(params.get("limit").map(|s| s.as_str()), 100, 1, 200);
    let offset = bounded_number(params.get("offset").map(|s| s.as_str()), 0, 0, 10_000);

    // Static SQL with optional filters (NULL param = no filter). Tie-break on
    // id keeps same-millisecond rows stable (Prisma's order was createdAt only).
    let entries: Vec<AuditRow> = sqlx::query_as(&format!(
        "SELECT {AUDIT_COLS} FROM audit_entries \
         WHERE ($1::text IS NULL OR resource_type = $1) \
           AND ($2::text IS NULL OR action = $2) \
         ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4"
    ))
    .bind(&resource_type)
    .bind(&action)
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_entries \
         WHERE ($1::text IS NULL OR resource_type = $1) \
           AND ($2::text IS NULL OR action = $2)",
    )
    .bind(&resource_type)
    .bind(&action)
    .fetch_one(&state.db)
    .await?;

    Ok(json_ok(serde_json::json!({
        "entries": entries.iter().map(serialize_audit).collect::<Vec<_>>(),
        "meta": { "total": total, "limit": limit, "offset": offset },
    })))
}
