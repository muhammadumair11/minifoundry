//! MiniFoundry — Catalog service.
//!
//! Owns the `catalog` schema: projects, connectors, ingestions, datasets,
//! dataset versions (+ indexed row storage), branches, quality rules/results,
//! comments, watchers and lineage edges. Serves the legacy /api/projects,
//! /api/datasets, /api/connectors, /api/ingest(ions), /api/lineage and
//! /api/seed contracts plus the /internal endpoints the other services code
//! against (contracts/INTERNAL_API.md "catalog" section — including THE
//! single version-write door). Consumes `mf.approval.decided` (durable
//! consumer "catalog-approvals") as the retry path for gated publication.

mod audit;
mod branching;
mod csvutil;
mod dataset_service;
mod egress;
mod jsval;
mod masking;
mod parsers;
mod provenance;
mod publication;
mod quality;
mod real_ingest;
mod routes;
mod rows;
mod seed;
mod seed_data;
mod state;
mod validate;
mod version_events;

use axum::routing::{delete, get, patch, post};
use axum::Router;

use state::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    mf_web::init_tracing("catalog-service");

    let db = mf_db::connect_from_env("catalog").await?;
    let migrator = sqlx::migrate!("./migrations");
    mf_db::run_migrations(&db, &migrator).await?;

    let nats = mf_events::connect().await?;
    let js = mf_events::jetstream(&nats);
    mf_events::ensure_streams(&js).await?;

    let state = AppState::from_env(db, nats.clone()).await?;

    spawn_approval_consumer(state.clone());

    let app = Router::new()
        .route("/healthz", get(mf_web::healthz))
        // ── public surface (gateway-routed; contracts = fixtures + legacy) ──
        .route(
            "/api/projects",
            get(routes::projects::list_projects).post(routes::projects::create_project),
        )
        .route(
            "/api/projects/{id}",
            patch(routes::projects::update_project).delete(routes::projects::delete_project),
        )
        .route("/api/datasets", get(routes::datasets::get_datasets))
        .route(
            "/api/datasets/{id}",
            get(routes::datasets::get_dataset)
                .patch(routes::datasets::update_dataset)
                .delete(routes::datasets::delete_dataset),
        )
        .route("/api/datasets/{id}/rows", get(routes::rows::get_rows))
        .route("/api/datasets/{id}/diff", get(routes::rows::get_diff))
        .route(
            "/api/datasets/{id}/export",
            get(routes::rows::export_dataset),
        )
        .route(
            "/api/datasets/{id}/publish",
            post(routes::publish::publish_dataset),
        )
        .route(
            "/api/datasets/{id}/prune",
            post(routes::publish::prune_versions),
        )
        .route(
            "/api/datasets/{id}/branches",
            get(routes::branches::get_branches).post(routes::branches::post_branches),
        )
        .route(
            "/api/datasets/{id}/branches/{branch_id}",
            delete(routes::branches::delete_branch_route),
        )
        .route(
            "/api/datasets/{id}/branches/{branch_id}/commit",
            post(routes::branches::commit_branch),
        )
        .route(
            "/api/datasets/{id}/branches/{branch_id}/merge",
            post(routes::branches::merge_branch_route),
        )
        .route(
            "/api/datasets/{id}/comments",
            get(routes::collab::get_comments)
                .post(routes::collab::post_comment)
                .delete(routes::collab::delete_comment),
        )
        .route(
            "/api/datasets/{id}/quality",
            get(routes::quality_routes::get_quality).post(routes::quality_routes::post_quality),
        )
        .route(
            "/api/datasets/{id}/quality/{rule_id}",
            patch(routes::quality_routes::patch_quality_rule)
                .delete(routes::quality_routes::delete_quality_rule),
        )
        .route(
            "/api/datasets/{id}/quality/evaluate",
            post(routes::quality_routes::evaluate_quality),
        )
        .route(
            "/api/datasets/{id}/watch",
            get(routes::collab::get_watch).post(routes::collab::post_watch),
        )
        .route(
            "/api/connectors",
            get(routes::connectors::list_connectors).post(routes::connectors::create_connector),
        )
        .route(
            "/api/connectors/{id}",
            patch(routes::connectors::update_connector)
                .delete(routes::connectors::delete_connector),
        )
        .route(
            "/api/connectors/{id}/ingest",
            post(routes::connectors::ingest_connector),
        )
        .route(
            "/api/connectors/test-config",
            post(routes::connectors::test_config),
        )
        .route("/api/ingest", post(routes::ingest::post_ingest))
        .route("/api/ingestions", get(routes::ingest::list_ingestions))
        .route("/api/lineage", get(routes::lineage::get_lineage))
        .route("/api/lineage/impact", get(routes::lineage::get_impact))
        .route(
            "/api/lineage/versions",
            get(routes::lineage::get_version_lineage),
        )
        .route("/api/seed", post(routes::seed_route::post_seed))
        // ── internal (service-token guarded; never routed by the gateway) ──
        .route(
            "/internal/datasets",
            get(routes::internal::internal_list_datasets)
                .post(routes::internal::internal_create_dataset),
        )
        .route(
            "/internal/datasets/by-name/{name}",
            get(routes::internal::internal_dataset_by_name),
        )
        .route(
            "/internal/datasets/{id}",
            get(routes::internal::internal_dataset_detail)
                .delete(routes::internal::internal_delete_dataset),
        )
        .route(
            "/internal/datasets/{id}/versions",
            post(routes::internal::internal_append_version),
        )
        .route(
            "/internal/datasets/{id}/versions/{n}",
            get(routes::internal::internal_get_version)
                .delete(routes::internal::internal_delete_version),
        )
        .route(
            "/internal/datasets/{id}/versions/{n}/rows",
            get(routes::internal::internal_version_rows),
        )
        .route(
            "/internal/datasets/{id}/versions/{n}/rows/all",
            get(routes::internal::internal_version_rows_all),
        )
        .route(
            "/internal/datasets/{id}/publish-approved",
            post(routes::internal::internal_publish_approved),
        )
        .route(
            "/internal/lineage/dataset/{id}",
            get(routes::internal::internal_lineage_dataset),
        )
        .route(
            "/internal/health/datasets",
            get(routes::internal::internal_health_datasets),
        )
        .route("/internal/search", get(routes::internal::internal_search))
        .route("/internal/stats", get(routes::internal::internal_stats))
        .route(
            "/internal/curriculum-state",
            get(routes::internal::internal_curriculum_state),
        )
        .route("/internal/reset", post(routes::internal::internal_reset))
        .with_state(state);

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(8082);
    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(port, "catalog-service listening");
    axum::serve(listener, app).await?;
    Ok(())
}

