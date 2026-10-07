//! Durable NATS consumers: mf.audit → audit_entries, mf.notify →
//! notifications. Same pattern as the auth service's apiusage consumer:
//! setup retry loop, explicit ack, poison messages acked-and-skipped.

use futures::StreamExt;
use std::future::Future;
use std::pin::Pin;

use crate::state::{normalize_notify_target, AppState};

type Handle =
    dyn Fn(AppState, async_nats::Message) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send;

/// Shared consumer loop skeleton (setup retry + message pump). The inner
/// message is cloned into the handler so handler futures stay 'static.
async fn run_consumer(
    state: AppState,
    durable: &'static str,
    subject: &'static str,
    handle: Box<Handle>,
) {
    let js = mf_events::jetstream(&state.nats);
    loop {
        let consumer =
            match mf_events::ensure_consumer(&js, mf_events::STREAM_EVENTS, durable, subject, 5)
                .await
            {
                Ok(c) => c,
                Err(e) => {
                    tracing::warn!(error = %e, durable, "consumer setup failed; retrying in 5s");
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    continue;
                }
            };
        let mut messages = match consumer.messages().await {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!(error = %e, durable, "message stream failed; retrying in 5s");
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                continue;
            }
        };
        while let Some(next) = messages.next().await {
            let msg = match next {
                Ok(m) => m,
                Err(e) => {
                    tracing::warn!(error = %e, durable, "message error");
                    continue;
                }
            };
            handle(state.clone(), msg.message.clone()).await;
            let _ = msg.ack().await;
        }
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }
}

/// mf.audit → INSERT audit_entries (every service's fire-and-forget audits).
pub fn spawn_audit_consumer(state: AppState) {
    tokio::spawn(run_consumer(
        state,
        "governance-audit",
        mf_events::subject::AUDIT,
        Box::new(move |state: AppState, msg: async_nats::Message| {
            Box::pin(async move {
                match mf_events::parse_message::<mf_events::AuditEvent>(&msg) {
                    Ok(ev) => {
                        let result = sqlx::query(
                            "INSERT INTO audit_entries (id, actor_role, actor_email, action, \
                             resource_type, resource_id, resource_name, detail) \
                             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
                        )
                        .bind(mf_db::new_id())
                        .bind(&ev.actor_role)
                        .bind(&ev.actor_email)
                        .bind(&ev.action)
                        .bind(&ev.resource_type)
                        .bind(&ev.resource_id)
                        .bind(&ev.resource_name)
                        .bind(&ev.detail)
                        .execute(&state.db)
                        .await;
                        if let Err(e) = result {
                            tracing::warn!(error = %e, action = %ev.action, "audit insert failed");
                        }
                    }
                    Err(e) => {
                        // Poison message — ack to skip (DLQ noise not useful here).
                        tracing::warn!(error = %e, "audit payload parse failed; skipping");
                    }
                }
            })
        }),
    ));
}

/// mf.notify → INSERT notifications. `sim:<role>` addressees become
/// broadcasts (NULL user_email) — the mf-events targeting contract.
pub fn spawn_notify_consumer(state: AppState) {
    tokio::spawn(run_consumer(
        state,
        "governance-notify",
        mf_events::subject::NOTIFY,
        Box::new(move |state: AppState, msg: async_nats::Message| {
            Box::pin(async move {
                match mf_events::parse_message::<mf_events::NotifyEvent>(&msg) {
                    Ok(ev) => {
                        let user_email = normalize_notify_target(ev.user_email.as_deref());
                        let result = sqlx::query(
                            "INSERT INTO notifications (id, user_email, type, title, body, \
                             resource_type, resource_id, href) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
                        )
                        .bind(mf_db::new_id())
                        .bind(&user_email)
                        .bind(&ev.notif_type)
                        .bind(&ev.title)
                        .bind(&ev.body)
                        .bind(&ev.resource_type)
                        .bind(&ev.resource_id)
                        .bind(&ev.href)
                        .execute(&state.db)
                        .await;
                        if let Err(e) = result {
                            tracing::warn!(error = %e, title = %ev.title, "notification insert failed");
                        }
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "notify payload parse failed; skipping");
                    }
                }
            })
        }),
    ));
}
