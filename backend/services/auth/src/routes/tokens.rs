//! /api/tokens* — M10 Platform API token management + M10.1 usage
//! observability (ports of the legacy tokens routes). ADMIN ONLY throughout.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::Response;
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use mf_web::{actor_from_headers, json_created, json_ok, require_role, ApiError, ApiResult};
use rand::Rng;
use sqlx::QueryBuilder;

use crate::audit::{self, AuditOptions};
use crate::ratelimit::TOKEN_RATE_LIMIT;
use crate::routes::{as_object, opt_int, parse_body, parse_body_or_empty, req_str};
use crate::state::{AppState, RequestLogRow, TokenRow, serialize_token};

const TOKEN_COLS: &str =
    "id, name, token_hash, prefix, request_count, last_used_at, revoked_at, created_at";
const LOG_COLS: &str = "id, token_id, route, status, duration_ms, created_at";

/// GET /api/tokens — list tokens (createdAt desc). Hashes NEVER returned.
pub async fn list_tokens(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "admin")?;

    let tokens: Vec<TokenRow> =
        sqlx::query_as(&format!("SELECT {TOKEN_COLS} FROM api_tokens ORDER BY created_at DESC"))
            .fetch_all(&state.db)
            .await?;
    let out: Vec<serde_json::Value> = tokens.iter().map(serialize_token).collect();
    Ok(json_ok(serde_json::json!({ "tokens": out })))
}

/// POST /api/tokens — create a token; the plaintext secret is returned
/// EXACTLY ONCE (only the sha256 hash is stored).
pub async fn create_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "admin")?;

    let v = parse_body(&body)?;
    let m = as_object(v)?;
    let name = req_str(&m, "name")?;
    if name.is_empty() {
        return Err(ApiError::bad_request("name: Too small: expected string to have >=1 chars"));
    }
    if name.chars().count() > 64 {
        return Err(ApiError::bad_request("name: Too large: expected string to have <=64 chars"));
    }

    let secret = mf_auth::generate_api_secret();
    let token_hash = mf_auth::token_sha256(&secret);
    let prefix = mf_auth::token_prefix(&secret);
    let id = mf_db::new_id();

    let result = sqlx::query_as(&format!(
        "INSERT INTO api_tokens (id, name, token_hash, prefix) VALUES ($1, $2, $3, $4) \
         RETURNING {TOKEN_COLS}"
    ))
    .bind(&id)
    .bind(name)
    .bind(&token_hash)
    .bind(&prefix)
    .fetch_one(&state.db)
    .await;

    let token: TokenRow = match result {
        Ok(t) => t,
        Err(sqlx::Error::Database(e)) if e.code().as_deref() == Some("23505") => {
            return Err(ApiError::bad_request("Token name is already in use"))
        }
        Err(e) => return Err(ApiError::internal(e.to_string())),
    };

    audit::audit(
        &state,
        &actor,
        AuditOptions::new("apiToken.create", "apiToken")
            .resource_id(Some(&token.id))
            .resource_name(Some(&token.name))
            .detail(&format!("name={} prefix={}", token.name, token.prefix)),
    )
    .await;

    Ok(json_created(serde_json::json!({
        "token": {
            "id": token.id,
            "name": token.name,
            "prefix": token.prefix,
            "createdAt": mf_types::ts::format(&token.created_at),
        },
        "secret": secret,
    })))
}

/// DELETE /api/tokens/{id} — soft-revoke (idempotent); drops the rate window.
pub async fn revoke_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "admin")?;

    let token: Option<TokenRow> =
        sqlx::query_as(&format!("SELECT {TOKEN_COLS} FROM api_tokens WHERE id = $1"))
            .bind(&id)
            .fetch_optional(&state.db)
            .await?;
    let Some(token) = token else {
        return Err(ApiError::not_found(format!("API token '{id}' not found")));
    };

    if token.revoked_at.is_none() {
        sqlx::query("UPDATE api_tokens SET revoked_at = now() WHERE id = $1")
            .bind(&id)
            .execute(&state.db)
            .await?;
        state.rate_limiter.reset(&id);
        audit::audit(
            &state,
            &actor,
            AuditOptions::new("apiToken.revoke", "apiToken")
                .resource_id(Some(&token.id))
                .resource_name(Some(&token.name))
                .detail(&format!("name={} prefix={}", token.name, token.prefix)),
        )
        .await;
    }

    Ok(json_ok(serde_json::json!({ "ok": true })))
}

