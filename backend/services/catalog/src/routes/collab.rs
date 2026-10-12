//! /api/datasets/{id}/comments + /watch — Phase 4 collaboration routes.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::Response;
use mf_web::{actor_from_headers, json_created, json_ok, ApiError, ApiResult};
use serde_json::json;
use std::collections::HashMap;

use crate::audit::{audit, AuditOptions};
use crate::routes::{identity_of, require_dataset_plain, watcher_key_of};
use crate::state::{serialize_comment, AppState, CommentRow, COMMENT_COLS};
use crate::validate::{
    as_object, opt_bool, opt_int_positive_null, opt_str_trim_bounded, parse_body,
};

/// GET /api/datasets/{id}/comments — latest 200, oldest-first thread read.
pub async fn get_comments(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    require_dataset_plain(&state.db, &id).await?;

    let mut comments: Vec<CommentRow> = sqlx::query_as(&format!(
        "SELECT {COMMENT_COLS} FROM dataset_comments WHERE dataset_id = $1 \
         ORDER BY created_at DESC, id DESC LIMIT 200"
    ))
    .bind(&id)
    .fetch_all(&state.db)
    .await?;
    comments.reverse(); // oldest-first so the thread reads top-down

    Ok(json_ok(json!({
        "comments": comments.iter().map(serialize_comment).collect::<Vec<_>>(),
    })))
}

/// POST /api/datasets/{id}/comments — ANY role may discuss (collaboration is
/// the point of the tab); body 1..2000 chars, audited (201).
pub async fn post_comment(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    let (_dataset_id, dataset_name) = require_dataset_plain(&state.db, &id).await?;

    let v = parse_body(&body)?;
    let m = as_object(v)?;
    let body_text = opt_str_trim_bounded(&m, "body", 1, Some("comment is empty"), 2000)?
        .ok_or_else(|| {
            ApiError::bad_request("body: Invalid input: expected string, received undefined")
        })?;
    let version_number = opt_int_positive_null(&m, "versionNumber")?.flatten();

    let (author_key, author_label) = identity_of(&actor);
    let comment: CommentRow = sqlx::query_as(&format!(
        "INSERT INTO dataset_comments (id, dataset_id, version_number, author_key, author_label, \
          author_role, body) \
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING {COMMENT_COLS}"
    ))
    .bind(mf_db::new_id())
    .bind(&id)
    .bind(version_number.map(|n| n as i32))
    .bind(&author_key)
    .bind(&author_label)
    .bind(&actor.role)
    .bind(body_text)
    .fetch_one(&state.db)
    .await?;

    // detail: `comment on v<n>|dataset: <first 80 chars>[…]`
    let preview: String = body_text.chars().take(80).collect();
    let ellipsis = if body_text.chars().count() > 80 {
        "\u{2026}"
    } else {
        ""
    };
    let target = match version_number {
        Some(n) => format!("v{n}"),
        None => "dataset".to_string(),
    };
    audit(
        &state,
        &actor,
        AuditOptions::new("dataset.comment", "dataset")
            .resource_id(Some(&id))
            .resource_name(dataset_name.as_deref())
            .detail(Some(&format!("comment on {target}: {preview}{ellipsis}"))),
    )
    .await;

    Ok(json_created(
        json!({ "comment": serialize_comment(&comment) }),
    ))
}

/// DELETE /api/datasets/{id}/comments?commentId= — author or admin only.
pub async fn delete_comment(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    query: axum::extract::Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    let Some(comment_id) = query.get("commentId").filter(|s| !s.is_empty()) else {
        return Err(ApiError::bad_request(
            "commentId query parameter is required",
        ));
    };

    let comment: Option<CommentRow> = sqlx::query_as(&format!(
        "SELECT {COMMENT_COLS} FROM dataset_comments WHERE id = $1"
    ))
    .bind(comment_id)
    .fetch_optional(&state.db)
    .await?;
    let Some(comment) = comment.filter(|c| c.dataset_id == id) else {
        return Err(ApiError::not_found("comment not found"));
    };

    let is_author = match &actor.email {
        Some(email) => comment.author_key == *email,
        None => comment.author_key == format!("sim:{}", actor.role),
    };
    let is_admin = mf_auth::role_at_least(&actor.role, "admin");
    if !is_author && !is_admin {
        return Err(ApiError::bad_request(
            "only the comment author or an admin can delete a comment",
        ));
    }

    sqlx::query("DELETE FROM dataset_comments WHERE id = $1")
        .bind(comment_id)
        .execute(&state.db)
        .await?;

    audit(
        &state,
        &actor,
        AuditOptions::new("dataset.comment_delete", "dataset")
            .resource_id(Some(&id))
            .detail(Some(&format!("deleted comment {}", comment.id))),
    )
    .await;

    Ok(json_ok(json!({ "deleted": true })))
}

// ─── Watch ──────────────────────────────────────────────────────────────

/// GET /api/datasets/{id}/watch — { watching, watchers } for the caller.
pub async fn get_watch(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_dataset_plain(&state.db, &id).await?;

    let key = watcher_key_of(&actor);
    let mine: Option<(String,)> = sqlx::query_as(
        "SELECT id FROM dataset_watchers WHERE dataset_id = $1 AND user_email = $2 LIMIT 1",
    )
    .bind(&id)
    .bind(&key)
    .fetch_optional(&state.db)
    .await?;
    let total: i64 =
        sqlx::query_scalar("SELECT count(*) FROM dataset_watchers WHERE dataset_id = $1")
            .bind(&id)
            .fetch_one(&state.db)
            .await?;

    Ok(json_ok(
        json!({ "watching": mine.is_some(), "watchers": total }),
    ))
}

/// POST /api/datasets/{id}/watch — { watch: boolean } toggles the caller's
/// subscription; audited.
pub async fn post_watch(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    let (_dataset_id, dataset_name) = require_dataset_plain(&state.db, &id).await?;

    let v = parse_body(&body)?;
    let m = as_object(v)?;
    let watch = opt_bool(&m, "watch")?.ok_or_else(|| {
        ApiError::bad_request("watch: Invalid input: expected boolean, received undefined")
    })?;

    let key = watcher_key_of(&actor);
    if watch {
        sqlx::query(
            "INSERT INTO dataset_watchers (id, dataset_id, user_email) VALUES ($1, $2, $3) \
             ON CONFLICT (dataset_id, user_email) DO NOTHING",
        )
        .bind(mf_db::new_id())
        .bind(&id)
        .bind(&key)
        .execute(&state.db)
        .await?;
    } else {
        sqlx::query("DELETE FROM dataset_watchers WHERE dataset_id = $1 AND user_email = $2")
            .bind(&id)
            .bind(&key)
            .execute(&state.db)
            .await?;
    }

    let watchers: i64 =
        sqlx::query_scalar("SELECT count(*) FROM dataset_watchers WHERE dataset_id = $1")
            .bind(&id)
            .fetch_one(&state.db)
            .await?;
    audit(
        &state,
        &actor,
        AuditOptions::new(
            if watch {
                "dataset.watch"
            } else {
                "dataset.unwatch"
            },
            "dataset",
        )
        .resource_id(Some(&id))
        .resource_name(dataset_name.as_deref())
        .detail(Some(&format!(
            "{key} {} ({watchers} watcher{})",
            if watch {
                "now watches"
            } else {
                "stopped watching"
            },
            if watchers == 1 { "" } else { "s" }
        ))),
    )
    .await;

    Ok(json_ok(json!({ "watching": watch, "watchers": watchers })))
}
