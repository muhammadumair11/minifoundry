//! /api/connectors[...] — connector CRUD, dry-run test-config and REAL
//! rest_url ingestion (ports connectors/route.ts, connectors/[id]/route.ts,
//! connectors/[id]/ingest/route.ts, connectors/test-config/route.ts).

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::Response;
use mf_web::{actor_from_headers, json_created, json_ok, require_role, ApiError, ApiResult};
use serde_json::{json, Map, Value};
use std::collections::HashMap;

use crate::audit::{audit, AuditOptions};
use crate::dataset_service::{create_dataset_from_rows, CreateDatasetOptions};
use crate::real_ingest::{fetch_connector_rows, RealIngestConfig};
use crate::rows::parse_json_text;
use crate::state::{
    serialize_connector, serialize_ingestion_full, AppState, ConnectorRow, IngestionRow,
    CONNECTOR_COLS, INGESTION_COLS,
};
use crate::validate::{
    as_object, opt_object, opt_str, parse_body, parse_body_or_empty, req_enum, req_str_min1_custom,
};
use crate::version_events::{emit_version_created, VersionCreatedInput};

const CONNECTOR_TYPES: [&str; 4] = ["csv_upload", "json_upload", "rest_url", "sample"];

/// GET /api/connectors — createdAt asc, each with its most recent ingestion.
pub async fn list_connectors(State(state): State<AppState>) -> ApiResult<Response> {
    let connectors: Vec<ConnectorRow> = sqlx::query_as(&format!(
        "SELECT {CONNECTOR_COLS} FROM connectors ORDER BY created_at ASC, id ASC"
    ))
    .fetch_all(&state.db)
    .await?;
    let ingestions: Vec<IngestionRow> = sqlx::query_as(&format!(
        "SELECT {INGESTION_COLS} FROM ingestions WHERE connector_id IS NOT NULL \
         ORDER BY started_at DESC, id DESC"
    ))
    .fetch_all(&state.db)
    .await?;
    // First (most recent) ingestion per connector.
    let mut last_by_connector: HashMap<String, &IngestionRow> = HashMap::new();
    for ing in &ingestions {
        if let Some(cid) = &ing.connector_id {
            last_by_connector.entry(cid.clone()).or_insert(ing);
        }
    }
    let out: Vec<Value> = connectors
        .iter()
        .map(|c| serialize_connector(c, last_by_connector.get(&c.id).copied()))
        .collect();
    Ok(json_ok(json!({ "connectors": out })))
}

/// POST /api/connectors — editor+ (201 { connector }).
pub async fn create_connector(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;

    let v = parse_body(&body)?;
    let m = as_object(v)?;
    let name = req_str_min1_custom(&m, "name", "name is required")?;
    let ctype = req_enum(&m, "type", &CONNECTOR_TYPES)?;
    let config = opt_object(&m, "config")?.unwrap_or_default();

    let connector: ConnectorRow = sqlx::query_as(&format!(
        "INSERT INTO connectors (id, name, type, config) VALUES ($1, $2, $3, $4) \
         RETURNING {CONNECTOR_COLS}"
    ))
    .bind(mf_db::new_id())
    .bind(name)
    .bind(ctype)
    .bind(serde_json::to_string(&Value::Object(config)).unwrap_or_else(|_| "{}".into()))
    .fetch_one(&state.db)
    .await?;

    audit(
        &state,
        &actor,
        AuditOptions::new("connector.create", "connector")
            .resource_id(Some(&connector.id))
            .resource_name(Some(&connector.name)),
    )
    .await;

    Ok(json_created(
        json!({ "connector": serialize_connector(&connector, None) }),
    ))
}

