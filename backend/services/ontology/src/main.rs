//! MiniFoundry — Ontology service: object types, links, actions, views, dashboards, applications.
//!
//! Skeleton (Phase 0): boots tracing + /healthz. Domain routes are ported
//! from the legacy Next.js handlers in the service's implementation phase;
//! JSON contracts are pinned by backend/contracts golden tests.

use axum::{routing::get, Router};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    mf_web::init_tracing("ontology-service");
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(8085);

    let app = Router::new().route("/healthz", get(mf_web::healthz));

    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(port, "ontology-service listening");
    axum::serve(listener, app).await?;
    Ok(())
}