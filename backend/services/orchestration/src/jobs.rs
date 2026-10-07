//! Durable execution jobs — port of `src/lib/execution-jobs.ts`.
//!
//! eventKey idempotency, lease-based claiming, retries with delay, and the
//! run_failed notification when attempts are exhausted.
//!
//! Architecture deviation (documented): the legacy `claimExecutionJob` ran a
//! scan-loop (findFirst candidate + updateMany CAS, up to 10 scans) because
//! Prisma/SQLite had no atomic claim primitive. Here a SINGLE SQL statement
//! does the whole CAS: `UPDATE ... WHERE id = (SELECT ... WHERE (queued AND
//! available) OR (running AND lease expired) ORDER BY created_at LIMIT 1
//! FOR UPDATE SKIP LOCKED) RETURNING *` — Postgres guarantees the same
//! mutual exclusion (concurrent workers can never claim the same row; SKIP
//! LOCKED lets them claim DIFFERENT rows) with one round-trip.

use chrono::Utc;
use mf_events::{JobWake, NotifyEvent};
use serde_json::Value;
use sqlx::types::Json;

use crate::engine::{self, RunPipelineOptions};
use crate::state::{AppState, JobRow, JOB_COLS};
use crate::versions;

/// Lease lifetime granted on claim/heartbeat (legacy LEASE_MS = 2 * 60_000).
pub const LEASE_SECONDS: i64 = 120;
/// Retry backoff before a failed attempt becomes claimable again (legacy
/// RETRY_DELAY_MS = 2_000).
pub const RETRY_DELAY_MS: i64 = 2_000;
/// Heartbeat cadence while a job executes (task spec: 30s; well inside the
/// 2-minute lease; legacy used 15s against the same lease).
pub const HEARTBEAT_SECONDS: u64 = 30;

#[derive(Debug, Clone)]
pub struct EnqueueOptions {
    /// manual | schedule | upstream | replay | retry | cascade
    pub trigger: &'static str,
    pub event_key: String,
    pub schedule_id: Option<String>,
    /// Clamped to 1..=6 (legacy Math.max(1, Math.min(6, maxAttempts ?? 1))).
    pub max_attempts: Option<i32>,
    /// Pin a specific graph version instead of the latest (replay/retry).
    pub graph_version_number: Option<i32>,
    /// { inputOverrides?, replayOfRunId?, parentRunId?, cascadeDepth? }
    pub payload: Value,
}

/// Port of `enqueuePipelineJob`: eventKey-unique insert (an existing job for
/// the key is returned unchanged), pinning the graph version at event time,
/// then a NATS JobWake (publish failures tolerated — the worker's periodic
/// sweep guarantees liveness anyway).
pub async fn enqueue_pipeline_job(
    state: &AppState,
    pipeline_id: &str,
    opts: EnqueueOptions,
) -> Result<JobRow, anyhow::Error> {
    if let Some(existing) = find_by_event_key(state, &opts.event_key).await? {
        return Ok(existing);
    }

    // Capture the graph version at event time, before a learner edits it again.
    let version = match opts.graph_version_number {
        None => versions::ensure_pipeline_version(state, pipeline_id)
            .await
            .map_err(anyhow::Error::msg)?,
        Some(n) => versions::get_pipeline_version(state, pipeline_id, n)
            .await?
            .ok_or_else(|| anyhow::anyhow!("Pipeline version {n} is unavailable"))?,
    };

    let max_attempts = opts.max_attempts.unwrap_or(1).clamp(1, 6);
    let id = mf_db::new_id();
    let inserted: Option<JobRow> = sqlx::query_as(&format!(
        "INSERT INTO execution_jobs (id, pipeline_id, version_number, \"trigger\", schedule_id, event_key, payload_json, max_attempts) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) \
         ON CONFLICT (event_key) DO NOTHING \
         RETURNING {JOB_COLS}"
    ))
    .bind(&id)
    .bind(pipeline_id)
    .bind(version.version_number)
    .bind(opts.trigger)
    .bind(opts.schedule_id.clone())
    .bind(&opts.event_key)
    .bind(Json(if opts.payload.is_null() { serde_json::json!({}) } else { opts.payload.clone() }))
    .bind(max_attempts)
    .fetch_optional(&state.db)
    .await?;

    let job = match inserted {
        Some(job) => job,
        // Lost the eventKey race — return the winner (legacy P2002 re-read).
        None => find_by_event_key(state, &opts.event_key)
            .await?
            .ok_or_else(|| anyhow::anyhow!("execution job vanished after conflict"))?,
    };

    // Wake the worker (fire-and-forget; the Postgres lease stays the
    // correctness authority and the 15s sweep covers lost messages).
    mf_events::publish_json_quiet(
        &state.nats,
        mf_events::subject::JOB_PIPELINE_RUN,
        &JobWake { job_id: job.id.clone() },
    )
    .await;

    Ok(job)
}

