//! Upstream trigger engine — port of `src/lib/trigger-engine.ts`.
//!
//! Consumes `mf.dataset.version.created` (published by catalog AFTER quality
//! auto-evaluation, only for consumable versions) with the durable consumer
//! `orchestration-triggers`, and enqueues pipelines in `upstream` trigger mode
//! whose watched dataset ids contain the event's dataset.
//!
//! Exact legacy constants/keys:
//! - eventKey: `upstream:<pipelineId>:<datasetId>:<versionNumber>` (repeated
//!   delivery of the same version queues only once);
//! - maxAttempts = pipeline.maxRetries + 1;
//! - self-trigger guard: events sourced `pipeline:<name>` skip the pipeline
//!   with the same name (case-insensitive, trimmed);
//! - notification on a FRESH queued job: type `pipeline_triggered`,
//!   title `Queued: <name>`, body `dataset <id> v<n>[ (cascade depth <d>)]`.

use futures::StreamExt;
use mf_events::{NotifyEvent, VersionCreatedEvent};

use crate::jobs::{self, EnqueueOptions};
use crate::state::AppState;

const CONSUMER_NAME: &str = "orchestration-triggers";

pub fn spawn_trigger_consumer(state: AppState) {
    tokio::spawn(async move {
        loop {
            let js = mf_events::jetstream(&state.nats);
            let consumer = match mf_events::ensure_consumer(
                &js,
                mf_events::STREAM_EVENTS,
                CONSUMER_NAME,
                mf_events::subject::VERSION_CREATED,
                5,
            )
            .await
            {
                Ok(c) => c,
                Err(e) => {
                    tracing::warn!(error = %e, "triggers consumer setup failed; retrying in 5s");
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    continue;
                }
            };
            let mut messages = match consumer.messages().await {
                Ok(m) => m,
                Err(e) => {
                    tracing::warn!(error = %e, "triggers message stream failed; retrying in 5s");
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    continue;
                }
            };
            while let Some(next) = messages.next().await {
                let msg = match next {
                    Ok(m) => m,
                    Err(e) => {
                        tracing::warn!(error = %e, "triggers message error");
                        continue;
                    }
                };
                match mf_events::parse_message::<VersionCreatedEvent>(&msg.message) {
                    Ok(event) => {
                        if let Err(e) = handle_version_created(&state, &event).await {
                            // Legacy swallowed handler errors per event; a redelivery
                            // is harmless because the eventKey dedupes enqueues.
                            tracing::warn!(error = %e, "trigger handling failed");
                        }
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "version-created payload parse failed; skipping");
                    }
                }
                let _ = msg.ack().await;
            }
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }
    });
}

/// Port of `handleVersionCreated`.
pub async fn handle_version_created(
    state: &AppState,
    event: &VersionCreatedEvent,
) -> Result<(), anyhow::Error> {
    #[derive(sqlx::FromRow)]
    struct Candidate {
        id: String,
        name: String,
        upstream_dataset_ids: sqlx::types::Json<serde_json::Value>,
        max_retries: i32,
    }
    let candidates: Vec<Candidate> = sqlx::query_as(
        "SELECT id, name, upstream_dataset_ids, max_retries FROM pipelines WHERE trigger_mode = 'upstream'",
    )
    .fetch_all(&state.db)
    .await?;

    let cascade = match (&event.cascade_parent_run_id, event.cascade_depth) {
        (Some(parent_run_id), Some(depth)) => Some((parent_run_id.clone(), depth)),
        _ => None,
    };

    for pipeline in candidates {
        let watched: Vec<String> = match &pipeline.upstream_dataset_ids.0 {
            serde_json::Value::Array(arr) => arr
                .iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect(),
            _ => vec![],
        };
        if !watched.iter().any(|id| id == &event.dataset_id) {
            continue;
        }
        // A pipeline never re-triggers itself from its own output.
        if let Some(source) = &event.source {
            if let Some(label) = source.strip_prefix("pipeline:") {
                if label.trim().to_lowercase() == pipeline.name.trim().to_lowercase() {
                    continue;
                }
            }
        }

        let event_key = format!(
            "upstream:{}:{}:{}",
            pipeline.id, event.dataset_id, event.version_number
        );
        let payload = match &cascade {
            Some((parent_run_id, depth)) => serde_json::json!({
                "parentRunId": parent_run_id,
                "cascadeDepth": depth,
            }),
            None => serde_json::json!({}),
        };
        let job = jobs::enqueue_pipeline_job(
            state,
            &pipeline.id,
            EnqueueOptions {
                trigger: if cascade.is_some() {
                    "cascade"
                } else {
                    "upstream"
                },
                event_key,
                schedule_id: None,
                max_attempts: Some(pipeline.max_retries + 1),
                graph_version_number: None,
                payload,
            },
        )
        .await?;

        if job.status == "queued" && job.attempt == 0 {
            let body = match &cascade {
                Some((_, depth)) => format!(
                    "dataset {} v{} (cascade depth {})",
                    event.dataset_id, event.version_number, depth
                ),
                None => format!("dataset {} v{}", event.dataset_id, event.version_number),
            };
            crate::audit::notify(
                state,
                NotifyEvent {
                    user_email: None,
                    notif_type: "pipeline_triggered".into(),
                    title: format!("Queued: {}", pipeline.name),
                    body: Some(body),
                    resource_type: Some("pipeline".into()),
                    resource_id: Some(pipeline.id.clone()),
                    href: Some(format!("/pipelines/{}", pipeline.id)),
                },
            )
            .await;
        }
    }
    Ok(())
}