// ─── M10.1 usage observability ──────────────────────────────────────────

const USAGE_WINDOW_HOURS: i64 = 24;
const USAGE_ROW_CAP: i64 = 20_000;
const TOP_ROUTES: usize = 6;
const RECENT_ERRORS: usize = 10;
const HOUR_MS: i64 = 3_600_000;

/// '2026-10-02T19:00' — UTC hour boundary label for the byHour series.
fn hour_iso(dt: DateTime<Utc>) -> String {
    dt.format("%Y-%m-%dT%H:00").to_string()
}

/// GET /api/tokens/usage — last-24h aggregate dashboard payload.
pub async fn usage(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "admin")?;

    let now = Utc::now();
    let now_ms = now.timestamp_millis();
    let since = now - ChronoDuration::hours(USAGE_WINDOW_HOURS);

    let rows: Vec<RequestLogRow> = sqlx::query_as(&format!(
        "SELECT {LOG_COLS} FROM api_request_logs WHERE created_at >= $1 LIMIT {USAGE_ROW_CAP}"
    ))
    .bind(since)
    .fetch_all(&state.db)
    .await?;

    // ── Hour buckets (zero-filled, oldest → newest, UTC boundaries) ──
    let first_bucket_ms = (now_ms / HOUR_MS) * HOUR_MS - (USAGE_WINDOW_HOURS - 1) * HOUR_MS;
    let mut buckets: Vec<(String, i64, i64)> = (0..USAGE_WINDOW_HOURS)
        .map(|i| {
            let bucket = DateTime::from_timestamp_millis(first_bucket_ms + i * HOUR_MS)
                .unwrap_or(now);
            (hour_iso(bucket), 0, 0)
        })
        .collect();

    // ── Per-token / per-route / totals ──
    let mut by_token: Vec<(String, i64, i64)> = Vec::new(); // (tokenId, count, lastSeenMs)
    let mut by_route: Vec<(String, i64)> = Vec::new();
    let (mut ok, mut errors, mut limited, mut duration_sum) = (0i64, 0i64, 0i64, 0i64);

    for row in &rows {
        let status = row.status;
        let is_ok = (200..300).contains(&status);
        let is_error = status >= 400;
        if is_ok { ok += 1 }
        if is_error { errors += 1 }
        if status == 429 { limited += 1 }
        duration_sum += row.duration_ms as i64;

        let created_ms = row.created_at.timestamp_millis();
        let bucket_idx = (created_ms / HOUR_MS - first_bucket_ms / HOUR_MS) as usize;
        if created_ms / HOUR_MS >= first_bucket_ms / HOUR_MS && bucket_idx < buckets.len() {
            buckets[bucket_idx].1 += 1;
            if is_error {
                buckets[bucket_idx].2 += 1;
            }
        }

        match by_token.iter_mut().find(|(id, _, _)| *id == row.token_id) {
            Some(agg) => {
                agg.1 += 1;
                agg.2 = agg.2.max(created_ms);
            }
            None => by_token.push((row.token_id.clone(), 1, created_ms)),
        }
        match by_route.iter_mut().find(|(r, _)| *r == row.route) {
            Some(agg) => agg.1 += 1,
            None => by_route.push((row.route.clone(), 1)),
        }
    }

    // ── Token join (in memory by id — logs survive token deletion) ──
    let token_ids: Vec<String> = by_token.iter().map(|(id, _, _)| id.clone()).collect();
    let tokens: Vec<TokenRow> = if token_ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as(&format!("SELECT {TOKEN_COLS} FROM api_tokens WHERE id = ANY($1)"))
            .bind(&token_ids)
            .fetch_all(&state.db)
            .await?
    };

    let mut token_rows: Vec<serde_json::Value> = by_token
        .iter()
        .map(|(token_id, count, last_seen_ms)| {
            let t = tokens.iter().find(|t| &t.id == token_id);
            serde_json::json!({
                "tokenId": token_id,
                "name": t.map(|t| t.name.as_str()).unwrap_or("(deleted token)"),
                "prefix": t.map(|t| t.prefix.clone()),
                "count": count,
                "lastSeen": mf_types::ts::format(
                    &DateTime::from_timestamp_millis(*last_seen_ms).unwrap_or(now)
                ),
            })
        })
        .collect();
    token_rows.sort_by(|a, b| {
        b["count"].as_i64().unwrap().cmp(&a["count"].as_i64().unwrap())
            .then_with(|| b["lastSeen"].as_str().unwrap().cmp(a["lastSeen"].as_str().unwrap()))
    });

    let mut route_rows: Vec<serde_json::Value> = by_route
        .iter()
        .map(|(route, count)| serde_json::json!({ "route": route, "count": count }))
        .collect();
    route_rows.sort_by(|a, b| {
        b["count"].as_i64().unwrap().cmp(&a["count"].as_i64().unwrap())
            .then_with(|| a["route"].as_str().unwrap().cmp(b["route"].as_str().unwrap()))
    });
    route_rows.truncate(TOP_ROUTES);

    let mut error_rows: Vec<&RequestLogRow> = rows.iter().filter(|r| r.status >= 400).collect();
    error_rows.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    let recent_errors: Vec<serde_json::Value> = error_rows
        .iter()
        .take(RECENT_ERRORS)
        .map(|r| {
            serde_json::json!({
                "id": r.id,
                "route": r.route,
                "status": r.status,
                "tokenId": r.token_id,
                "createdAt": mf_types::ts::format(&r.created_at),
            })
        })
        .collect();

    Ok(json_ok(serde_json::json!({
        "windowHours": USAGE_WINDOW_HOURS,
        "total": rows.len(),
        "ok": ok,
        "errors": errors,
        "limited": limited,
        "avgDurationMs": if rows.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::json!(((duration_sum as f64) / (rows.len() as f64)).round() as i64)
        },
        "byHour": buckets.iter().map(|(h, c, e)| serde_json::json!({
            "hourIso": h, "count": c, "errors": e,
        })).collect::<Vec<_>>(),
        "byToken": token_rows,
        "topRoutes": route_rows,
        "recentErrors": recent_errors,
    })))
}

