//! Idempotent workspace seeder — port of src/lib/seed.ts (catalog parts).
//!
//! Creates the sample connectors, ingests the built-in sample packs into
//! datasets and seeds the P2 governed demo dataset ("Supplier Risk Scores":
//! gate ON, two error rules, clean published v1 + FAILED draft v2).
//!
//! Microservice deviations (documented in the service report):
//! - demo USERS are seeded by the mf-seed CLI / auth domain (legacy
//!   ensureSeedUsers wrote to the users table — auth owns it now), so the
//!   response omits the legacy-optional `usersEnsured` field;
//! - the demo PIPELINE ("Shipment Overview") belongs to orchestration; the
//!   catalog seed does not create it.

use mf_types::{Row, Value};
use serde_json::{json, Map};

use crate::dataset_service::{create_dataset_from_rows, CreateDatasetOptions};
use crate::publication::set_quality_gate;
use crate::state::AppState;

pub struct SeedResult {
    pub seeded: bool,
    pub datasets: Vec<String>,
}

const RISK_DATASET_NAME: &str = "Supplier Risk Scores";

fn risk_clean_rows() -> Vec<Row> {
    [
        ("Northline Foods", "EMEA", 22, "A"),
        ("Pacific Metals", "APAC", 58, "B"),
        ("Andes Textiles", "LATAM", 41, "B"),
        ("Gulf Plastics", "EMEA", 77, "C"),
        ("Baltic Grain Co", "EMEA", 15, "A"),
    ]
    .iter()
    .map(|(supplier, region, risk, tier)| {
        let mut m = Map::new();
        m.insert("supplier".into(), Value::String((*supplier).to_string()));
        m.insert("region".into(), Value::String((*region).to_string()));
        m.insert("risk_score".into(), json!(*risk));
        m.insert("tier".into(), Value::String((*tier).to_string()));
        m
    })
    .collect()
}

/// v2: same shape, but Gulf Plastics reports 140 — outside [0,100].
fn risk_dirty_rows() -> Vec<Row> {
    risk_clean_rows()
        .into_iter()
        .map(|mut r| {
            if r.get("supplier").and_then(|v| v.as_str()) == Some("Gulf Plastics") {
                r.insert("risk_score".into(), json!(140));
            }
            r
        })
        .collect()
}

