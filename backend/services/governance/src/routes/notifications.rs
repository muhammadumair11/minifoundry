//! /api/notifications* — R14 notification center (ports of the legacy
//! routes). Visibility: broadcast rows (user_email NULL) are visible to
//! EVERYONE; addressed rows only to their user_email (actor email).

use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::response::Response;
use chrono::Utc;
use mf_web::{actor_from_headers, json_ok, ApiError, ApiResult};
use std::collections::HashMap;

use crate::state::{serialize_notification, AppState, NotificationRow, NOTIF_COLS};

/// GET /api/notifications?unread=1|all — latest 50 visible + unread count.
pub async fn list_notifications(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    let unread_only = params.get("unread").map(|s| s.as_str()) == Some("1");

    let notifications: Vec<NotificationRow> = sqlx::query_as(&format!(
        "SELECT {NOTIF_COLS} FROM notifications \
         WHERE (user_email IS NULL OR ($1::text IS NOT NULL AND user_email = $1)) \
           AND (NOT $2 OR read_at IS NULL) \
         ORDER BY created_at DESC, id DESC LIMIT 50"
    ))
    .bind(&actor.email)
    .bind(unread_only)
    .fetch_all(&state.db)
    .await?;

    let unread_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM notifications \
         WHERE (user_email IS NULL OR ($1::text IS NOT NULL AND user_email = $1)) \
           AND read_at IS NULL",
    )
    .bind(&actor.email)
    .fetch_one(&state.db)
    .await?;

    Ok(json_ok(serde_json::json!({
        "notifications": notifications.iter().map(serialize_notification).collect::<Vec<_>>(),
        "unreadCount": unread_count,
    })))
}

/// POST /api/notifications/{id}/read — mark ONE visible notification read
/// (idempotent: read_at stamped once). Invisible/unknown → the same 404.
pub async fn mark_read(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);

    let row: Option<NotificationRow> = sqlx::query_as(&format!(
        "SELECT {NOTIF_COLS} FROM notifications WHERE id = $1"
    ))
    .bind(&id)
    .fetch_optional(&state.db)
    .await?;

    let Some(n) = row else {
        return Err(ApiError::not_found(format!(
            "Notification '{id}' not found"
        )));
    };
    if n.user_email.is_some() && n.user_email != actor.email {
        return Err(ApiError::not_found(format!(
            "Notification '{id}' not found"
        )));
    }

    let read_at = match n.read_at {
        Some(ts) => ts,
        None => {
            let ts = Utc::now();
            sqlx::query("UPDATE notifications SET read_at = $1 WHERE id = $2")
                .bind(ts)
                .bind(&id)
                .execute(&state.db)
                .await?;
            ts
        }
    };

    Ok(json_ok(serde_json::json!({
        "id": n.id,
        "readAt": mf_types::ts::format(&read_at),
    })))
}

/// POST /api/notifications/read-all — stamp every visible unread row.
pub async fn read_all(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    let now = Utc::now();
    let updated = sqlx::query(
        "UPDATE notifications SET read_at = $1 \
         WHERE (user_email IS NULL OR ($2::text IS NOT NULL AND user_email = $2)) \
           AND read_at IS NULL",
    )
    .bind(now)
    .bind(&actor.email)
    .execute(&state.db)
    .await?
    .rows_affected() as i64;
    Ok(json_ok(serde_json::json!({ "updated": updated })))
}
