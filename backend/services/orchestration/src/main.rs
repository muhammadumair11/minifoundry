//! MiniFoundry — Orchestration service: pipelines, engine, runs, jobs, schedules.
//!
//! Owns the `orchestration` schema (pipelines, pipeline_versions,
//! pipeline_runs, execution_jobs, schedules). Serves the legacy
//! /api/pipelines*, /api/runs*, /api/execution-jobs*, /api/schedules*,
//! /api/health contracts plus the /internal endpoints from INTERNAL_API.md.
//!
//! Background tasks (all in-process, replacing the legacy bun workers):
//! - job worker: durable NATS consumer `orchestration-jobs` on MF_JOBS waking
//!   an atomic Postgres claim loop + a 15s sweep (lost wake-ups, expired
//!   leases after crashes);
//! - trigger consumer: durable `orchestration-triggers` on
//!   mf.dataset.version.created (upstream-mode pipelines, trigger-engine port);
//! - scheduler: 30s tick firing due schedule windows through the same
//!   eventKey-idempotent job enqueue (replaces mini-services/scheduler-service).

mod audit;
mod catalog;
mod engine;
mod jobs;
mod routes;
mod scheduler;
mod state;
mod triggers;
mod values;
mod versions;
mod worker;

use axum::routing::{get, patch, post};
use axum::Router;
use std::sync::Arc;

use state::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    mf_web::init_tracing("orchestration-service");

    let mode = Arc::new(mf_auth::RuntimeMode::from_env());
    tracing::info!(mode = mode.mode_label(), "runtime mode resolved");

    let db = mf_db::connect_from_env("orchestration").await?;
    let migrator = sqlx::migrate!("./migrations");
    mf_db::run_migrations(&db, &migrator).await?;

    let nats = mf_events::connect().await?;
    let js = mf_events::jetstream(&nats);
    mf_events::ensure_streams(&js).await?;

    let catalog = Arc::new(catalog::CatalogClient::from_env(mode.demo));

    let state = AppState { db, nats: nats.clone(), mode, catalog };

    // Background: durable job worker (+sweep), upstream triggers, scheduler.
    worker::spawn_job_worker(state.clone());
    triggers::spawn_trigger_consumer(state.clone());
    scheduler::spawn_scheduler(state.clone());

    let app = Router::new()
        .route("/healthz", get(mf_web::healthz))
        // pipelines
        .route("/api/pipelines", get(routes::pipelines::list_pipelines).post(routes::pipelines::create_pipeline))
        .route(
            "/api/pipelines/{id}",
            get(routes::pipelines::pipeline_detail)
                .put(routes::pipelines::update_pipeline)
                .patch(routes::pipelines::update_pipeline)
                .delete(routes::pipelines::delete_pipeline),
        )
        .route("/api/pipelines/{id}/run", post(routes::pipelines::run_pipeline))
        .route("/api/pipelines/{id}/restore", post(routes::pipelines::restore_pipeline))
        .route("/api/pipelines/{id}/versions", get(routes::pipelines::list_versions))
        .route("/api/pipelines/{id}/versions/{version}", get(routes::pipelines::version_detail))
        .route(
            "/api/pipelines/{id}/runs/{runId}/output",
            get(routes::pipelines::output_status).delete(routes::pipelines::output_delete),
        )
        // runs
        .route("/api/runs", get(routes::runs::list_runs))
        .route("/api/runs/{id}", get(routes::runs::run_detail))
        .route("/api/runs/{id}/replay", post(routes::runs::replay_run))
        .route("/api/runs/{id}/retry", post(routes::runs::retry_run))
        // execution jobs
        .route("/api/execution-jobs", get(routes::jobs::list_jobs))
        .route("/api/execution-jobs/{id}", get(routes::jobs::job_detail))
        // schedules (the static /due segment wins over /{id} in axum's matcher)
        .route("/api/schedules", get(routes::schedules::list_schedules).post(routes::schedules::create_schedule))
        .route("/api/schedules/due", get(routes::schedules::due_schedules))
        .route(
            "/api/schedules/{id}",
            patch(routes::schedules::update_schedule).delete(routes::schedules::delete_schedule),
        )
        // platform health (gateway-routed; aggregates runs + catalog datasets)
        .route("/api/health", get(routes::health::health))
        // internal (service-token guarded; never routed by the gateway)
        .route("/internal/pipelines", get(routes::internal::internal_pipelines))
        .route("/internal/pipelines/{id}", get(routes::internal::internal_pipeline_detail))
        .route("/internal/runs", get(routes::internal::internal_runs))
        .route("/internal/health/runs", get(routes::internal::internal_health_runs))
        .route("/internal/search", get(routes::internal::internal_search))
        .route("/internal/stats", get(routes::internal::internal_stats))
        .route("/internal/curriculum-state", get(routes::internal::internal_curriculum_state))
        .route("/internal/reset", post(routes::internal::internal_reset))
        .with_state(state);

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(8083);
    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(port, "orchestration-service listening");
    axum::serve(listener, app).await?;
    Ok(())
}
