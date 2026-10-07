//! MiniFoundry — Compute service (:8084).
//!
//! Owns the `compute` schema: transforms (SQL/JS/Python workbooks) and their
//! runs. Serves the legacy /api/transforms* contracts and the /internal
//! endpoints used by governance (search/stats/curriculum fan-out, reset).
//! Workbook inputs are read and outputs written through the catalog internal
//! API (the single version-write door); audit events go to governance via
//! NATS (`mf.audit`).

mod audit;
mod catalog;
mod engine;
mod python;
mod routes;
mod state;
mod validate;

use axum::routing::{get, post};
use axum::Router;
use std::sync::Arc;

use state::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    mf_web::init_tracing("compute-service");

    let mode = Arc::new(mf_auth::RuntimeMode::from_env());
    tracing::info!(mode = mode.mode_label(), "runtime mode resolved");

    let db = mf_db::connect_from_env("compute").await?;
    let migrator = sqlx::migrate!("./migrations");
    mf_db::run_migrations(&db, &migrator).await?;

    let nats = mf_events::connect().await?;
    let js = mf_events::jetstream(&nats);
    mf_events::ensure_streams(&js).await?;

    let catalog = mf_internal::ServiceClient::from_env("catalog", "CATALOG_INTERNAL_URL", 8082);

    let state = AppState {
        db,
        nats,
        mode,
        catalog,
    };

    let app = Router::new()
        .route("/healthz", get(mf_web::healthz))
        // public workbook surface (gateway-routed)
        .route(
            "/api/transforms",
            get(routes::transforms::list_transforms).post(routes::transforms::create_transform),
        )
        .route(
            "/api/transforms/seed-demo",
            post(routes::seed_demo::seed_demo),
        )
        .route(
            "/api/transforms/{id}",
            get(routes::transforms::get_transform)
                .patch(routes::transforms::update_transform)
                .delete(routes::transforms::delete_transform),
        )
        .route(
            "/api/transforms/{id}/run",
            post(routes::runs::run_transform),
        )
        .route("/api/transforms/{id}/runs", get(routes::runs::list_runs))
        .route(
            "/api/transforms/{id}/runs/{run_id}/replay",
            post(routes::runs::replay_run),
        )
        // internal (service-token guarded; never routed by the gateway)
        .route(
            "/internal/transforms",
            get(routes::internal::list_transforms),
        )
        .route("/internal/search", get(routes::internal::search))
        .route("/internal/stats", get(routes::internal::stats))
        .route(
            "/internal/curriculum-state",
            get(routes::internal::curriculum_state),
        )
        .route("/internal/reset", post(routes::internal::reset))
        .with_state(state);

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(8084);
    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(port, "compute-service listening");
    axum::serve(listener, app).await?;
    Ok(())
}