/// DELETE /api/tokens/usage — clear ALL request logs (admin QA reset valve).
pub async fn clear_usage(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "admin")?;

    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM (DELETE FROM api_request_logs RETURNING id) d")
        .fetch_one(&state.db)
        .await?;
    audit::audit(
        &state,
        &actor,
        AuditOptions::new("apiUsage.clear", "apiToken").detail(&format!("rows={count}")),
    )
    .await;
    Ok(json_ok(serde_json::json!({ "pruned": count })))
}

// ─── M10.1 demo-traffic seeder ──────────────────────────────────────────

/// Route mix weighted like real v1 usage (cumulative weight 100).
const ROUTE_MIX: [(&str, f64); 7] = [
    ("/whoami", 10.0),
    ("/datasets", 20.0),
    ("/datasets/:id", 15.0),
    ("/datasets/:id/rows", 25.0),
    ("/objects/:type", 15.0),
    ("/pipelines", 10.0),
    ("/pipelines/:id", 5.0),
];

/// ~96% 200, ~2% 404, ~1% 403, ~1% 429 (401 is never logged by the v1 guard).
fn pick_status(rng: &mut impl Rng) -> i32 {
    let r: f64 = rng.gen();
    if r < 0.96 { 200 } else if r < 0.98 { 404 } else if r < 0.99 { 403 } else { 429 }
}

/// 5–120ms, lognormal-ish (median ≈ 25ms).
fn pick_duration_ms(rng: &mut impl Rng) -> i32 {
    let u: f64 = (rng.gen::<f64>() + rng.gen::<f64>() + rng.gen::<f64>()) / 3.0;
    let v = (1.6f64 + 3.2 * u).exp().round();
    v.clamp(5.0, 120.0) as i32
}

