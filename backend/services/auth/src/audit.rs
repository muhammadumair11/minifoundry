//! Fire-and-forget audit emission (port of `audit()` in governance.ts).
//! Audit rows are owned by the governance service; auth publishes
//! `mf.audit` events that governance consumes and persists.

use crate::state::AppState;
use mf_auth::Actor;
use mf_events::AuditEvent;

/// Mirrors the legacy AuditOptions: explicit role/email win over the actor.
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
    pub fn actor_role(mut self, role: &'a str) -> Self { self.actor_role = Some(role); self }
    pub fn actor_email(mut self, email: Option<&'a str>) -> Self { self.actor_email = Some(email); self }
    pub fn resource_id(mut self, id: Option<&'a str>) -> Self { self.resource_id = id; self }
    pub fn resource_name(mut self, name: Option<&'a str>) -> Self { self.resource_name = name; self }
    pub fn detail(mut self, detail: Option<&'a str>) -> Self { self.detail = detail; self }
}

/// Never-throws audit emit (legacy `audit()` swallowed write failures).
pub async fn audit(state: &AppState, actor: &Actor, opts: AuditOptions<'_>) {
    let actor_role = opts
        .actor_role
        .map(|r| r.to_string())
        .unwrap_or_else(|| mf_web::audit_role(actor).to_string());
    let actor_email = match opts.actor_email {
        Some(e) => e.map(String::from),
        None => actor.email.clone(),
    };
    let event = AuditEvent {
        actor_role,
        actor_email,
        action: opts.action.to_string(),
        resource_type: opts.resource_type.to_string(),
        resource_id: opts.resource_id.map(String::from),
        resource_name: opts.resource_name.map(String::from),
        detail: opts.detail.map(String::from),
    };
    mf_events::publish_json_quiet(&state.nats, mf_events::subject::AUDIT, &event).await;
}
