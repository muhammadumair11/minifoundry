//! MiniFoundry — NATS JetStream integration shared by every service.
//!
//! Topology (see plan):
//! - Stream `MF_EVENTS` (file storage): domain events — dataset version
//!   created, notifications, audit, approval decisions, markings changes,
//!   API usage.
//! - Stream `MF_JOBS` (file storage): pipeline job dispatch wake-ups. The
//!   Postgres `execution_jobs` lease remains the correctness authority; NATS
//!   removes the 1s polling latency and lets orchestration scale out.
//! - Failures past `max_deliver` land on `mf.dlq.>`.
//!
//! Sync cross-service calls use internal HTTP (see mf-internal), not NATS
//! request/reply, for debuggability.

use anyhow::Context;
use async_nats::jetstream::{self, consumer, stream};
use serde::{Deserialize, Serialize};
tokio::task_local! { static ORGANIZATION: Option<String>; }

pub fn organization_id() -> Option<String> {
    ORGANIZATION.try_with(Clone::clone).ok().flatten()
}

pub async fn with_organization<F: std::future::Future>(
    organization: Option<String>,
    future: F,
) -> F::Output {
    ORGANIZATION.scope(organization, future).await
}

/// Historical unscoped messages cannot be attributed safely to a new tenant.
pub fn message_organization(msg: &async_nats::Message) -> Option<String> {
    serde_json::from_slice::<serde_json::Value>(&msg.payload)
        .ok()?
        .get("organizationId")?
        .as_str()
        .map(str::to_owned)
}

// ─── Subjects ───────────────────────────────────────────────────────────

pub mod subject {
    /// Published by catalog AFTER quality auto-evaluation, only when the
    /// version is consumable (gate off, or published). Consumed by
    /// orchestration (upstream triggers).
    pub const VERSION_CREATED: &str = "mf.dataset.version.created";
    /// Any service → governance (persists Notification rows).
    pub const NOTIFY: &str = "mf.notify";
    /// Any service → governance (persists AuditEntry rows).
    pub const AUDIT: &str = "mf.audit";
    /// Governance → catalog: an approval was decided; retry/idempotent
    /// fallback for the sync internal publish call.
    pub const APPROVAL_DECIDED: &str = "mf.approval.decided";
    /// Governance → interested services: column markings changed.
    pub const MARKINGS_CHANGED: &str = "mf.markings.changed";
    /// public-api → auth: one authenticated v1 request occurred.
    pub const API_USAGE: &str = "mf.apiusage";
    /// Orchestration internal: a pipeline job was enqueued (wake-up).
    pub const JOB_PIPELINE_RUN: &str = "mf.jobs.pipeline.run";
    /// Dead letters.
    pub const DLQ_PREFIX: &str = "mf.dlq";
}

pub const STREAM_EVENTS: &str = "MF_EVENTS";
pub const STREAM_JOBS: &str = "MF_JOBS";

// ─── Event payloads (camelCase JSON, contract-stable) ──────────────────

/// Port of `VersionCreatedEvent` in version-events.ts.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionCreatedEvent {
    pub dataset_id: String,
    pub version_number: i64,
    /// Best-effort actor label, e.g. `pipeline:Shipment Overview`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cascade_parent_run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cascade_depth: Option<i32>,
}

/// Port of `createNotification()` inputs in notify.ts.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyEvent {
    /// None = broadcast to all users. `sim:<role>` watchers become broadcasts.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_email: Option<String>,
    /// run_failed | quality_failed | approval_requested | pipeline_triggered | system
    #[serde(rename = "type")]
    pub notif_type: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub href: Option<String>,
}

/// Port of the `audit()` fire-and-forget write in governance.ts.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEvent {
    pub actor_role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor_email: Option<String>,
    pub action: String,
    pub resource_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// Governance → catalog after an approval decision.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalDecidedEvent {
    pub approval_id: String,
    /// publish_dataset | publish_pipeline
    pub kind: String,
    pub target_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_number: Option<i64>,
    /// approved | rejected
    pub status: String,
    pub decided_by: String,
}

/// Governance → services when markings/attachments change.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkingsChangedEvent {
    pub dataset_id: String,
}

/// public-api → auth usage log row.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiUsageEvent {
    pub token_id: String,
    pub route: String,
    pub status: u16,
    pub duration_ms: i64,
}

/// MF_JOBS payload — wake-up only; the job row is the source of truth.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobWake {
    pub job_id: String,
}

// ─── Connection & stream provisioning ───────────────────────────────────

/// Connect to NATS (`NATS_URL`, default `nats://nats:4222`).
pub async fn connect() -> anyhow::Result<async_nats::Client> {
    let url = std::env::var("NATS_URL").unwrap_or_else(|_| "nats://nats:4222".into());
    connect_to(&url).await
}

pub async fn connect_to(url: &str) -> anyhow::Result<async_nats::Client> {
    let client = async_nats::connect(url)
        .await
        .with_context(|| format!("cannot connect to NATS at {url}"))?;
    tracing::info!(url, "nats connected");
    Ok(client)
}

pub fn jetstream(client: &async_nats::Client) -> jetstream::Context {
    jetstream::new(client.clone())
}

