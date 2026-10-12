//! Shared service state + DB row models + exact legacy serializers.

use chrono::{DateTime, Utc};
use mf_auth::Actor;
use sqlx::PgPool;
use std::sync::Arc;

use crate::fanout::FanOut;

#[derive(Clone)]
pub struct Clients {
    pub catalog: FanOut,
    pub orchestration: FanOut,
    pub compute: FanOut,
    pub ontology: FanOut,
    pub auth: FanOut,
}

impl Clients {
    pub fn from_env() -> Self {
        Self {
            catalog: FanOut::from_env("catalog", "CATALOG_INTERNAL_URL", 8082),
            orchestration: FanOut::from_env("orchestration", "ORCHESTRATION_INTERNAL_URL", 8083),
            compute: FanOut::from_env("compute", "COMPUTE_INTERNAL_URL", 8084),
            ontology: FanOut::from_env("ontology", "ONTOLOGY_INTERNAL_URL", 8085),
            auth: FanOut::from_env("auth", "AUTH_INTERNAL_URL", 8081),
        }
    }
}

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub nats: async_nats::Client,
    pub mode: Arc<mf_auth::RuntimeMode>,
    /// Cookie `Secure` flag (same MF_COOKIE_SECURE knob as the auth service).
    pub cookie_secure: bool,
    pub clients: Clients,
}

// ─── DB rows ────────────────────────────────────────────────────────────

#[derive(Debug, sqlx::FromRow)]
pub struct MarkingRow {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub color: String,
    pub min_role: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, sqlx::FromRow)]
pub struct ColumnMarkingRow {
    pub dataset_id: String,
    pub column_name: String,
    pub marking_id: String,
}

#[derive(Debug, sqlx::FromRow)]
pub struct ApprovalRow {
    pub id: String,
    pub kind: String,
    pub target_id: String,
    pub version_number: Option<i32>,
    pub target_name: String,
    pub requested_by: String,
    pub note: Option<String>,
    pub status: String,
    pub decided_by: Option<String>,
    pub decided_at: Option<DateTime<Utc>>,
    pub decision_note: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, sqlx::FromRow)]
pub struct AuditRow {
    pub id: String,
    pub actor_role: String,
    pub actor_email: Option<String>,
    pub action: String,
    pub resource_type: String,
    pub resource_id: Option<String>,
    pub resource_name: Option<String>,
    pub detail: Option<String>,
    pub created_at: DateTime<Utc>,
}

/// Subset used by the curriculum auto-verifier (no id/timestamps needed).
#[derive(Debug, sqlx::FromRow)]
pub struct AuditEvidenceRow {
    pub action: String,
    pub detail: Option<String>,
    pub resource_name: Option<String>,
}

#[derive(Debug, sqlx::FromRow)]
pub struct AclRow {
    pub id: String,
    pub resource_type: String,
    pub resource_id: String,
    pub user_email: String,
    pub level: String,
    pub granted_by: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, sqlx::FromRow)]
pub struct NotificationRow {
    pub id: String,
    pub user_email: Option<String>,
    #[sqlx(rename = "type")]
    pub notif_type: String,
    pub title: String,
    pub body: Option<String>,
    pub resource_type: Option<String>,
    pub resource_id: Option<String>,
    pub href: Option<String>,
    pub read_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, sqlx::FromRow)]
pub struct CurriculumRow {
    pub step_id: String,
    pub completed_at: DateTime<Utc>,
}

// ─── Serializers (exact legacy shapes) ──────────────────────────────────

pub const MARKING_COLS: &str = "id, name, description, color, min_role, created_at";
pub const APPROVAL_COLS: &str = "id, kind, target_id, version_number, target_name, requested_by, \
     note, status, decided_by, decided_at, decision_note, created_at";
pub const AUDIT_COLS: &str = "id, actor_role, actor_email, action, resource_type, resource_id, \
     resource_name, detail, created_at";
pub const ACL_COLS: &str =
    "id, resource_type, resource_id, user_email, level, granted_by, created_at";
pub const NOTIF_COLS: &str =
    "id, user_email, type, title, body, resource_type, resource_id, href, read_at, created_at";

