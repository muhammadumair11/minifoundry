//! /api/ingest + /api/ingestions — sample/raw/url ingestion (ports
//! ingest/route.ts and ingestions/route.ts).

use axum::body::Bytes;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::Response;
use mf_web::{actor_from_headers, json_ok, require_role, ApiError, ApiResult};
use serde_json::{json, Value};
use std::collections::HashMap;

use crate::audit::{audit, AuditOptions};
use crate::dataset_service::{create_dataset_from_rows, CreateDatasetOptions};
use crate::parsers::{fetch_rows_from_url, parse_raw_text};
use crate::seed_data::{sample_pack_keys, sample_packs};
use crate::state::{
    serialize_ingestion_full, serialize_ingestion_list_item, AppState, ConnectorRow, IngestionRow,
    CONNECTOR_COLS, INGESTION_COLS,
};
use crate::validate::{as_object, opt_str, parse_body, req_enum, req_str_min1_custom};
use crate::version_events::{emit_version_created, VersionCreatedInput};

const INGEST_TYPES: [&str; 3] = ["sample", "raw", "url"];

/// POST /api/ingest — editor+; ingest from a sample pack, raw CSV/JSON text
/// or a URL. IngestInput-style failures → 400; everything else → 500 with the
/// exact legacy message.
pub async fn post_ingest(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;

    let v = parse_body(&body)?;
    let m = as_object(v)?;
    let itype = req_enum(&m, "type", &INGEST_TYPES)?;
    let dataset_name = req_str_min1_custom(&m, "datasetName", "datasetName is required")?;
    let connector_id = opt_str(&m, "connectorId")?;
    let raw = opt_str(&m, "raw")?;
    let url = match m.get("url") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => {
            if s.is_empty() {
                return Err(ApiError::bad_request(
                    "url: Too small: expected string to have >=1 chars",
                ));
            }
            Some(s.clone())
        }
        Some(other) => {
            return Err(ApiError::bad_request(format!(
                "url: Invalid input: expected string, received {}",
                crate::validate::kind_of(other)
            )))
        }
    };
    let sample_key = opt_str(&m, "sampleKey")?;

    if let Some(cid) = connector_id {
        let connector: Option<(String,)> =
            sqlx::query_as("SELECT id FROM connectors WHERE id = $1")
                .bind(cid)
                .fetch_optional(&state.db)
                .await?;
        if connector.is_none() {
            return Err(ApiError::bad_request(format!("Connector '{cid}' not found")));
        }
    }

    let ingestion_id = mf_db::new_id();
    sqlx::query("INSERT INTO ingestions (id, connector_id, status) VALUES ($1, $2, 'running')")
        .bind(&ingestion_id)
        .bind(connector_id)
        .execute(&state.db)
        .await?;

    let outcome = run_ingest(
        &state,
        &actor,
        itype,
        dataset_name,
        connector_id,
        raw,
        url.as_deref(),
        sample_key,
        &ingestion_id,
    )
    .await;
    match outcome {
        Ok(payload) => Ok(json_ok(payload)),
        Err((msg, input_error)) => {
            let _ = sqlx::query(
                "UPDATE ingestions SET status = 'failed', message = $2, finished_at = now() WHERE id = $1",
            )
            .bind(&ingestion_id)
            .bind(format!("Ingestion failed: {msg}"))
            .execute(&state.db)
            .await;
            audit(
                &state,
                &actor,
                AuditOptions::new("ingest.failed", "dataset")
                    .resource_name(Some(dataset_name))
                    .detail(Some(&msg)),
            )
            .await;
            if input_error {
                Err(ApiError::bad_request(msg))
            } else {
                Err(ApiError::internal(msg))
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_ingest(
    state: &AppState,
    actor: &mf_auth::Actor,
    itype: &str,
    dataset_name: &str,
    connector_id: Option<&str>,
    raw: Option<&str>,
    url: Option<&str>,
    sample_key: Option<&str>,
    ingestion_id: &str,
) -> Result<Value, (String, bool)> {
    let (raw_rows, source_desc): (Vec<mf_types::Row>, String) = match itype {
        "sample" => {
            let Some(key) = sample_key.filter(|s| !s.is_empty()) else {
                return Err((
                    "type \"sample\" requires a sampleKey".to_string(),
                    true,
                ));
            };
            let packs = sample_packs();
            let Some(pack) = packs.iter().find(|p| p.key == key) else {
                return Err((
                    format!(
                        "Unknown sampleKey '{key}' (available: {})",
                        sample_pack_keys().join(", ")
                    ),
                    true,
                ));
            };
            (pack.rows.clone(), format!("sample pack '{key}'"))
        }
        "raw" => {
            let Some(raw) = raw.filter(|s| !s.is_empty()) else {
                return Err((
                    "type \"raw\" requires a raw payload (CSV or JSON text)".to_string(),
                    true,
                ));
            };
            let parsed = parse_raw_text(raw).map_err(|e| (e, false))?;
            (parsed.rows, format!("raw {}", parsed.format))
        }
        _ => {
            let Some(url) = url.filter(|s| !s.is_empty()) else {
                return Err(("type \"url\" requires a url".to_string(), true));
            };
            let fetched = fetch_rows_from_url(url).await.map_err(|e| (e, false))?;
            (fetched.rows, format!("url ({})", fetched.format))
        }
    };

    let created = create_dataset_from_rows(
        &state.db,
        state.max_rows,
        CreateDatasetOptions {
            name: dataset_name,
            description: None,
            connector_id,
            project_id: None,
            tags: vec![],
            created_by: Some(ingestion_id),
            output_job_id: None,
            rows: raw_rows,
        },
    )
    .await
    .map_err(|e| (e, false))?;

    let row_count = created.row_count;
    let schema_len = created.schema.len();
    let version_number = created.version.version_number;
    let message = format!(
        "Ingested {row_count} rows from {source_desc} into dataset '{}' (v{version_number}, {schema_len} columns)",
        created.dataset.name
    );

    // R14/P2: emit for EVERY ingest — the quality auto-evaluator listens too.
    let source = match connector_id {
        Some(cid) => {
            let connector: Option<ConnectorRow> = sqlx::query_as(&format!(
                "SELECT {CONNECTOR_COLS} FROM connectors WHERE id = $1"
            ))
            .bind(cid)
            .fetch_optional(&state.db)
            .await
            .map_err(|e| (e.to_string(), false))?;
            format!(
                "connector:{}",
                connector.map(|c| c.name).unwrap_or_else(|| cid.to_string())
            )
        }
        None => "ingest".to_string(),
    };
    emit_version_created(
        state,
        VersionCreatedInput {
            dataset_id: created.dataset.id.clone(),
            version_number,
            source: Some(source),
            cascade_parent_run_id: None,
            cascade_depth: None,
            consumable: !created.dataset.quality_gate,
        },
    )
    .await;

    let finished: IngestionRow = sqlx::query_as(&format!(
        "UPDATE ingestions SET dataset_id = $2, status = 'success', rows_ingested = $3, \
          message = $4, finished_at = now() WHERE id = $1 RETURNING {INGESTION_COLS}"
    ))
    .bind(ingestion_id)
    .bind(&created.dataset.id)
    .bind(row_count as i32)
    .bind(&message)
    .fetch_one(&state.db)
    .await
    .map_err(|e| (e.to_string(), false))?;

    audit(
        state,
        actor,
        AuditOptions::new("ingest.complete", "dataset")
            .resource_id(Some(&created.dataset.id))
            .resource_name(Some(&created.dataset.name))
            .detail(Some(&format!(
                "ingested {row_count} rows from {source_desc} (v{version_number}, {schema_len} columns)"
            ))),
    )
    .await;

    Ok(json!({
        "ingestion": serialize_ingestion_full(&finished),
        "dataset": {
            "id": created.dataset.id,
            "name": created.dataset.name,
            "description": created.dataset.description,
            "projectId": created.dataset.project_id,
            "sourceConnectorId": created.dataset.source_connector_id,
            "tags": created.dataset.tags.0,
            "updatedAt": crate::state::ts(&created.dataset.updated_at),
            "version": {
                "id": created.version.id,
                "versionNumber": created.version.version_number,
                "rowCount": created.version.row_count,
                "columnCount": schema_len,
                "schema": created.schema,
            },
        },
    }))
}

/// GET /api/ingestions — latest 50 with connector/dataset names (any role).
pub async fn list_ingestions(State(state): State<AppState>) -> ApiResult<Response> {
    #[derive(sqlx::FromRow)]
    struct JoinRow {
        id: String,
        connector_id: Option<String>,
        dataset_id: Option<String>,
        status: String,
        message: Option<String>,
        rows_ingested: i32,
        started_at: chrono::DateTime<chrono::Utc>,
        finished_at: Option<chrono::DateTime<chrono::Utc>>,
        connector_name: Option<String>,
    }

    let ingestions: Vec<JoinRow> = sqlx::query_as(
        "SELECT i.id, i.connector_id, i.dataset_id, i.status, i.message, i.rows_ingested, \
                i.started_at, i.finished_at, c.name AS connector_name \
         FROM ingestions i LEFT JOIN connectors c ON c.id = i.connector_id \
         ORDER BY i.started_at DESC, i.id DESC LIMIT 50",
    )
    .fetch_all(&state.db)
    .await?;

    let datasets: Vec<(String, String)> =
        sqlx::query_as("SELECT id, name FROM datasets").fetch_all(&state.db).await?;
    let name_by_id: HashMap<String, String> = datasets.into_iter().collect();

    let out: Vec<Value> = ingestions
        .iter()
        .map(|j| {
            let ing = IngestionRow {
                id: j.id.clone(),
                connector_id: j.connector_id.clone(),
                dataset_id: j.dataset_id.clone(),
                status: j.status.clone(),
                message: j.message.clone(),
                rows_ingested: j.rows_ingested,
                started_at: j.started_at,
                finished_at: j.finished_at,
            };
            serialize_ingestion_list_item(
                &ing,
                j.connector_name.as_deref(),
                j.dataset_id
                    .as_ref()
                    .and_then(|id| name_by_id.get(id))
                    .map(|s| s.as_str()),
            )
        })
        .collect();
    Ok(json_ok(json!({ "ingestions": out })))
}