/// PATCH /api/connectors/{id} — editor+; shallow config merge keeps unknown
/// keys (legacy behavior on purpose).
pub async fn update_connector(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;

    let existing: Option<ConnectorRow> = sqlx::query_as(&format!(
        "SELECT {CONNECTOR_COLS} FROM connectors WHERE id = $1"
    ))
    .bind(&id)
    .fetch_optional(&state.db)
    .await?;
    let Some(existing) = existing else {
        return Err(ApiError::not_found(format!("Connector '{id}' not found")));
    };

    let v = parse_body(&body)?;
    let m = as_object(v)?;
    let name = match m.get("name") {
        None => None,
        Some(_) => Some(req_str_min1_custom(&m, "name", "")?.to_string()),
    };
    let config_patch = opt_object(&m, "config")?;

    let next_config = config_patch.map(|patch| {
        let mut merged = parse_json_text::<Value>(&existing.config, json!({}));
        if !merged.is_object() {
            merged = json!({});
        }
        if let Value::Object(base) = &mut merged {
            for (k, val) in patch {
                base.insert(k, val);
            }
        }
        serde_json::to_string(&merged).unwrap_or_else(|_| "{}".into())
    });

    let connector: ConnectorRow = sqlx::query_as(&format!(
        "UPDATE connectors SET \
         name = COALESCE($2, name), \
         config = COALESCE($3, config), \
         updated_at = now() \
         WHERE id = $1 RETURNING {CONNECTOR_COLS}"
    ))
    .bind(&id)
    .bind(name.clone())
    .bind(next_config)
    .fetch_one(&state.db)
    .await?;

    let mut updated_fields: Vec<&str> = Vec::new();
    if name.is_some() {
        updated_fields.push("name");
    }
    if config_patch_was_present(&m) {
        updated_fields.push("config");
    }
    audit(
        &state,
        &actor,
        AuditOptions::new("connector.update", "connector")
            .resource_id(Some(&connector.id))
            .resource_name(Some(&connector.name))
            .detail(Some(&format!("updated {}", updated_fields.join(", ")))),
    )
    .await;

    Ok(json_ok(
        json!({ "connector": serialize_connector(&connector, None) }),
    ))
}

fn config_patch_was_present(m: &Map<String, Value>) -> bool {
    m.get("config").map(|v| !v.is_null()).unwrap_or(false)
}

/// DELETE /api/connectors/{id} — editor+; ingestion rows keep a NULL
/// connectorId (FK ON DELETE SET NULL, like the legacy Prisma relation).
pub async fn delete_connector(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;

    let existing: Option<(String, String)> =
        sqlx::query_as("SELECT id, name FROM connectors WHERE id = $1")
            .bind(&id)
            .fetch_optional(&state.db)
            .await?;
    let Some((existing_id, existing_name)) = existing else {
        return Err(ApiError::not_found(format!("Connector '{id}' not found")));
    };

    sqlx::query("DELETE FROM connectors WHERE id = $1")
        .bind(&id)
        .execute(&state.db)
        .await?;

    audit(
        &state,
        &actor,
        AuditOptions::new("connector.delete", "connector")
            .resource_id(Some(&existing_id))
            .resource_name(Some(&existing_name)),
    )
    .await;

    Ok(json_ok(
        json!({ "ok": true, "deleted": existing_id, "name": existing_name }),
    ))
}

