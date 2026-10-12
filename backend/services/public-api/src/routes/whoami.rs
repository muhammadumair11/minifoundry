//! GET /api/foundry/v1/whoami — identity + API meta for the caller's token.
//! Works standalone (token identity only): verify gives {id,name,prefix,
//! requestCount}; createdAt/lastUsedAt are enriched from auth's admin token
//! list with the trusted service actor (auth's verify response omits them;
//! enrichment failure degrades to null — documented deviation with a shared
//! change request to extend verify).

use axum::extract::State;
use axum::http::{HeaderMap, Uri};
use axum::response::Response;
use mf_web::{json_ok, ApiResult};
use serde_json::Value;

use crate::fanout::{items_array, service_admin_actor};
use crate::guard::{self, TOKEN_RATE_LIMIT};
use crate::state::AppState;

pub async fn whoami(State(state): State<AppState>, headers: HeaderMap, uri: Uri) -> Response {
    let path = uri.path().to_string();
    let st = state.clone();
    guard::with_api_token(&state, &headers, &path, move |ctx| async move {
        handler(
            &st,
            ctx.token.id.as_str(),
            ctx.token.name.as_str(),
            ctx.token.prefix.as_str(),
            &ctx.token.request_count,
        )
        .await
    })
    .await
}

async fn handler(
    state: &AppState,
    token_id: &str,
    name: &str,
    prefix: &str,
    request_count: &Value,
) -> ApiResult<Response> {
    // Best-effort enrichment: full token record (createdAt/lastUsedAt).
    let mut created_at = Value::Null;
    let mut last_used_at = Value::Null;
    match state
        .auth
        .get_as("/api/tokens", &service_admin_actor())
        .await
    {
        Ok(v) => {
            if let Some(t) = items_array(&v, "tokens")
                .iter()
                .find(|t| t.get("id").and_then(|x| x.as_str()) == Some(token_id))
            {
                created_at = t.get("createdAt").cloned().unwrap_or(Value::Null);
                last_used_at = t.get("lastUsedAt").cloned().unwrap_or(Value::Null);
            }
        }
        Err(e) => {
            tracing::warn!(error = %e, "whoami enrichment unavailable; createdAt/lastUsedAt degrade to null");
        }
    }

    Ok(json_ok(serde_json::json!({
        "token": {
            "name": name,
            "prefix": prefix,
            "createdAt": created_at,
            "lastUsedAt": last_used_at,
            "requestCount": request_count,
        },
        "api": {
            "version": "v1",
            "rateLimitPerMinute": TOKEN_RATE_LIMIT,
        },
    })))
}
