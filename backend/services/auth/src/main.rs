//! MiniFoundry — Auth service.
//!
//! Owns the `auth` schema: users, refresh tokens, public API tokens and API
//! usage logs. Issues the platform's JWT sessions, serves the legacy
//! /api/auth/*, /api/session*, /api/users*, /api/tokens* contracts, and the
//! /internal endpoints used by the gateway (refresh) and public-api (token
//! verify + rate limit). Consumes `mf.apiusage` events into usage logs.

mod audit;
mod cookies;
mod ratelimit;
mod routes;
mod state;
mod tokens_common;

use axum::routing::{delete, get, patch, post};
use axum::Router;
use std::sync::Arc;

use state::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    mf_web::init_tracing("auth-service");

    let mode = Arc::new(mf_auth::RuntimeMode::from_env());
    let secret = mf_auth::resolve_auth_secret(&mode).map_err(anyhow::Error::msg)?;
    tracing::info!(mode = mode.mode_label(), "runtime mode resolved");

    let db = mf_db::connect_from_env("auth").await?;
    let migrator = sqlx::migrate!("./migrations");
    mf_db::run_migrations(&db, &migrator).await?;

    let nats = mf_events::connect().await?;
    let js = mf_events::jetstream(&nats);
    mf_events::ensure_streams(&js).await?;

    let cookie_secure = std::env::var("MF_COOKIE_SECURE")
        .map(|v| v != "0" && v != "false")
        .unwrap_or(true);

    let state = AppState {
        db,
        nats: nats.clone(),
        mode,
        secret: Arc::new(secret),
        cookie_secure,
        rate_limiter: Arc::new(ratelimit::RateLimiter::new()),
    };

    spawn_apiusage_consumer(state.clone());

    let app = Router::new()
        .route("/healthz", get(mf_web::healthz))
        // public auth surface (gateway allowlist)
        .route("/api/auth/login", post(routes::auth_routes::login))
        .route("/api/auth/signup", post(routes::auth_routes::signup))
        .route("/api/auth/logout", post(routes::auth_routes::logout))
        .route("/api/auth/me", get(routes::auth_routes::me))
        .route(
            "/api/auth/password",
            post(routes::auth_routes::change_password),
        )
        .route("/api/session", get(routes::session::get_session))
        .route("/api/session/role", post(routes::session::set_role))
        // user + token management
        .route("/api/users", get(routes::users::list_users))
        .route("/api/users/{id}", patch(routes::users::update_user))
        .route(
            "/api/tokens",
            get(routes::tokens::list_tokens).post(routes::tokens::create_token),
        )
        .route("/api/tokens/{id}", delete(routes::tokens::revoke_token))
        .route(
            "/api/tokens/usage",
            get(routes::tokens::usage).delete(routes::tokens::clear_usage),
        )
        .route("/api/tokens/usage/seed", post(routes::tokens::seed_usage))
        // internal (service-token guarded; never routed by the gateway)
        .route("/internal/auth/refresh", post(routes::internal::refresh))
        .route(
            "/internal/tokens/verify",
            post(routes::internal::verify_token),
        )
        .route(
            "/internal/tokens/rate-limit",
            post(routes::internal::rate_limit),
        )
        .route("/internal/stats", get(routes::internal::stats))
        .route("/internal/reset", post(routes::internal::reset))
        .with_state(state);

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(8081);
    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(port, "auth-service listening");
    axum::serve(listener, app).await?;
    Ok(())
}

/// Durable consumer persisting `mf.apiusage` events (written by public-api
/// for every authenticated v1 request) into api_request_logs.
fn spawn_apiusage_consumer(state: AppState) {
    tokio::spawn(async move {
        use futures::StreamExt;
        let js = mf_events::jetstream(&state.nats);
        loop {
            let consumer = match mf_events::ensure_consumer(
                &js,
                mf_events::STREAM_EVENTS,
                "auth-apiusage",
                mf_events::subject::API_USAGE,
                5,
            )
            .await
            {
                Ok(c) => c,
                Err(e) => {
                    tracing::warn!(error = %e, "apiusage consumer setup failed; retrying in 5s");
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    continue;
                }
            };
            let mut messages = match consumer.messages().await {
                Ok(m) => m,
                Err(e) => {
                    tracing::warn!(error = %e, "apiusage message stream failed; retrying in 5s");
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    continue;
                }
            };
            while let Some(next) = messages.next().await {
                let msg = match next {
                    Ok(m) => m,
                    Err(e) => {
                        tracing::warn!(error = %e, "apiusage message error");
                        continue;
                    }
                };
                match mf_events::parse_message::<mf_events::ApiUsageEvent>(&msg.message) {
                    Ok(ev) => {
                        let result = sqlx::query(
                            "INSERT INTO api_request_logs (id, token_id, route, status, duration_ms) \
                             VALUES ($1, $2, $3, $4, $5)",
                        )
                        .bind(mf_db::new_id())
                        .bind(&ev.token_id)
                        .bind(&ev.route)
                        .bind(ev.status as i32)
                        .bind(ev.duration_ms as i32)
                        .execute(&state.db)
                        .await;
                        if let Err(e) = result {
                            tracing::warn!(error = %e, "apiusage insert failed");
                        }
                    }
                    Err(e) => {
                        // Poison message — ack to skip (DLQ noise not useful here).
                        tracing::warn!(error = %e, "apiusage payload parse failed; skipping");
                    }
                }
                let _ = msg.ack().await;
            }
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }
    });
}
