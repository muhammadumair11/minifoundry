//! POST /api/seed — idempotent demo workspace seeding (catalog parts).

use axum::http::HeaderMap;
use axum::response::Response;
use mf_web::TenantState as State;
use mf_web::{actor_from_headers, json_ok, require_role, ApiError, ApiResult};
use serde_json::json;

use crate::state::AppState;

/// POST /api/seed — editor+ (creates datasets/connectors). Failures → 500
/// with the underlying message (legacy serverError(err.message)).
pub async fn post_seed(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;

    match crate::seed::seed_database(&state).await {
        Ok(result) => Ok(json_ok(json!({
            "seeded": result.seeded,
            "datasets": result.datasets,
        }))),
        Err(msg) => Err(ApiError::internal(msg)),
    }
}
