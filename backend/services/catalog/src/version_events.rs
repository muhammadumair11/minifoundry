//! Version-created event hook — port of src/lib/version-events.ts.
//!
//! Every code path that creates a NEW DatasetVersion calls
//! emit_version_created() AFTER the version row is committed:
//!  1. quality auto-evaluation (trigger 'post_run' when a pipeline produced
//!     the version, 'auto' otherwise) — never fails the caller;
//!  2. mf.dataset.version.created publication — ONLY when the version is
//!     consumable (gate off, or explicitly published); a gated draft must
//!     never trigger downstream consumers;
//!  3. watcher notifications (P4) — sim:<role> watchers become broadcasts.

use mf_events::{NotifyEvent, VersionCreatedEvent};

use crate::state::AppState;

pub struct VersionCreatedInput {
    pub dataset_id: String,
    pub version_number: i32,
    /// Best-effort actor label, e.g. "pipeline:Shipment Overview".
    pub source: Option<String>,
    pub cascade_parent_run_id: Option<String>,
    pub cascade_depth: Option<i32>,
    /// True when the new version is consumable right now (gate off, or the
    /// write explicitly produced a published version).
    pub consumable: bool,
}

/// Fire-and-forget (awaited, never-fails) notification that a dataset has a
/// new version. Call AFTER the version is visible in the DB.
pub async fn emit_version_created(state: &AppState, input: VersionCreatedInput) {
    // 1) P2: automatic quality evaluation for every new version.
    let trigger = match &input.source {
        Some(s) if s.starts_with("pipeline") => "post_run",
        _ => "auto",
    };
    if let Err(e) =
        crate::quality::evaluate_rules(state, &input.dataset_id, input.version_number, trigger)
            .await
    {
        tracing::error!(error = %e.message, "quality auto-evaluation failed");
    }

    // 2) R14: gated versions remain drafts until explicit publication —
    //    triggering a downstream pipeline here would let it observe an
    //    unapproved version.
    if input.consumable {
        let event = VersionCreatedEvent {
            dataset_id: input.dataset_id.clone(),
            version_number: input.version_number as i64,
            source: input.source.clone(),
            cascade_parent_run_id: input.cascade_parent_run_id.clone(),
            cascade_depth: input.cascade_depth,
        };
        mf_events::publish_json_quiet(&state.nats, mf_events::subject::VERSION_CREATED, &event)
            .await;
    }

    // 3) P4: notify dataset watchers about the new version.
    if let Err(e) = notify_watchers(state, &input).await {
        tracing::warn!(error = %e, "watcher notification failed (swallowed)");
    }
}

/// One notification per watcher. Session users get targeted notifications;
/// demo simulator watchers ('sim:<role>') become broadcasts so the sandbox
/// bell shows them. Never throws.
async fn notify_watchers(state: &AppState, input: &VersionCreatedInput) -> Result<(), sqlx::Error> {
    let watchers: Vec<(String,)> =
        sqlx::query_as("SELECT user_email FROM dataset_watchers WHERE dataset_id = $1")
            .bind(&input.dataset_id)
            .fetch_all(&state.db)
            .await?;
    if watchers.is_empty() {
        return Ok(());
    }
    let name: Option<(String,)> = sqlx::query_as("SELECT name FROM datasets WHERE id = $1")
        .bind(&input.dataset_id)
        .fetch_optional(&state.db)
        .await?;
    let Some((name,)) = name else { return Ok(()) };

    let label = input.source.as_deref().unwrap_or("a write");
    for (user_email,) in &watchers {
        let is_sim = user_email.starts_with("sim:");
        let event = NotifyEvent {
            user_email: if is_sim {
                None
            } else {
                Some(user_email.clone())
            },
            notif_type: "system".to_string(),
            title: format!("{name} \u{2014} new version v{}", input.version_number),
            body: Some(format!("A new version was written by {label}.")),
            resource_type: Some("dataset".to_string()),
            resource_id: Some(input.dataset_id.clone()),
            href: Some(format!("/datasets/{}", input.dataset_id)),
        };
        mf_events::publish_json_quiet(&state.nats, mf_events::subject::NOTIFY, &event).await;
    }
    Ok(())
}
