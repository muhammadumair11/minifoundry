//! MiniFoundry — Ontology service.
//!
//! Owns the `ontology` schema: object types + properties, link types, action
//! types + logs, saved object views, dashboards and applications. Serves the
//! legacy /api/ontology*, /api/objects*, /api/actions*, /api/dashboards*,
//! /api/applications* contracts and the /internal endpoints used by public-api
//! and governance. Dataset rows/schemas/versions live in catalog and are
//! reached through its internal API (masking via the `role` query param).

mod actions;
mod assemble;
mod audit;
mod catalog;
mod dbx;
mod filters;
/// EXACT port of src/lib/geo.ts (centroid tables, property auto-detection,
/// deterministic jitter). Library module: consumed by its unit tests today
/// and by the app map-data path when the frontend moves geo server-side;
/// no legacy route exposed it over HTTP (legacy resolved maps client-side).
#[allow(dead_code)]
mod geo;
mod jsonutil;
mod links;
mod objects;
mod routes;
mod serialize;
mod state;
mod values;
mod widgets;

use axum::routing::{delete, get, patch, post};
use axum::Router;
use std::sync::Arc;

use state::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    mf_web::init_tracing("ontology-service");

    let mode = Arc::new(mf_auth::RuntimeMode::from_env());

    let db = mf_db::connect_from_env("ontology").await?;
    let migrator = sqlx::migrate!("./migrations");
    mf_db::run_migrations(&db, &migrator).await?;

    let nats = mf_events::connect().await?;
    let js = mf_events::jetstream(&nats);
    mf_events::ensure_streams(&js).await?;

    let state = AppState {
        tenants: mf_db::TenantPools::new(&db),
        db,
        nats: nats.clone(),
        mode,
        catalog: catalog::CatalogClient::from_env(),
    };

    let app = Router::new()
        .route("/healthz", get(mf_web::healthz))
        // ── ontology metadata ──────────────────────────────────────────
        .route(
            "/api/ontology",
            get(routes::ontology::list_object_types).post(routes::ontology::create_object_type),
        )
        // static siblings of /api/ontology/{id} (axum: static beats param)
        .route(
            "/api/ontology/actions",
            get(routes::actions::list_action_types).post(routes::actions::create_action_type),
        )
        .route(
            "/api/ontology/actions/{id}",
            patch(routes::actions::update_action_type).delete(routes::actions::delete_action_type),
        )
        .route("/api/ontology/links", post(routes::links::create_link))
        .route(
            "/api/ontology/links/{id}",
            patch(routes::links::update_link).delete(routes::links::delete_link),
        )
        .route(
            "/api/ontology/seed-demo",
            post(routes::seed_demo::seed_demo),
        )
        .route(
            "/api/ontology/{id}",
            get(routes::ontology::get_object_type).delete(routes::ontology::delete_object_type),
        )
        // ── objects + saved views ──────────────────────────────────────
        .route("/api/objects", get(routes::objects::list_objects))
        .route(
            "/api/objects/views",
            get(routes::views::list_views).post(routes::views::create_view),
        )
        .route(
            "/api/objects/views/{view_id}",
            delete(routes::views::delete_view),
        )
        .route("/api/objects/{type}/{pk}", get(routes::objects::get_object))
        // ── actions (public + apply) ───────────────────────────────────
        .route("/api/actions", get(routes::actions::list_actions_public))
        .route("/api/actions/logs", get(routes::actions::list_action_logs))
        .route(
            "/api/actions/{api_name}",
            get(routes::actions::get_action_public),
        )
        .route(
            "/api/actions/{api_name}/apply",
            post(routes::actions::apply),
        )
        // ── dashboards ─────────────────────────────────────────────────
        .route(
            "/api/dashboards",
            get(routes::dashboards::list_dashboards).post(routes::dashboards::create_dashboard),
        )
        .route(
            "/api/dashboards/{id}",
            get(routes::dashboards::get_dashboard)
                .patch(routes::dashboards::update_dashboard)
                .delete(routes::dashboards::delete_dashboard),
        )
        .route(
            "/api/dashboards/{id}/data",
            post(routes::dashboards::widget_data),
        )
        // ── applications ───────────────────────────────────────────────
        .route(
            "/api/applications",
            get(routes::applications::list_applications)
                .post(routes::applications::create_application),
        )
        .route(
            "/api/applications/data",
            post(routes::applications::app_data),
        )
        .route(
            "/api/applications/{id}",
            get(routes::applications::get_application)
                .patch(routes::applications::update_application)
                .delete(routes::applications::delete_application),
        )
        // ── internal (service-token guarded; never routed by the gateway)
        .route(
            "/internal/ontology",
            get(routes::internal::internal_ontology),
        )
        .route(
            "/internal/objects/{type}",
            get(routes::internal::internal_objects),
        )
        .route("/internal/search", get(routes::internal::internal_search))
        .route("/internal/stats", get(routes::internal::internal_stats))
        .route(
            "/internal/curriculum-state",
            get(routes::internal::internal_curriculum_state),
        )
        .route("/internal/reset", post(routes::internal::internal_reset))
        .layer(axum::middleware::from_fn(mf_web::organization_context))
        .with_state(state);

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(8085);
    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(port, "ontology-service listening");
    axum::serve(listener, app).await?;
    Ok(())
}