/// Prisma ApprovalRequest row order (approvals list/create/decide responses).
pub fn serialize_approval(a: &ApprovalRow) -> serde_json::Value {
    serde_json::json!({
        "id": a.id,
        "kind": a.kind,
        "targetId": a.target_id,
        "versionNumber": a.version_number,
        "targetName": a.target_name,
        "requestedBy": a.requested_by,
        "note": a.note,
        "status": a.status,
        "decidedBy": a.decided_by,
        "decidedAt": a.decided_at.map(|d| mf_types::ts::format(&d)),
        "decisionNote": a.decision_note,
        "createdAt": mf_types::ts::format(&a.created_at),
    })
}

/// Prisma AuditEntry row order (audit list).
pub fn serialize_audit(e: &AuditRow) -> serde_json::Value {
    serde_json::json!({
        "id": e.id,
        "actorRole": e.actor_role,
        "actorEmail": e.actor_email,
        "action": e.action,
        "resourceType": e.resource_type,
        "resourceId": e.resource_id,
        "resourceName": e.resource_name,
        "detail": e.detail,
        "createdAt": mf_types::ts::format(&e.created_at),
    })
}

/// ResourceAclInfo (acl list/post) — unknown stored levels clamp to viewer,
/// exactly like the legacy `serialize()`.
pub fn serialize_acl(a: &AclRow) -> serde_json::Value {
    let level = match a.level.as_str() {
        "viewer" | "editor" | "owner" => a.level.clone(),
        _ => "viewer".to_string(),
    };
    serde_json::json!({
        "id": a.id,
        "resourceType": a.resource_type,
        "resourceId": a.resource_id,
        "userEmail": a.user_email,
        "level": level,
        "grantedBy": a.granted_by,
        "createdAt": mf_types::ts::format(&a.created_at),
    })
}

/// NotificationInfo (notifications list).
pub fn serialize_notification(n: &NotificationRow) -> serde_json::Value {
    serde_json::json!({
        "id": n.id,
        "userEmail": n.user_email,
        "type": n.notif_type,
        "title": n.title,
        "body": n.body,
        "resourceType": n.resource_type,
        "resourceId": n.resource_id,
        "href": n.href,
        "readAt": n.read_at.map(|d| mf_types::ts::format(&d)),
        "createdAt": mf_types::ts::format(&n.created_at),
    })
}

// ─── Local audit + notification writes ──────────────────────────────────
//
// Legacy `audit()` / `createNotification()` wrote DIRECTLY to these tables
// (fire-and-forget, never throwing). Governance OWNS both tables in the new
// stack, so its own routes keep the direct write (immediately visible in
// /api/audit — the curriculum auto-verifier reads the same table). The
// mf.audit / mf.notify NATS consumers persist events from the OTHER
// services (see consumers.rs).

/// AuditOptions mirror (explicit role/email win over the actor).
pub struct AuditOptions<'a> {
    pub actor_role: Option<&'a str>,
    pub actor_email: Option<Option<&'a str>>,
    pub action: &'a str,
    pub resource_type: &'a str,
    pub resource_id: Option<&'a str>,
    pub resource_name: Option<&'a str>,
    pub detail: Option<&'a str>,
}

impl<'a> AuditOptions<'a> {
    pub fn new(action: &'a str, resource_type: &'a str) -> Self {
        Self {
            actor_role: None,
            actor_email: None,
            action,
            resource_type,
            resource_id: None,
            resource_name: None,
            detail: None,
        }
    }
    pub fn actor_role(mut self, role: &'a str) -> Self {
        self.actor_role = Some(role);
        self
    }
    pub fn resource_id(mut self, id: Option<&'a str>) -> Self {
        self.resource_id = id;
        self
    }
    pub fn resource_name(mut self, name: Option<&'a str>) -> Self {
        self.resource_name = name;
        self
    }
    pub fn detail(mut self, detail: Option<&'a str>) -> Self {
        self.detail = detail;
        self
    }
}

/// Never-throws direct audit write (legacy `audit()` swallowed failures).
pub async fn audit_local(state: &AppState, actor: &Actor, opts: AuditOptions<'_>) {
    let actor_role = opts
        .actor_role
        .map(|r| r.to_string())
        .unwrap_or_else(|| mf_web::audit_role(actor).to_string());
    let actor_email = match opts.actor_email {
        Some(e) => e.map(String::from),
        None => actor.email.clone(),
    };
    let result = sqlx::query(
        "INSERT INTO audit_entries (id, actor_role, actor_email, action, resource_type, \
         resource_id, resource_name, detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    )
    .bind(mf_db::new_id())
    .bind(actor_role)
    .bind(actor_email)
    .bind(opts.action)
    .bind(opts.resource_type)
    .bind(opts.resource_id)
    .bind(opts.resource_name)
    .bind(opts.detail)
    .execute(&state.db)
    .await;
    if let Err(e) = result {
        tracing::warn!(error = %e, "audit write failed (swallowed)");
    }
}

pub struct NotificationInput<'a> {
    pub user_email: Option<&'a str>,
    pub notif_type: &'a str,
    pub title: &'a str,
    pub body: Option<&'a str>,
    pub resource_type: Option<&'a str>,
    pub resource_id: Option<&'a str>,
    pub href: Option<&'a str>,
}

