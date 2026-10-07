//! In-service scheduler — replaces mini-services/scheduler-service (the bun
//! poller). Same observable behavior, without the HTTP hop:
//!
//! Every 30s (TICK_INTERVAL_MS): SELECT enabled schedules whose next_run_at
//! has passed (next_run_at ASC), then for each, SEQUENTIALLY (preserves run
//! order like the legacy `for (const schedule of due) await triggerSchedule`):
//!   1. enqueue the durable job — trigger 'schedule',
//!      eventKey `schedule:<scheduleId>:<dueAt ISO>` (a repeated tick for the
//!      same window returns the same job via the unique event key),
//!      maxAttempts 1;
//!   2. reserve the window with a CAS UPDATE (`WHERE next_run_at = <dueAt>`):
//!      last_run_at = now, next_run_at = now + intervalMinutes — concurrent
//!      replicas can never double-fire the same window;
//!   3. audit as actorRole 'system', action 'pipeline.run',
//!      detail `schedule <name> job=<id>`.

use chrono::{DateTime, Utc};

use crate::audit::audit_system;
use crate::jobs::{self, EnqueueOptions};
use crate::state::AppState;

const TICK_INTERVAL_SECONDS: u64 = 30;

pub fn spawn_scheduler(state: AppState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(tokio::time::Duration::from_secs(TICK_INTERVAL_SECONDS));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            if let Err(e) = scheduler_tick(&state).await {
                tracing::warn!(error = %e, "scheduler tick failed");
            }
        }
    });
}

#[derive(sqlx::FromRow)]
struct DueSchedule {
    id: String,
    pipeline_id: String,
    name: String,
    next_run_at: DateTime<Utc>,
    pipeline_name: String,
}

async fn scheduler_tick(state: &AppState) -> Result<(), sqlx::Error> {
    let due: Vec<DueSchedule> = sqlx::query_as(
        "SELECT s.id, s.pipeline_id, s.name, s.next_run_at, p.name AS pipeline_name \
         FROM schedules s JOIN pipelines p ON p.id = s.pipeline_id \
         WHERE s.enabled AND s.next_run_at IS NOT NULL AND s.next_run_at <= now() \
         ORDER BY s.next_run_at ASC",
    )
    .fetch_all(&state.db)
    .await?;

    for schedule in due {
        // Mirrors the run-route schedule branch (the legacy scheduler POSTed
        // { scheduleId } to /api/pipelines/{id}/run with the service token).
        let due_at = schedule.next_run_at;
        let event_key = format!("schedule:{}:{}", schedule.id, mf_types::ts::format(&due_at));
        let job = jobs::enqueue_pipeline_job(
            state,
            &schedule.pipeline_id,
            EnqueueOptions {
                trigger: "schedule",
                event_key,
                schedule_id: Some(schedule.id.clone()),
                max_attempts: Some(1),
                graph_version_number: None,
                payload: serde_json::json!({}),
            },
        )
        .await;
        let job = match job {
            Ok(job) => job,
            Err(e) => {
                tracing::warn!(
                    schedule = %schedule.id,
                    error = %e,
                    "scheduler: enqueue failed (window NOT reserved; retries next tick)"
                );
                continue;
            }
        };

        // Reserve this window AFTER the job is safely stored (CAS on the exact
        // due timestamp — a concurrent replica's reserve becomes a no-op).
        let reserved = sqlx::query(
            "UPDATE schedules SET last_run_at = now(), \
                next_run_at = now() + make_interval(mins => interval_minutes), updated_at = now() \
             WHERE id = $1 AND next_run_at = $2",
        )
        .bind(&schedule.id)
        .bind(due_at)
        .execute(&state.db)
        .await?;
        if reserved.rows_affected() == 0 {
            tracing::debug!(schedule = %schedule.id, "scheduler: window already reserved by another tick");
        }

        audit_system(
            state,
            "pipeline.run",
            "pipeline",
            Some(&schedule.pipeline_id),
            Some(&schedule.pipeline_name),
            Some(&format!("schedule {} job={}", schedule.name, job.id)),
        )
        .await;
    }
    Ok(())
}

/// Reserve a schedule window after an API-triggered scheduled run (run route):
/// CAS on the exact due timestamp, then advance one interval.
pub async fn reserve_schedule_window(
    state: &AppState,
    schedule_id: &str,
    due_at: DateTime<Utc>,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query(
        "UPDATE schedules SET last_run_at = now(), \
            next_run_at = now() + make_interval(mins => interval_minutes), updated_at = now() \
         WHERE id = $1 AND next_run_at = $2",
    )
    .bind(schedule_id)
    .bind(due_at)
    .execute(&state.db)
    .await?;
    Ok(result.rows_affected() == 1)
}