pub async fn find_by_event_key(state: &AppState, event_key: &str) -> Result<Option<JobRow>, sqlx::Error> {
    sqlx::query_as(&format!(
        "SELECT {JOB_COLS} FROM execution_jobs WHERE event_key = $1"
    ))
    .bind(event_key)
    .fetch_optional(&state.db)
    .await
}

/// Atomic claim (see the module header): one UPDATE ... RETURNING that leases
/// the oldest claimable job — queued-and-due OR running-with-expired-lease —
/// incrementing the attempt exactly like the legacy updateMany CAS.
pub async fn claim_execution_job(state: &AppState, worker_id: &str) -> Result<Option<JobRow>, sqlx::Error> {
    sqlx::query_as(&format!(
        "UPDATE execution_jobs SET \
            status = 'running', \
            attempt = attempt + 1, \
            lease_owner = $1, \
            lease_until = now() + make_interval(secs => {LEASE_SECONDS}), \
            error = NULL, \
            updated_at = now() \
         WHERE id = ( \
            SELECT id FROM execution_jobs \
            WHERE (status = 'queued' AND available_at <= now()) \
               OR (status = 'running' AND lease_until < now()) \
            ORDER BY created_at ASC \
            LIMIT 1 \
            FOR UPDATE SKIP LOCKED \
         ) RETURNING {JOB_COLS}"
    ))
    .bind(worker_id)
    .fetch_optional(&state.db)
    .await
}

/// Port of `heartbeatExecutionJob` — extend the lease while we still own it.
pub async fn heartbeat_execution_job(state: &AppState, job_id: &str, worker_id: &str) -> Result<bool, sqlx::Error> {
    let result = sqlx::query(
        "UPDATE execution_jobs SET lease_until = now() + make_interval(secs => $3), updated_at = now() \
         WHERE id = $1 AND status = 'running' AND lease_owner = $2",
    )
    .bind(job_id)
    .bind(worker_id)
    .bind(LEASE_SECONDS)
    .execute(&state.db)
    .await?;
    Ok(result.rows_affected() == 1)
}

/// Port of `processExecutionJob` — execute the pinned version, then settle the
/// job row (succeeded / re-queued / failed) under the lease-owner guard.
pub async fn process_execution_job(state: &AppState, job: JobRow, worker_id: &str) {
    let heartbeat = {
        let state = state.clone();
        let job_id = job.id.clone();
        let owner = worker_id.to_string();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(tokio::time::Duration::from_secs(HEARTBEAT_SECONDS));
            tick.tick().await; // first tick fires immediately — skip it
            loop {
                tick.tick().await;
                match heartbeat_execution_job(&state, &job_id, &owner).await {
                    Ok(true) => {}
                    Ok(false) => break, // lease lost — stop heartbeating
                    Err(e) => tracing::warn!(error = %e, "job heartbeat failed"),
                }
            }
        })
    };

    let outcome = execute_job(state, &job, worker_id).await;
    heartbeat.abort();

    match outcome {
        Ok(JobOutcome::Settled) => {}
        Ok(JobOutcome::BusyRequeued) => {}
        Err(message) => settle_failure(state, &job, worker_id, &message).await,
    }
}

enum JobOutcome {
    /// success path finalized the row.
    Settled,
    /// pipeline busy → re-queued without consuming an attempt.
    BusyRequeued,
}