async fn insert_connector(
    state: &AppState,
    name: &str,
    ctype: &str,
    config: &Value,
) -> Result<String, String> {
    let id: (String,) = sqlx::query_as(
        "INSERT INTO connectors (id, name, type, config) VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(mf_db::new_id())
    .bind(name)
    .bind(ctype)
    .bind(serde_json::to_string(config).unwrap_or_else(|_| "{}".into()))
    .fetch_one(&state.db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(id.0)
}

async fn insert_ingestion_running(state: &AppState, connector_id: &str) -> Result<String, String> {
    let id: (String,) = sqlx::query_as(
        "INSERT INTO ingestions (id, connector_id, status) VALUES ($1, $2, 'running') RETURNING id",
    )
    .bind(mf_db::new_id())
    .bind(connector_id)
    .fetch_one(&state.db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(id.0)
}

async fn finish_ingestion_success(
    state: &AppState,
    ingestion_id: &str,
    dataset_id: &str,
    rows_ingested: i32,
    message: &str,
) -> Result<(), String> {
    sqlx::query(
        "UPDATE ingestions SET dataset_id = $2, status = 'success', rows_ingested = $3, \
         message = $4, finished_at = now() WHERE id = $1",
    )
    .bind(ingestion_id)
    .bind(dataset_id)
    .bind(rows_ingested)
    .bind(message)
    .execute(&state.db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

async fn fail_ingestion(state: &AppState, ingestion_id: &str, message: &str) {
    let _ = sqlx::query(
        "UPDATE ingestions SET status = 'failed', message = $2, finished_at = now() WHERE id = $1",
    )
    .bind(ingestion_id)
    .bind(message)
    .execute(&state.db)
    .await;
}

/// Seed the governed demo dataset (idempotent by dataset name). v1 is
/// published + passes; the gate is enabled; v2 lands as a FAILED draft.
async fn seed_gated_dataset(state: &AppState) -> Result<Option<String>, String> {
    let already: Option<(String,)> =
        sqlx::query_as("SELECT id FROM datasets WHERE name = $1 LIMIT 1")
            .bind(RISK_DATASET_NAME)
            .fetch_optional(&state.db)
            .await
            .map_err(|e| e.to_string())?;
    if already.is_some() {
        return Ok(None);
    }

    let connector_id = insert_connector(
        state,
        "Sample: Supplier Risk",
        "sample",
        &json!({
            "sampleKey": "supplier-risk",
            "description": "Vendor risk scoring export (governed \u{2014} quality gate on)",
        }),
    )
    .await?;
    let ingestion_id = insert_ingestion_running(state, &connector_id).await?;

    match seed_gated_inner(state, &connector_id, &ingestion_id).await {
        Ok(name) => Ok(Some(name)),
        Err(msg) => {
            fail_ingestion(
                state,
                &ingestion_id,
                &format!("Failed to seed gated dataset: {msg}"),
            )
            .await;
            Err(msg)
        }
    }
}

async fn seed_gated_inner(
    state: &AppState,
    connector_id: &str,
    ingestion_id: &str,
) -> Result<String, String> {
    // v1 — clean, published (gate is still off for a brand-new dataset).
    let v1 = create_dataset_from_rows(
        &state.db,
        state.max_rows,
        CreateDatasetOptions {
            name: RISK_DATASET_NAME,
            description: Some(
                "Vendor risk scores with the publication gate ON \u{2014} v2 is a failing \
                 draft, so publishing it is blocked until quality passes.",
            ),
            connector_id: Some(connector_id),
            project_id: None,
            tags: vec!["sample".into(), "supply-chain".into(), "governed".into()],
            created_by: Some(ingestion_id),
            output_job_id: None,
            rows: risk_clean_rows(),
        },
    )
    .await?;
    let dataset_id = v1.dataset.id.clone();

    // Turn the gate ON: backfills publishedVersion to the clean v1 baseline.
    set_quality_gate(&state.db, &dataset_id, true)
        .await
        .map_err(|e| e.message)?;

    // Error-severity rules — the gate's teeth (one statement: shared created_at,
    // matching the legacy createMany batch in the fixture).
    sqlx::query(
        "INSERT INTO quality_rules (id, dataset_id, name, kind, column_name, config_json, severity) VALUES \
         ($1, $3, 'Supplier name present', 'not_null', 'supplier', '{}', 'error'), \
         ($2, $3, 'Risk score within 0\u{2013}100', 'range', 'risk_score', '{\"min\":0,\"max\":100}', 'error')",
    )
    .bind(mf_db::new_id())
    .bind(mf_db::new_id())
    .bind(&dataset_id)
    .execute(&state.db)
    .await
    .map_err(|e| e.to_string())?;

    // v2 — gate ON → lands as a DRAFT; the range rule fails on risk_score 140.
    let v2 = create_dataset_from_rows(
        &state.db,
        state.max_rows,
        CreateDatasetOptions {
            name: RISK_DATASET_NAME,
            description: None,
            connector_id: Some(connector_id),
            project_id: None,
            tags: vec![],
            created_by: Some(ingestion_id),
            output_job_id: None,
            rows: risk_dirty_rows(),
        },
    )
    .await?;

    // Deterministic states: v1 passes, v2 fails (also raises the one
    // 'quality_failed' bell notification that teaches the gate).
    crate::quality::evaluate_rules(state, &dataset_id, v1.version.version_number, "manual")
        .await
        .map_err(|e| e.message)?;
    crate::quality::evaluate_rules(state, &dataset_id, v2.version.version_number, "auto")
        .await
        .map_err(|e| e.message)?;

    finish_ingestion_success(
        state,
        ingestion_id,
        &dataset_id,
        v2.version.row_count,
        &format!(
            "Seeded governed dataset '{RISK_DATASET_NAME}' (v1 published \u{b7} v{} draft \
             failed quality \u{2014} gate blocks publishing)",
            v2.version.version_number
        ),
    )
    .await?;
    Ok(RISK_DATASET_NAME.to_string())
}

/// Port of `seedDatabase` (catalog-owned parts).
pub async fn seed_database(state: &AppState) -> Result<SeedResult, String> {
    let existing: Option<(String,)> = sqlx::query_as("SELECT id FROM datasets LIMIT 1")
        .fetch_optional(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    if existing.is_some() {
        // Backfill: the governed demo dataset is idempotent by name, so
        // already-seeded workspaces gain it on their next seed call too.
        let gated = seed_gated_dataset(state).await?;
        return Ok(SeedResult {
            seeded: false,
            datasets: gated.into_iter().collect(),
        });
    }

    let mut dataset_names: Vec<String> = Vec::new();
    for pack in crate::seed_data::sample_packs() {
        let connector_id = insert_connector(
            state,
            &format!("Sample: {}", pack.name),
            "sample",
            &json!({ "sampleKey": pack.key, "description": pack.description }),
        )
        .await?;
        let ingestion_id = insert_ingestion_running(state, &connector_id).await?;

        let result = create_dataset_from_rows(
            &state.db,
            state.max_rows,
            CreateDatasetOptions {
                name: pack.name,
                description: Some(pack.description),
                connector_id: Some(&connector_id),
                project_id: None,
                tags: vec!["sample".into(), "supply-chain".into()],
                created_by: Some(&ingestion_id),
                output_job_id: None,
                rows: pack.rows.clone(),
            },
        )
        .await;
        match result {
            Ok(created) => {
                let message = format!(
                    "Seeded {} rows into dataset '{}' (v{}) from sample pack '{}'",
                    created.version.row_count, pack.name, created.version.version_number, pack.key
                );
                finish_ingestion_success(
                    state,
                    &ingestion_id,
                    &created.dataset.id,
                    created.version.row_count,
                    &message,
                )
                .await?;
                dataset_names.push(pack.name.to_string());
            }
            Err(msg) => {
                fail_ingestion(
                    state,
                    &ingestion_id,
                    &format!("Failed to ingest sample pack '{}': {msg}", pack.key),
                )
                .await;
                return Err(msg);
            }
        }
    }

    // (Deviation: the legacy seed also created the demo pipeline here —
    // pipelines belong to the orchestration service now.)

    // P2 discovery: the governed dataset (gate ON, failing draft v2).
    if let Some(name) = seed_gated_dataset(state).await? {
        dataset_names.push(name);
    }

    Ok(SeedResult { seeded: true, datasets: dataset_names })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn risk_rows_match_legacy_values() {
        let clean = risk_clean_rows();
        assert_eq!(clean.len(), 5);
        assert_eq!(clean[3]["supplier"], json!("Gulf Plastics"));
        assert_eq!(clean[3]["risk_score"], json!(77));
        let dirty = risk_dirty_rows();
        assert_eq!(dirty[3]["risk_score"], json!(140));
        // every other row identical
        for i in [0, 1, 2, 4] {
            assert_eq!(clean[i], dirty[i]);
        }
        // key order preserved
        let keys: Vec<&String> = clean[0].keys().collect();
        assert_eq!(keys, vec!["supplier", "region", "risk_score", "tier"]);
    }

    #[test]
    fn connector_config_key_order_matches_fixture() {
        let config = json!({
            "sampleKey": "supplier-risk",
            "description": "Vendor risk scoring export (governed \u{2014} quality gate on)",
        });
        assert_eq!(
            serde_json::to_string(&config).unwrap(),
            "{\"sampleKey\":\"supplier-risk\",\"description\":\"Vendor risk scoring export (governed \u{2014} quality gate on)\"}"
        );
    }
}