/// Idempotently create the platform streams. Called at every service boot
/// (create_stream with the same config is a no-op update).
pub async fn ensure_streams(js: &jetstream::Context) -> anyhow::Result<()> {
    js.create_stream(stream::Config {
        name: STREAM_EVENTS.into(),
        subjects: vec![
            subject::VERSION_CREATED.into(),
            subject::NOTIFY.into(),
            subject::AUDIT.into(),
            subject::APPROVAL_DECIDED.into(),
            subject::MARKINGS_CHANGED.into(),
            subject::API_USAGE.into(),
            format!("{}.>", subject::DLQ_PREFIX),
        ],
        storage: stream::StorageType::File,
        max_age: std::time::Duration::from_secs(7 * 24 * 3600),
        ..Default::default()
    })
    .await
    .context("create MF_EVENTS stream")?;

    js.create_stream(stream::Config {
        name: STREAM_JOBS.into(),
        subjects: vec![subject::JOB_PIPELINE_RUN.into()],
        storage: stream::StorageType::File,
        ..Default::default()
    })
    .await
    .context("create MF_JOBS stream")?;

    tracing::info!("jetstream MF_EVENTS + MF_JOBS ensured");
    Ok(())
}

/// Ensure a durable pull consumer with explicit acks and a bounded redelivery
/// count (failures land on the DLQ via `deadletter` when configured).
pub async fn ensure_consumer(
    js: &jetstream::Context,
    stream_name: &str,
    durable: &str,
    filter_subject: &str,
    max_deliver: i64,
) -> anyhow::Result<consumer::Consumer<consumer::pull::Config>> {
    let stream = js
        .get_stream(stream_name)
        .await
        .with_context(|| format!("get stream {stream_name}"))?;
    let consumer = stream
        .create_consumer(consumer::pull::Config {
            durable_name: Some(durable.into()),
            filter_subject: filter_subject.into(),
            ack_policy: consumer::AckPolicy::Explicit,
            max_deliver,
            deliver_policy: consumer::DeliverPolicy::All,
            replay_policy: consumer::ReplayPolicy::Instant,
            ..Default::default()
        })
        .await
        .with_context(|| format!("create consumer {durable} on {stream_name}"))?;
    Ok(consumer)
}

/// Publish a JSON event (fire-and-forget semantics preserved: callers log
/// failures but must not fail their main flow — same as the old in-process
/// listeners whose errors were swallowed).
pub async fn publish_json<T: Serialize>(
    client: &async_nats::Client,
    subject: &str,
    payload: &T,
) -> anyhow::Result<()> {
    let mut value = serde_json::to_value(payload).context("serialize event")?;
    if let Some(organization) = organization_id() {
        value["organizationId"] = organization.into();
    }
    let bytes = serde_json::to_vec(&value).context("serialize scoped event")?;
    client
        .publish(subject.to_string(), bytes.into())
        .await
        .with_context(|| format!("publish {subject}"))?;
    client.flush().await?;
    Ok(())
}

/// Best-effort publish for the fire-and-forget paths (audit/notify): logs and
/// swallows errors, mirroring the old never-throws behavior.
pub async fn publish_json_quiet<T: Serialize>(
    client: &async_nats::Client,
    subject: &str,
    payload: &T,
) {
    if let Err(e) = publish_json(client, subject, payload).await {
        tracing::warn!(subject, error = %e, "event publish failed (swallowed)");
    }
}

/// Parse an incoming message payload; on failure nak without retry storm
/// (redeliver after a delay so poison messages eventually hit max_deliver).
/// Takes the raw `async_nats::Message` (the `.message` field of a JetStream
/// message) since that is where the payload lives.
pub fn parse_message<T: serde::de::DeserializeOwned>(
    msg: &async_nats::Message,
) -> Result<T, serde_json::Error> {
    serde_json::from_slice::<T>(&msg.payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn concurrent_fanout_scopes_do_not_cross_or_persist() {
        tokio::join!(
            with_organization(Some("org_a".into()), async {
                tokio::task::yield_now().await;
                assert_eq!(organization_id().as_deref(), Some("org_a"));
            }),
            with_organization(Some("org_b".into()), async {
                tokio::task::yield_now().await;
                assert_eq!(organization_id().as_deref(), Some("org_b"));
            }),
        );
        assert_eq!(organization_id(), None);
    }

    #[test]
    fn version_created_event_camel_case() {
        let e = VersionCreatedEvent {
            dataset_id: "d1".into(),
            version_number: 3,
            source: Some("pipeline:P".into()),
            cascade_parent_run_id: None,
            cascade_depth: Some(1),
        };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["datasetId"], "d1");
        assert_eq!(v["versionNumber"], 3);
        assert_eq!(v["cascadeDepth"], 1);
        assert!(v.get("cascadeParentRunId").is_none());
    }

    #[test]
    fn notify_event_type_field() {
        let e = NotifyEvent {
            user_email: None,
            notif_type: "system".into(),
            title: "t".into(),
            body: None,
            resource_type: Some("dataset".into()),
            resource_id: Some("d".into()),
            href: Some("/datasets/d".into()),
        };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["type"], "system");
        assert_eq!(v["resourceType"], "dataset");
        assert!(v.get("userEmail").is_none());
    }

    #[test]
    fn audit_event_round_trip() {
        let e = AuditEvent {
            actor_role: "system".into(),
            actor_email: None,
            action: "pipeline.run".into(),
            resource_type: "pipeline".into(),
            resource_id: Some("p1".into()),
            resource_name: Some("P".into()),
            detail: Some("schedule s job=j".into()),
        };
        let json = serde_json::to_string(&e).unwrap();
        let back: AuditEvent = serde_json::from_str(&json).unwrap();
        assert_eq!(back.action, "pipeline.run");
        assert_eq!(back.actor_role, "system");
    }
}