/// POST /api/connectors/test-config — editor+; dry-run fetch WITHOUT a saved
/// connector. Always answers 200 (ok:false + error for user-caused failures).
pub async fn test_config(
    State(_state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;

    let v = match parse_body(&body) {
        Ok(v) => v,
        Err(_) => {
            return Ok(json_ok(
                json!({ "ok": false, "error": "Request body must be valid JSON" }),
            ))
        }
    };
    let m = match as_object(v) {
        Ok(m) => m,
        Err(e) => return Ok(json_ok(json!({ "ok": false, "error": e.message }))),
    };
    let url = match req_str_min1_custom(&m, "url", "url is required") {
        Ok(u) => u.to_string(),
        Err(e) => return Ok(json_ok(json!({ "ok": false, "error": e.message }))),
    };
    let format = match m.get("format") {
        None | Some(Value::Null) => "json".to_string(),
        Some(_) => match req_enum(&m, "format", &["json", "csv"]) {
            Ok(f) => f.to_string(),
            Err(e) => return Ok(json_ok(json!({ "ok": false, "error": e.message }))),
        },
    };
    let data_path = match opt_str(&m, "dataPath") {
        Ok(d) => d.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
        Err(e) => return Ok(json_ok(json!({ "ok": false, "error": e.message }))),
    };

    let started = std::time::Instant::now();
    let result = fetch_connector_rows(&RealIngestConfig {
        url,
        format,
        data_path,
    })
    .await;
    let duration_ms = started.elapsed().as_millis() as i64;
    match result {
        Ok(r) => Ok(json_ok(json!({
            "ok": true,
            "rowCount": r.row_count,
            "sampleColumns": r.columns,
            "durationMs": duration_ms,
        }))),
        Err(msg) => Ok(json_ok(json!({
            "ok": false,
            "error": msg,
            "durationMs": duration_ms,
        }))),
    }
}

/// POST /api/connectors/{id}/ingest — editor+; REAL rest_url ingestion.
/// Fetch/parse failures are user-caused → 400 (legacy mapping).
pub async fn ingest_connector(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;

    let connector: Option<ConnectorRow> = sqlx::query_as(&format!(
        "SELECT {CONNECTOR_COLS} FROM connectors WHERE id = $1"
    ))
    .bind(&id)
    .fetch_optional(&state.db)
    .await?;
    let Some(connector) = connector else {
        return Err(ApiError::not_found(format!("Connector '{id}' not found")));
    };

    // Body is optional — { datasetName } defaults to the connector's name.
    let mut dataset_name = connector.name.clone();
    let v = parse_body_or_empty(&body)?;
    let m = as_object(v)?;
    if m.get("datasetName").is_some() && !m["datasetName"].is_null() {
        dataset_name = req_str_min1_custom(&m, "datasetName", "")?.to_string();
    }

    let config = parse_json_text::<Value>(&connector.config, json!({}));
    let ingest_config = if connector.ctype == "rest_url" {
        let url = config
            .get("url")
            .and_then(|u| u.as_str())
            .unwrap_or("")
            .to_string();
        if url.is_empty() {
            return Err(ApiError::bad_request(
                "This connector has no URL configured \u{2014} edit it first",
            ));
        }
        let format = if config.get("format").and_then(|f| f.as_str()) == Some("csv") {
            "csv"
        } else {
            "json"
        };
        let data_path = config
            .get("dataPath")
            .and_then(|d| d.as_str())
            .map(|d| d.trim())
            .filter(|d| !d.is_empty())
            .map(|d| d.to_string());
        RealIngestConfig {
            url,
            format: format.to_string(),
            data_path,
        }
    } else {
        return Err(ApiError::bad_request(format!(
            "Real ingestion is only available for rest_url connectors (this one is '{}')",
            connector.ctype
        )));
    };

    let ingestion_id = mf_db::new_id();
    sqlx::query("INSERT INTO ingestions (id, connector_id, status) VALUES ($1, $2, 'running')")
        .bind(&ingestion_id)
        .bind(&connector.id)
        .execute(&state.db)
        .await?;

    let outcome = run_connector_ingest(
        &state,
        &actor,
        &connector,
        &dataset_name,
        &ingestion_id,
        &ingest_config,
    )
    .await;
    match outcome {
        Ok(payload) => Ok(json_ok(payload)),
        Err(msg) => {
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
                    .resource_name(Some(&dataset_name))
                    .detail(Some(&msg)),
            )
            .await;
            // Fetch/parse failures are user-caused (bad URL, bad payload) → 400.
            Err(ApiError::bad_request(msg))
        }
    }
}

async fn run_connector_ingest(
    state: &AppState,
    actor: &mf_auth::Actor,
    connector: &ConnectorRow,
    dataset_name: &str,
    ingestion_id: &str,
    ingest_config: &RealIngestConfig,
) -> Result<Value, String> {
    let fetched = fetch_connector_rows(ingest_config).await?;
    let source_desc = format!("connector '{}' ({})", connector.name, fetched.format);

    let created = create_dataset_from_rows(
        &state.db,
        state.max_rows,
        CreateDatasetOptions {
            name: dataset_name,
            description: None,
            connector_id: Some(&connector.id),
            project_id: None,
            tags: vec![],
            created_by: Some(ingestion_id),
            output_job_id: None,
            rows: fetched.rows,
        },
    )
    .await?;

    let row_count = created.row_count;
    let schema_len = created.schema.len();
    let version_number = created.version.version_number;
    let message = format!(
        "Ingested {row_count} rows from {source_desc} into dataset '{}' (v{version_number}, {schema_len} columns)",
        created.dataset.name
    );

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
    .map_err(|e| e.to_string())?;

    // R14: announce the new version (quality auto-eval + triggers + watchers).
    emit_version_created(
        state,
        VersionCreatedInput {
            dataset_id: created.dataset.id.clone(),
            version_number,
            source: Some(format!("connector:{}", connector.name)),
            cascade_parent_run_id: None,
            cascade_depth: None,
            consumable: !created.dataset.quality_gate,
        },
    )
    .await;

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
