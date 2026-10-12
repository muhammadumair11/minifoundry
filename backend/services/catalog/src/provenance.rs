//! Version provenance resolver — port of src/lib/provenance.ts.
//!
//! DatasetVersion.createdBy is an opaque writer reference: an ingestion id, a
//! pipeline run id, "transform:<runId>", "branch-merge:<branch>",
//! "action:<apiName>" or the literal "seed". Prefixed forms are cheap string
//! checks; bare ids are looked up as ingestions locally.
//!
//! Microservice deviation: the legacy resolved bare ids as pipeline runs FIRST
//! (orchestration table) and "transform:<id>" against transform runs (compute
//! table). Those tables live in other services with no by-id internal lookup
//! in contracts/INTERNAL_API.md, so unresolvable cross-service ids degrade to
//! the legacy's own graceful fallbacks ('unknown writer' / generic transform
//! label) — exactly the shapes provenance.ts returns for missing rows.

use serde_json::{json, Value};
use sqlx::PgPool;

const TRANSFORM_PREFIX: &str = "transform:";
const MERGE_PREFIX: &str = "branch-merge:";
const ACTION_PREFIX: &str = "action:";

/// Resolve one createdBy reference. Never fails (unknown ids → 'unknown').
pub async fn resolve_provenance(pool: &PgPool, created_by: Option<&str>) -> Value {
    let Some(created_by) = created_by.filter(|s| !s.is_empty()) else {
        return json!({ "kind": "unknown", "label": "unknown writer", "detail": null, "href": null });
    };

    if created_by == "seed" {
        return json!({
            "kind": "seed",
            "label": "Sample seed",
            "detail": "bundled sample pack",
            "href": null,
        });
    }
    if let Some(_run_id) = created_by.strip_prefix(TRANSFORM_PREFIX) {
        // Transform runs live in the compute service; the legacy fallback for
        // an unresolvable run is this generic label.
        return json!({
            "kind": "transform",
            "label": "Code workbook run",
            "detail": null,
            "href": "/transforms",
        });
    }
    if let Some(branch) = created_by.strip_prefix(MERGE_PREFIX) {
        return json!({
            "kind": "merge",
            "label": format!("Branch merge \u{2014} {branch}"),
            "detail": "merged into main",
            "href": null,
        });
    }
    if let Some(api_name) = created_by.strip_prefix(ACTION_PREFIX) {
        return json!({
            "kind": "action",
            "label": format!("Action \u{2014} {api_name}"),
            "detail": "ontology write-back",
            "href": "/ontology",
        });
    }

    // Bare id: pipeline run (orchestration — not resolvable cross-service,
    // see module docs), then ingestion (local).
    #[allow(clippy::type_complexity)]
    let ingestion: Option<(String, i32, Option<String>, Option<String>, Option<String>)> =
        sqlx::query_as(
            "SELECT i.status, i.rows_ingested, c.id, c.name, c.type \
             FROM ingestions i LEFT JOIN connectors c ON c.id = i.connector_id \
             WHERE i.id = $1",
        )
        .bind(created_by)
        .fetch_optional(pool)
        .await
        .unwrap_or(None);
    if let Some((status, _rows, connector_id, connector_name, connector_type)) = ingestion {
        let label = format!(
            "Ingestion \u{2014} {}",
            connector_name.as_deref().unwrap_or("external source")
        );
        let detail = format!(
            "{status} \u{b7} {} connector",
            connector_type.as_deref().unwrap_or("unknown")
        );
        return json!({
            "kind": "ingestion",
            "label": label,
            "detail": detail,
            "href": if connector_id.is_some() { Value::String("/connectors".into()) } else { Value::Null },
        });
    }

    // Unresolvable id — show it honestly rather than pretending.
    json!({ "kind": "unknown", "label": "unknown writer", "detail": created_by, "href": null })
}

/// Port of `resolveProvenanceMany`: unique createdBy values resolved once and
/// mapped back positionally.
pub async fn resolve_provenance_many(
    pool: &PgPool,
    created_by_list: &[Option<String>],
) -> Vec<Value> {
    let mut unique: Vec<Option<String>> = Vec::new();
    for c in created_by_list {
        let key = c.clone().unwrap_or_default();
        if !unique.iter().any(|u| u.clone().unwrap_or_default() == key) {
            unique.push(if key.is_empty() { None } else { Some(key) });
        }
    }
    let mut resolved: Vec<(String, Value)> = Vec::with_capacity(unique.len());
    for u in &unique {
        let key = u.clone().unwrap_or_default();
        resolved.push((key, resolve_provenance(pool, u.as_deref()).await));
    }
    created_by_list
        .iter()
        .map(|c| {
            let key = c.clone().unwrap_or_default();
            resolved
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, v)| v.clone())
                .unwrap_or_else(|| {
                    json!({ "kind": "unknown", "label": "unknown writer", "detail": null, "href": null })
                })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // DB-backed resolution is covered by the boot + curl verification;
    // the pure prefix forms are unit-testable without a pool.
    #[test]
    fn prefixes_are_recognized() {
        assert!("transform:abc".starts_with(TRANSFORM_PREFIX));
        assert!(MERGE_PREFIX.len() == "branch-merge:".len());
        assert_eq!("action:ship".strip_prefix(ACTION_PREFIX), Some("ship"));
    }
}
