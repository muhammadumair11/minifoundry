//! Route modules for the ontology service.

pub mod actions;
pub mod applications;
pub mod dashboards;
pub mod internal;
pub mod links;
pub mod objects;
pub mod ontology;
pub mod seed_demo;
pub mod views;

/// Effective actor role passed to catalog rows calls (`role=` masking param).
/// The gateway resolves demo/shared-mode role semantics into x-mf-actor-role,
/// so the header value IS the legacy getRole(req) result.
pub fn effective_role(actor: &mf_auth::Actor) -> String {
    actor.role.clone()
}