fn pick_route(rng: &mut impl Rng) -> &'static str {
    let r: f64 = rng.gen::<f64>() * 100.0;
    let mut acc = 0.0;
    for (route, weight) in ROUTE_MIX {
        acc += weight;
        if r < acc {
            return route;
        }
    }
    ROUTE_MIX[ROUTE_MIX.len() - 1].0
}

/// POST /api/tokens/usage/seed — synthesize realistic usage rows.
/// Refuses when recent usage already exists (idempotence valve: >20 rows in
/// the last hour OR any future-dated row).
pub async fn seed_usage(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "admin")?;

    let v = parse_body_or_empty(&body)?;
    let m = as_object(v)?;
    let hours_opt = opt_int(&m, "hours")?;
    let hours = hours_opt.unwrap_or(24).clamp(6, 48);

    let now = Utc::now();
    let now_ms = now.timestamp_millis();
    let recent: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM api_request_logs WHERE created_at >= now() - interval '1 hour'",
    )
    .fetch_one(&state.db)
    .await?;
    let future: i64 =
        sqlx::query_scalar("SELECT count(*) FROM api_request_logs WHERE created_at > now()")
            .fetch_one(&state.db)
            .await?;
    if recent > 20 || future > 0 {
        return Err(ApiError::bad_request("usage data already exists — clear it first"));
    }

    let token: Option<TokenRow> = sqlx::query_as(&format!(
        "SELECT {TOKEN_COLS} FROM api_tokens WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT 1"
    ))
    .fetch_optional(&state.db)
    .await?;
    let Some(token) = token else {
        return Err(ApiError::bad_request("no active API token found — create one first"));
    };

    // Exactly `hours` full-hour buckets ending at the current hour boundary;
    // rows spread evenly within each bucket (midpoint spacing).
    let first_bucket_ms = (now_ms / HOUR_MS) * HOUR_MS - (hours - 1) * HOUR_MS;
    let mut rng = rand::thread_rng();
    let mut qb: QueryBuilder<sqlx::Postgres> =
        QueryBuilder::new("INSERT INTO api_request_logs (id, token_id, route, status, duration_ms, created_at) ");
    let mut total: i64 = 0;

    qb.push_values(0..hours, |mut b, h| {
        let bucket_start = first_bucket_ms + h * HOUR_MS;
        let bucket_dt = DateTime::from_timestamp_millis(bucket_start).unwrap_or(now);
        // Smooth diurnal-ish wave (peak ~14:00 UTC, trough ~02:00) + jitter,
        // clamped to the 3–20 requests/hour band.
        let hour_of_day = bucket_dt.format("%H").to_string().parse::<f64>().unwrap_or(0.0);
        let wave = (((hour_of_day - 14.0) / 24.0) * std::f64::consts::TAU).cos();
        let jitter: f64 = rng.gen::<f64>() * 3.0 - 1.5;
        let count = ((11.5 + 8.5 * wave + jitter).round() as i64).clamp(3, 20);
        let step = HOUR_MS as f64 / count as f64;
        for i in 0..count {
            let created_ms = bucket_start as f64 + (i as f64 + 0.5) * step;
            let created = DateTime::from_timestamp_millis(created_ms.round() as i64).unwrap_or(now);
            b.push_bind(mf_db::new_id())
                .push_bind(&token.id)
                .push_bind(pick_route(&mut rng))
                .push_bind(pick_status(&mut rng))
                .push_bind(pick_duration_ms(&mut rng))
                .push_bind(created);
            total += 1;
        }
    });

    // push_values with zero groups produces invalid SQL — hours >= 6 always.
    let query = qb.build();
    query.execute(&state.db).await.map_err(|e| ApiError::internal(e.to_string()))?;

    audit::audit(
        &state,
        &actor,
        AuditOptions::new("apiUsage.seed", "apiToken")
            .resource_id(Some(&token.id))
            .resource_name(Some(&token.name))
            .detail(&format!("rows={total}")),
    )
    .await;

    Ok(json_created(serde_json::json!({ "seeded": total })))
}