/// Durable consumer for `mf.approval.decided` (governance → catalog): the
/// retry/fallback path for the sync publish-approved internal call. On
/// status=approved kind=publish_dataset → idempotent publication flip.
/// Pattern copied from the auth service's apiusage consumer: retry loop,
/// explicit acks, poison-skip.
fn spawn_approval_consumer(state: AppState) {
    tokio::spawn(async move {
        use futures::StreamExt;
        let js = mf_events::jetstream(&state.nats);
        loop {
            let consumer = match mf_events::ensure_consumer(
                &js,
                mf_events::STREAM_EVENTS,
                "catalog-approvals",
                mf_events::subject::APPROVAL_DECIDED,
                5,
            )
            .await
            {
                Ok(c) => c,
                Err(e) => {
                    tracing::warn!(error = %e, "approval consumer setup failed; retrying in 5s");
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    continue;
                }
            };
            let mut messages = match consumer.messages().await {
                Ok(m) => m,
                Err(e) => {
                    tracing::warn!(error = %e, "approval message stream failed; retrying in 5s");
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    continue;
                }
            };
            while let Some(next) = messages.next().await {
                let msg = match next {
                    Ok(m) => m,
                    Err(e) => {
                        tracing::warn!(error = %e, "approval message error");
                        continue;
                    }
                };
                match mf_events::parse_message::<mf_events::ApprovalDecidedEvent>(&msg.message) {
                    Ok(ev) => {
                        if ev.kind == "publish_dataset" && ev.status == "approved" {
                            match ev.version_number {
                                Some(version_number) => {
                                    let result = routes::internal::handle_approval_decided(
                                        &state,
                                        &ev.target_id,
                                        version_number as i32,
                                        &ev.approval_id,
                                        &ev.decided_by,
                                    )
                                    .await;
                                    match result {
                                        Ok(()) => {
                                            let _ = msg.ack().await;
                                        }
                                        Err(e) => {
                                            // Transient failure → redeliver up to
                                            // max_deliver, then DLQ.
                                            tracing::warn!(
                                                error = %e,
                                                approval_id = %ev.approval_id,
                                                "publish-approved processing failed; naking"
                                            );
                                            let _ = msg
                                                .ack_with(async_nats::jetstream::AckKind::Nak(None))
                                                .await;
                                        }
                                    }
                                }
                                None => {
                                    // Legacy request without a pinned draft —
                                    // nothing to publish; ack to skip.
                                    tracing::warn!(
                                        approval_id = %ev.approval_id,
                                        "approval decided without versionNumber; skipping"
                                    );
                                    let _ = msg.ack().await;
                                }
                            }
                        } else {
                            // Rejections and other kinds are governance-side state.
                            let _ = msg.ack().await;
                        }
                    }
                    Err(e) => {
                        // Poison message — ack to skip (DLQ noise not useful here).
                        tracing::warn!(error = %e, "approval payload parse failed; skipping");
                        let _ = msg.ack().await;
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }
    });
}
