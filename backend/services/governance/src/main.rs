//! MiniFoundry — Governance service.
//!
//! Owns the `governance` schema: markings + column markings, approval
//! requests, audit entries, per-resource ACLs, notifications, curriculum
//! progress. Serves the legacy /api/markings*, /api/approvals*, /api/audit,
//! /api/acl*, /api/notifications*, /api/curriculum, /api/settings/*,
//! /api/governance/seed-demo, /api/search, /api/stats contracts plus the
//! /internal endpoints specified in contracts/INTERNAL_API.md.
//!
//! NATS: consumes mf.audit + mf.notify (durable) into its tables; publishes
//! mf.approval.decided + mf.markings.changed (fire-and-forget).

mod consumers;
mod fanout;
mod routes;
mod state;

use axum::routing::{delete, get, post};
use axum::Router;
use std::sync::Arc;

use state::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    mf_web::init_tracing("governance-service");

    let mode = Arc::new(mf_auth::RuntimeMode::from_env());
    tracing::info!(mode = mode.mode_label(), "runtime mode resolved");

    let db = mf_db::connect_from_env("governance").await?;
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
        cookie_secure,
        clients: state::Clients::from_env(),
    };

    consumers::spawn_audit_consumer(state.clone());
    consumers::spawn_notify_consumer(state.clone());

    let app = Router::new()
        .route("/healthz", get(mf_web::healthz))
        // ── markings (M9) ──────────────────────────────────────────────
        .route(
            "/api/markings",
            get(routes::markings::list_markings).post(routes::markings::create_marking),
        )
        .route("/api/markings/{id}", delete(routes::markings::delete_marking))
        .route("/api/markings/{id}/attach", post(routes::markings::attach))
        .route("/api/markings/{id}/detach", post(routes::markings::detach))
        // ── approvals (P2 trust workflow) ──────────────────────────────
        .route(
            "/api/approvals",
            get(routes::approvals::list_approvals).post(routes::approvals::create_approval),
        )
        .route(
            "/api/approvals/{id}/decide",
            post(routes::approvals::decide_approval),
        )
        // ── audit trail ────────────────────────────────────────────────
        .route("/api/audit", get(routes::audit::list_audit))
        // ── per-resource ACLs (R14) ────────────────────────────────────
        .route(
            "/api/acl",
            get(routes::acl::list_acls).post(routes::acl::grant_acl),
        )
        .route("/api/acl/check", get(routes::acl::check_acl))
        .route("/api/acl/{acl_id}", delete(routes::acl::revoke_acl))
        // ── notification center (R14) ──────────────────────────────────
        .route("/api/notifications", get(routes::notifications::list_notifications))
        .route(
            "/api/notifications/read-all",
            post(routes::notifications::read_all),
        )
        .route(
            "/api/notifications/{id}/read",
            post(routes::notifications::mark_read),
        )
        // ── guided curriculum (P3) ─────────────────────────────────────
        .route(
            "/api/curriculum",
            get(routes::curriculum::get_curriculum)
                .post(routes::curriculum::post_curriculum)
                .delete(routes::curriculum::delete_curriculum),
        )
        // ── settings (Task 12-a) ───────────────────────────────────────
        .route("/api/settings/overview", get(routes::settings::overview))
        .route("/api/settings/reset", post(routes::settings::reset))
        // ── demo seed + cross-cutting reads ────────────────────────────
        .route("/api/governance/seed-demo", post(routes::seed_demo::seed_demo))
        .route("/api/search", get(routes::search::search))
        .route("/api/stats", get(routes::stats::stats))
        // ── internal (service-token guarded; never routed by the gateway)
        .route(
            "/internal/markings/dataset/{id}",
            get(routes::internal::dataset_markings),
        )
        .route("/internal/acl/check", get(routes::internal::acl_check))
        .route("/internal/approvals", post(routes::internal::create_approval))
        .route("/internal/stats", get(routes::internal::stats))
        .route("/internal/reset", post(routes::internal::reset))
        .with_state(state);

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(8086);
    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(port, "governance-service listening");
    axum::serve(listener, app).await?;
    Ok(())
}