async fn execute_job(state: &AppState, job: &JobRow, worker_id: &str) -> Result<JobOutcome, String> {
    // The pinned graph snapshot is the execution contract for this job.
    let version = versions::get_pipeline_version(state, &job.pipeline_id, job.version_number)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Pipeline version {} is unavailable", job.version_number))?;

    let payload = &job.payload_json.0;
    let mut input_overrides = std::collections::HashMap::new();
    if let Some(obj) = payload.get("inputOverrides").and_then(|v| v.as_object()) {
        for (k, v) in obj {
            if let Some(n) = v.as_i64() {
                input_overrides.insert(k.clone(), n);
            }
        }
    }
    let replay_of_run_id = payload.get("replayOfRunId").and_then(|v| v.as_str()).map(String::from);
    let cascade_depth = payload
        .get("cascadeDepth")
        .and_then(|v| v.as_i64())
        .unwrap_or(0)
        .clamp(i32::MIN as i64, i32::MAX as i64) as i32;

    let trigger = if job.attempt == 1 { job.trigger.clone() } else { "retry".to_string() };
    let run = engine::run_pipeline(
        state,
        &job.pipeline_id,
        RunPipelineOptions {
            output_job_id: Some(job.id.clone()),
            cascade_depth,
            graph_override: Some(version.graph_json.0.clone()),
            version_number: Some(version.version_number),
            chain: Default::default(),
            trigger,
            attempt: job.attempt,
            input_overrides,
            replay_of_run_id,
        },
    )
    .await
    .map_err(|e| e.to_string())?;

    // Record the run against the job (lease-owner guarded like legacy updateMany).
    let _ = sqlx::query(
        "UPDATE execution_jobs SET last_run_id = $1, updated_at = now() \
         WHERE id = $2 AND status = 'running' AND lease_owner = $3",
    )
    .bind(&run.id)
    .bind(&job.id)
    .bind(worker_id)
    .execute(&state.db)
    .await;

    if run.failure_cause.as_deref() == Some(engine::PIPELINE_BUSY_MESSAGE) {
        // Busy pipelines re-queue WITHOUT consuming an attempt (legacy decrement).
        let _ = sqlx::query(
            "UPDATE execution_jobs SET status = 'queued', attempt = GREATEST(attempt - 1, 0), \
                available_at = now() + make_interval(secs => $1), lease_owner = NULL, lease_until = NULL, \
                error = $2, updated_at = now() \
             WHERE id = $3 AND status = 'running' AND lease_owner = $4",
        )
        .bind(RETRY_DELAY_MS as f64 / 1000.0)
        .bind(engine::PIPELINE_BUSY_MESSAGE)
        .bind(&job.id)
        .bind(worker_id)
        .execute(&state.db)
        .await;
        return Ok(JobOutcome::BusyRequeued);
    }

    if run.status != "success" {
        let message = run
            .failure_cause
            .clone()
            .unwrap_or_else(|| format!("Pipeline run {} failed", run.id));
        return Err(message);
    }

    let _ = sqlx::query(
        "UPDATE execution_jobs SET status = 'succeeded', last_run_id = $1, lease_owner = NULL, \
            lease_until = NULL, finished_at = now(), updated_at = now() \
         WHERE id = $2 AND status = 'running' AND lease_owner = $3",
    )
    .bind(&run.id)
    .bind(&job.id)
    .bind(worker_id)
    .execute(&state.db)
    .await;
    Ok(JobOutcome::Settled)
}

/// Failure settle: retry (re-queue with delay) or fail + notify when the
/// attempts are exhausted (port of the legacy catch block).
async fn settle_failure(state: &AppState, job: &JobRow, worker_id: &str, message: &str) {
    let exhausted = job.attempt >= job.max_attempts;
    let updated = sqlx::query(
        "UPDATE execution_jobs SET status = $1, error = $2, lease_owner = NULL, lease_until = NULL, \
            available_at = now() + make_interval(secs => $3), finished_at = CASE WHEN $4 THEN now() ELSE NULL END, \
            updated_at = now() \
         WHERE id = $5 AND status = 'running' AND lease_owner = $6",
    )
    .bind(if exhausted { "failed" } else { "queued" })
    .bind(message)
    .bind(RETRY_DELAY_MS as f64 / 1000.0)
    .bind(exhausted)
    .bind(&job.id)
    .bind(worker_id)
    .execute(&state.db)
    .await;

    let rows = updated.map(|r| r.rows_affected()).unwrap_or(0);
    if exhausted && rows == 1 {
        let pipeline_name: Option<(String,)> =
            sqlx::query_as("SELECT name FROM pipelines WHERE id = $1")
                .bind(&job.pipeline_id)
                .fetch_optional(&state.db)
                .await
                .unwrap_or(None);
        let label = pipeline_name.map(|(n,)| n).unwrap_or_else(|| job.pipeline_id.clone());
        // Legacy body: `attempt <a>/<m>: <message.slice(0, 160)>`.
        let snippet: String = message.chars().take(160).collect();
        crate::audit::notify(
            state,
            NotifyEvent {
                user_email: None,
                notif_type: "run_failed".into(),
                title: format!("Pipeline failed: {label}"),
                body: Some(format!("attempt {}/{}: {snippet}", job.attempt, job.max_attempts)),
                resource_type: Some("pipeline".into()),
                resource_id: Some(job.pipeline_id.clone()),
                href: Some(format!("/pipelines/{}", job.pipeline_id)),
            },
        )
        .await;
    }
}

// helpers keeping execute_job readable (worker id is threaded via the job row)

/// Claim + process one job; returns whether a job was processed
/// (port of `processNextExecutionJob`).
pub async fn process_next_execution_job(state: &AppState, worker_id: &str) -> Result<bool, sqlx::Error> {
    let Some(job) = claim_execution_job(state, worker_id).await? else {
        return Ok(false);
    };
    // The claimed row already carries the incremented attempt (RETURNING).
    process_execution_job(state, job, worker_id).await;
    Ok(true)
}

/// Current epoch millis — eventKey suffixes (legacy Date.now()).
pub fn now_millis() -> i64 {
    Utc::now().timestamp_millis()
}
