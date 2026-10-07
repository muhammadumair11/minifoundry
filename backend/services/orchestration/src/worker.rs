//! Job worker — replaces scripts/job-worker.ts (the standalone bun poller).
//!
//! Liveness model:
//! 1. a durable JetStream consumer (`orchestration-jobs` on MF_JOBS,
//!    subject `mf.jobs.pipeline.run`) wakes the claim loop immediately after
//!    an enqueue publishes a JobWake;
//! 2. a periodic sweep (every 15s) runs the same claim loop so jobs are still
//!    picked up when the NATS message was lost — and it recovers jobs whose
//!    RUNNING lease expired (crashed worker): the atomic claim CAS treats
//!    `status='running' AND lease_until < now()` exactly like a due queued job
//!    (attempt increments, new lease) — the Postgres row is the authority.
//!
//! Processing is sequential (one job at a time), preserving the legacy
//! single-worker run ordering; scale-out replicas stay safe via SKIP LOCKED.

use futures::StreamExt;

use crate::jobs;
use crate::state::AppState;

const CONSUMER_NAME: &str = "orchestration-jobs";
const SWEEP_INTERVAL_SECONDS: u64 = 15;

pub fn spawn_job_worker(state: AppState) {
    tokio::spawn(async move {
        let worker_id = format!("{}:{}", std::process::id(), uuid::Uuid::new_v4());
        tracing::info!(worker = %worker_id, "job worker started");

        let mut sweep = tokio::time::interval(tokio::time::Duration::from_secs(SWEEP_INTERVAL_SECONDS));
        sweep.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        // Boot catch-up: process anything left over from a previous life.
        drain(&state, &worker_id).await;

        loop {
            let js = mf_events::jetstream(&state.nats);
            let consumer = match mf_events::ensure_consumer(
                &js,
                mf_events::STREAM_JOBS,
                CONSUMER_NAME,
                mf_events::subject::JOB_PIPELINE_RUN,
                5,
            )
            .await
            {
                Ok(c) => c,
                Err(e) => {
                    tracing::warn!(error = %e, "jobs consumer setup failed; retrying in 5s");
                    tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
                    continue;
                }
            };
            let mut messages = match consumer.messages().await {
                Ok(m) => m,
                Err(e) => {
                    tracing::warn!(error = %e, "jobs message stream failed; retrying in 5s");
                    tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
                    continue;
                }
            };
            loop {
                tokio::select! {
                    next = messages.next() => {
                        match next {
                            Some(Ok(msg)) => {
                                // Wake-up only: the claim loop reads the DB.
                                drain(&state, &worker_id).await;
                                let _ = msg.ack().await;
                            }
                            Some(Err(e)) => {
                                tracing::warn!(error = %e, "jobs message error; reconnecting");
                                break;
                            }
                            None => break,
                        }
                    }
                    _ = sweep.tick() => {
                        drain(&state, &worker_id).await;
                    }
                }
            }
            tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
        }
    });
}

/// Claim-and-process until nothing claimable remains.
async fn drain(state: &AppState, worker_id: &str) {
    loop {
        match jobs::process_next_execution_job(state, worker_id).await {
            Ok(true) => continue,
            Ok(false) => break,
            Err(e) => {
                tracing::warn!(error = %e, "job claim failed; sweep will retry");
                break;
            }
        }
    }
}
