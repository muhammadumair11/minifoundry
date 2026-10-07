//! Catalog internal-API client helpers (backend/contracts/INTERNAL_API.md).
//!
//! Compute reads workbook inputs and writes workbook output through the
//! catalog's `/internal/datasets/*` endpoints — the single version-write door
//! (`POST /internal/datasets/{id}/versions`, idempotent via outputJobId).
//!
//! Masking: NO `role` query param is ever passed — workbook inputs and run
//! previews read RAW rows, exact legacy parity (transform-engine.ts read
//! version.dataJson directly and never applied markings).
//!
//! Response shapes are parsed defensively (object-with-key or bare value) so
//! compute tolerates catalog being mid-integration; 404 → None.

use crate::routes::encode_segment;
use mf_internal::{InternalError, ServiceClient};
use mf_types::{Row, SchemaColumn, Value};

/// Extract an id/name-bearing object from either `{ "dataset": {...} }`
/// (detail/list envelope) or a bare summary object.
fn dataset_obj(v: &Value) -> Option<&Value> {
    if let Some(inner) = v.get("dataset") {
        if inner.is_object() {
            return Some(inner);
        }
    }
    if v.get("id").is_some() {
        return Some(v);
    }
    None
}

/// GET /internal/datasets/{id} — dataset detail. 404 → Ok(None).
pub async fn get_dataset(
    catalog: &ServiceClient,
    id: &str,
) -> Result<Option<Value>, InternalError> {
    let v: Value = match catalog
        .get_json(&format!("/internal/datasets/{}", encode_segment(id)))
        .await
    {
        Ok(v) => v,
        Err(InternalError::Api { status: 404, .. }) => return Ok(None),
        Err(e) => return Err(e),
    };
    Ok(dataset_obj(&v).cloned())
}

/// GET /internal/datasets/by-name/{name} — output-dataset lookup. 404 → None.
pub async fn get_dataset_by_name(
    catalog: &ServiceClient,
    name: &str,
) -> Result<Option<Value>, InternalError> {
    let v: Value = match catalog
        .get_json(&format!(
            "/internal/datasets/by-name/{}",
            encode_segment(name)
        ))
        .await
    {
        Ok(v) => v,
        Err(InternalError::Api { status: 404, .. }) => return Ok(None),
        Err(e) => return Err(e),
    };
    Ok(dataset_obj(&v).cloned())
}

/// Ensure a dataset with `name` exists (legacy `createDatasetFromRows`'s
/// findFirst-or-create); returns its id. Creation carries no description /
/// tags / project — same as the legacy transform output path.
pub async fn ensure_dataset_by_name(
    catalog: &ServiceClient,
    name: &str,
) -> Result<String, InternalError> {
    if let Some(ds) = get_dataset_by_name(catalog, name).await? {
        if let Some(id) = ds.get("id").and_then(|v| v.as_str()) {
            return Ok(id.to_string());
        }
    }
    let created: Value = catalog
        .post_json("/internal/datasets", &serde_json::json!({ "name": name }))
        .await?;
    dataset_obj(&created)
        .and_then(|d| d.get("id"))
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| InternalError::Transport(
            "catalog create-dataset response has no id".into(),
        ))
}

/// GET /internal/datasets/{id}/versions/{n} — version meta (`n` = "head" or a
/// version number; head resolves the consumer version, gate-aware).
/// 404 → Ok(None).
pub async fn get_version(
    catalog: &ServiceClient,
    id: &str,
    n: &str,
) -> Result<Option<Value>, InternalError> {
    let v: Value = match catalog
        .get_json(&format!(
            "/internal/datasets/{}/versions/{}",
            encode_segment(id),
            encode_segment(n)
        ))
        .await
    {
        Ok(v) => v,
        Err(InternalError::Api { status: 404, .. }) => return Ok(None),
        Err(e) => return Err(e),
    };
    // Tolerate a `{ version: {...} }` envelope as well as the bare meta.
    if let Some(inner) = v.get("version") {
        if inner.is_object() {
            return Ok(Some(inner.clone()));
        }
    }
    Ok(Some(v))
}

/// Pull a rows array out of either `{ "rows": [...] , ... }` or a bare array.
fn rows_of(v: &Value) -> Vec<Row> {
    let arr = match v {
        Value::Array(a) => a.clone(),
        _ => match v.get("rows") {
            Some(Value::Array(a)) => a.clone(),
            _ => Vec::new(),
        },
    };
    arr.into_iter()
        .filter_map(|r| match r {
            Value::Object(m) => Some(m),
            _ => None,
        })
        .collect()
}

/// GET /internal/datasets/{id}/versions/{n}/rows/all — full RAW rows
/// (engine/compute use; no role param → no masking, legacy parity).
pub async fn get_rows_all(
    catalog: &ServiceClient,
    id: &str,
    n: &str,
) -> Result<Vec<Row>, InternalError> {
    let v: Value = catalog
        .get_json(&format!(
            "/internal/datasets/{}/versions/{}/rows/all",
            encode_segment(id),
            encode_segment(n)
        ))
        .await?;
    Ok(rows_of(&v))
}

/// GET /internal/datasets/{id}/versions/{n}/rows?offset=&limit= — paged RAW
/// rows (run-output preview).
pub async fn get_rows_paged(
    catalog: &ServiceClient,
    id: &str,
    n: &str,
    offset: i64,
    limit: i64,
) -> Result<Vec<Row>, InternalError> {
    let v: Value = catalog
        .get_json(&format!(
            "/internal/datasets/{}/versions/{}/rows?offset={}&limit={}",
            encode_segment(id),
            encode_segment(n),
            offset,
            limit
        ))
        .await?;
    Ok(rows_of(&v))
}

/// Parse the schema array out of a version-meta payload
/// (`parseSchema(version)` — missing/unparseable → []).
pub fn version_schema(meta: &Value) -> Vec<SchemaColumn> {
    let normalized = Value::Array(normalize_schema(meta.get("schema")));
    serde_json::from_value::<Vec<SchemaColumn>>(normalized).unwrap_or_default()
}

/// Normalize a schema payload to raw `{name, type}` entries (legacy
/// parseSchema read schemaJson directly — extra annotations like the public
/// contract's `markedWith` are dropped).
pub fn normalize_schema(v: Option<&Value>) -> Vec<Value> {
    match v {
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(|col| {
                let name = col.get("name")?.as_str()?;
                let ty = col.get("type")?.as_str()?;
                Some(serde_json::json!({ "name": name, "type": ty }))
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// POST /internal/datasets/{id}/versions — append the workbook output as a
/// new version. Returns (versionNumber, rowCount) from the contract response
/// `{datasetId, versionNumber, rowCount}`.
pub async fn post_version(
    catalog: &ServiceClient,
    dataset_id: &str,
    body: &Value,
) -> Result<(i64, i64), InternalError> {
    let resp: Value = catalog
        .post_json(
            &format!("/internal/datasets/{}/versions", encode_segment(dataset_id)),
            body,
        )
        .await?;
    let version_number = resp
        .get("versionNumber")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| {
            InternalError::Transport("catalog version response missing versionNumber".into())
        })?;
    let row_count = resp.get("rowCount").and_then(|v| v.as_i64()).unwrap_or(0);
    Ok((version_number, row_count))
}