/// Never-throws direct notification write (legacy `createNotification`).
/// `sim:<role>` addressees become broadcasts (null) — the mf-events contract
/// for notification targeting in the demo simulator.
pub async fn create_notification(state: &AppState, input: NotificationInput<'_>) {
    let user_email = normalize_notify_target(input.user_email);
    let result = sqlx::query(
        "INSERT INTO notifications (id, user_email, type, title, body, resource_type, \
         resource_id, href) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    )
    .bind(mf_db::new_id())
    .bind(user_email)
    .bind(input.notif_type)
    .bind(input.title)
    .bind(input.body)
    .bind(input.resource_type)
    .bind(input.resource_id)
    .bind(input.href)
    .execute(&state.db)
    .await;
    if let Err(e) = result {
        tracing::warn!(error = %e, "notification write failed (swallowed)");
    }
}

/// Notification targeting rule: `sim:<role>` watchers are demo-simulator
/// identities with no mailbox — they become broadcasts (NULL user_email),
/// per the mf-events NotifyEvent contract.
pub fn normalize_notify_target(email: Option<&str>) -> Option<String> {
    match email {
        Some(e) if e.starts_with("sim:") => None,
        Some(e) => Some(e.to_string()),
        None => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn notification_targeting() {
        // addressed → stays addressed
        assert_eq!(
            normalize_notify_target(Some("demo-admin@example.invalid")),
            Some("demo-admin@example.invalid".to_string())
        );
        // learner identities are real addresses (curriculum actor keys)
        assert_eq!(
            normalize_notify_target(Some("learner:0e37df36-f698-4b9c-8a4e-2d5f1a9b0c3d")),
            Some("learner:0e37df36-f698-4b9c-8a4e-2d5f1a9b0c3d".to_string())
        );
        // broadcast stays broadcast
        assert_eq!(normalize_notify_target(None), None);
        // sim:<role> watchers become broadcasts (mf-events contract)
        assert_eq!(normalize_notify_target(Some("sim:admin")), None);
        assert_eq!(normalize_notify_target(Some("sim:viewer")), None);
        // "sim" without the colon is a normal address
        assert_eq!(
            normalize_notify_target(Some("sim@corp.dev")),
            Some("sim@corp.dev".to_string())
        );
    }

    #[test]
    fn serializers_match_legacy_field_names() {
        let acl = AclRow {
            id: "a1".into(),
            resource_type: "dataset".into(),
            resource_id: "d1".into(),
            user_email: "u@x.dev".into(),
            level: "captain".into(), // unknown stored level → viewer clamp
            granted_by: None,
            created_at: chrono::DateTime::UNIX_EPOCH,
        };
        let v = serialize_acl(&acl);
        assert_eq!(v["level"], "viewer");
        assert_eq!(v["userEmail"], "u@x.dev");
        assert_eq!(v["createdAt"], "1970-01-01T00:00:00.000Z");

        let approval = ApprovalRow {
            id: "ap1".into(),
            kind: "publish_dataset".into(),
            target_id: "d1".into(),
            version_number: Some(2),
            target_name: "Suppliers".into(),
            requested_by: "editor".into(),
            note: None,
            status: "pending".into(),
            decided_by: None,
            decided_at: None,
            decision_note: None,
            created_at: chrono::DateTime::UNIX_EPOCH,
        };
        let v = serialize_approval(&approval);
        for key in [
            "id",
            "kind",
            "targetId",
            "versionNumber",
            "targetName",
            "requestedBy",
            "note",
            "status",
            "decidedBy",
            "decidedAt",
            "decisionNote",
            "createdAt",
        ] {
            assert!(v.get(key).is_some(), "missing key {key}");
        }
        assert_eq!(v["versionNumber"], 2);
        assert_eq!(v["decidedAt"], Value::Null);
    }
}
