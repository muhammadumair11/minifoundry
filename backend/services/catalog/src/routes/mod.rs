//! Route modules + shared handler helpers.

use axum::http::HeaderMap;
use mf_auth::Actor;
use mf_web::ApiError;
use serde_json::Value;
use sqlx::PgPool;

pub mod branches;
pub mod collab;
pub mod connectors;
pub mod datasets;
pub mod ingest;
pub mod internal;
pub mod lineage;
pub mod projects;
pub mod publish;
pub mod quality_routes;
pub mod rows;
pub mod seed_route;

/// Load a dataset's (id, name) or the exact legacy 404 message.
pub async fn require_dataset(
    pool: &PgPool,
    id: &str,
) -> Result<(String, String), ApiError> {
    let row: Option<(String, String)> =
        sqlx::query_as("SELECT id, name FROM datasets WHERE id = $1")
            .bind(id)
            .fetch_optional(pool)
            .await?;
    match row {
        Some((id, name)) => Ok((id, name)),
        None => Err(ApiError::not_found(format!("Dataset '{id}' not found"))),
    }
}

/// The lowercase 404 used by the comments/watch routes.
pub async fn require_dataset_plain(
    pool: &PgPool,
    id: &str,
) -> Result<(String, Option<String>), ApiError> {
    let row: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT id, name FROM datasets WHERE id = $1")
            .bind(id)
            .fetch_optional(pool)
            .await?;
    match row {
        Some((id, name)) => Ok((id, name)),
        None => Err(ApiError::not_found("dataset not found")),
    }
}

/// Display identity for collaboration routes (legacy identityOf):
/// email → (email, email); simulator/machine → (sim:<role>, "<role> (demo)").
pub fn identity_of(actor: &Actor) -> (String, String) {
    match &actor.email {
        Some(email) => (email.clone(), email.clone()),
        None => (format!("sim:{}", actor.role), format!("{} (demo)", actor.role)),
    }
}

/// Watcher key (legacy watcherKeyOf): email ?? sim:<role>.
pub fn watcher_key_of(actor: &Actor) -> String {
    actor
        .email
        .clone()
        .unwrap_or_else(|| format!("sim:{}", actor.role))
}

/// `?version=` parsing shared by rows/export: an empty/absent param is None;
/// anything else must be an integer >= 1 (exact legacy 400 message).
pub fn parse_version_param(raw: Option<&String>) -> Result<Option<i32>, ApiError> {
    match raw {
        None => Ok(None),
        Some(s) if s.is_empty() => Ok(None),
        Some(s) => {
            let n = crate::jsval::js_parse_number(s);
            if !n.is_finite() || n.fract() != 0.0 || n < 1.0 {
                return Err(ApiError::bad_request(format!(
                    "Invalid 'version' parameter: '{s}'"
                )));
            }
            Ok(Some(n as i32))
        }
    }
}

/// Internal endpoints require the shared service token (both runtime modes);
/// pattern copied from services/auth routes/internal.rs::require_service.
pub fn require_service(
    state: &crate::state::AppState,
    headers: &HeaderMap,
) -> Result<(), ApiError> {
    let provided = headers
        .get(mf_auth::SERVICE_TOKEN_HEADER)
        .and_then(|v| v.to_str().ok());
    if state.mode.is_service_authorized(provided) {
        Ok(())
    } else {
        Err(ApiError::forbidden("service token required"))
    }
}

/// Role forwarded for internal rows masking (opt-in per INTERNAL_API.md).
pub fn internal_role_param(params: &std::collections::HashMap<String, String>) -> Option<String> {
    params
        .get("role")
        .filter(|r| !r.is_empty())
        .cloned()
}

/// Best-effort pipeline id→name map from orchestration (tolerant: any error →
/// empty map; the legacy joined its own DB, orchestration owns pipelines now).
pub async fn pipeline_names(
    state: &crate::state::AppState,
) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    match state.orchestration.get_json::<Value>("/internal/pipelines").await {
        Ok(v) => {
            if let Some(list) = v.get("pipelines").and_then(|p| p.as_array()) {
                for p in list {
                    if let (Some(id), Some(name)) = (
                        p.get("id").and_then(|x| x.as_str()),
                        p.get("name").and_then(|x| x.as_str()),
                    ) {
                        out.insert(id.to_string(), name.to_string());
                    }
                }
            }
        }
        Err(e) => tracing::debug!(error = %e, "orchestration pipelines unavailable"),
    }
    out
}

/// Best-effort run id → (trigger, status, startedAt) map from orchestration.
#[allow(clippy::type_complexity)]
pub async fn run_infos(
    state: &crate::state::AppState,
) -> std::collections::HashMap<String, (Option<String>, Option<String>, Option<String>)> {
    let mut out = std::collections::HashMap::new();
    match state
        .orchestration
        .get_json::<Value>("/internal/runs?limit=200")
        .await
    {
        Ok(v) => {
            if let Some(list) = v.get("runs").and_then(|r| r.as_array()) {
                for r in list {
                    if let Some(id) = r.get("id").and_then(|x| x.as_str()) {
                        out.insert(
                            id.to_string(),
                            (
                                r.get("trigger").and_then(|x| x.as_str()).map(String::from),
                                r.get("status").and_then(|x| x.as_str()).map(String::from),
                                r.get("startedAt").and_then(|x| x.as_str()).map(String::from),
                            ),
                        );
                    }
                }
            }
        }
        Err(e) => tracing::debug!(error = %e, "orchestration runs unavailable"),
    }
    out
}
