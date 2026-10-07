//! MiniFoundry — Public API service: the token-authed /api/foundry/v1 read
//! facade (M10). STATELESS by design: no database — token verification and
//! the shared sliding-window rate limit come from the auth service's
//! internal API, data comes from the owning services' internal endpoints
//! (viewer actor forwarded so masking applies), and every authenticated
//! request is usage-logged as an mf.apiusage event (consumed by auth).

mod csv;
mod fanout;
mod guard;
mod routes;
mod state;

use axum::routing::get;
use axum::Router;

use state::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    mf_web::init_tracing("public-api-service");

    let nats = mf_events::connect().await?;
    let js = mf_events::jetstream(&nats);
    mf_events::ensure_streams(&js).await?;

    let state = AppState::from_env(nats);

    let app = Router::new()
        .route("/healthz", get(mf_web::healthz))
        // ── foundry/v1 (token-authed; the gateway allowlists this prefix) ──
        .route("/api/foundry/v1/whoami", get(routes::whoami::whoami))
        .route("/api/foundry/v1/datasets", get(routes::datasets::list_datasets))
        .route(
            "/api/foundry/v1/datasets/{id}",
            get(routes::datasets::dataset_detail),
        )
        .route(
            "/api/foundry/v1/datasets/{id}/rows",
            get(routes::datasets::dataset_rows),
        )
        .route(
            "/api/foundry/v1/datasets/{id}/export",
            get(routes::datasets::dataset_export),
        )
        .route(
            "/api/foundry/v1/objects/{type}",
            get(routes::objects::list_objects),
        )
        .route(
            "/api/foundry/v1/objects/{type}/{pk}",
            get(routes::objects::get_object),
        )
        .route("/api/foundry/v1/ontology", get(routes::ontology::get_ontology))
        .route(
            "/api/foundry/v1/pipelines",
            get(routes::pipelines::list_pipelines),
        )
        .route(
            "/api/foundry/v1/pipelines/{id}",
            get(routes::pipelines::pipeline_detail),
        )
        .with_state(state);

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(8087);
    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(port, "public-api-service listening");
    axum::serve(listener, app).await?;
    Ok(())
}
