//! Internal cross-domain client (catalog).
//!
//! Catalog owns dataset rows/schemas/versions; per contracts/INTERNAL_API.md
//! masking is OPT-IN via the `role` query param on the rows endpoints — this
//! service passes the caller's effective actor role on every display read, so
//! governance masking survives the hop and the rows envelope's
//! `maskedColumns` (single masking authority) feeds the `_masked` lists.
//! The action-apply write path reads RAW (no role) exactly like the legacy
//! applyAction, so masked literals never round-trip into a new version.
//!
//! All parses are TOLERANT: a missing catalog degrades to clean `{ error }`
//! transport messages (502), never a panic.

use mf_internal::{InternalError, ServiceClient};
use mf_types::{Row, Value};
use mf_web::ApiError;

/// Map an internal-call error onto the API envelope: transport failures
/// become 502 with the transport message; callee `{ error }` bodies pass
/// through with their status.
pub fn to_api_error(err: InternalError) -> ApiError {
    match err {
        InternalError::Transport(m) => ApiError::new(axum::http::StatusCode::BAD_GATEWAY, m),
        InternalError::Api { status, message } => ApiError::new(
            axum::http::StatusCode::from_u16(status).unwrap_or(axum::http::StatusCode::BAD_GATEWAY),
            message,
        ),
    }
}

fn is_not_found(err: &InternalError) -> bool {
    matches!(err, InternalError::Api { status: 404, .. })
}

// ─── Catalog ──────────────────────────────────────────────────────────────

/// Minimal dataset summary (list contract = public GET /api/datasets).
#[derive(Debug, Clone)]
pub struct DatasetSummary {
    pub id: String,
    pub name: String,
    /// Head version rowCount (currentVersion.rowCount), null when versionless.
    pub row_count: Option<i64>,
}

/// Version meta from GET /internal/datasets/{id}/versions/{n}.
#[derive(Debug, Clone, Default)]
pub struct VersionMeta {
    /// Head/consumer version number (kept for tolerance; catalog may omit).
    #[allow(dead_code)]
    pub version_number: Option<i64>,
    pub schema: Vec<mf_types::SchemaColumn>,
    pub row_count: Option<i64>,
}

/// Result of POST /internal/datasets/{id}/versions.
#[derive(Debug, Clone)]
pub struct AppendVersionResult {
    /// Echoed dataset id (kept for tolerance; catalog may omit).
    #[allow(dead_code)]
    pub dataset_id: String,
    pub version_number: i64,
    pub row_count: i64,
}

/// Full payload of a rows endpoint response (catalog internal rows envelope:
/// { rows, total, versionNumber, schema, maskedColumns }).
#[derive(Debug, Clone, Default)]
pub struct RowsPayload {
    pub rows: Vec<Row>,
    /// Total row count of the resolved version.
    pub total: i64,
    #[allow(dead_code)]
    pub version_number: Option<i64>,
    /// Schema of the resolved version (first-two-columns fallback for m2m
    /// link datasets + explorer column fallback).
    pub schema: Vec<mf_types::SchemaColumn>,
    /// Columns the catalog masked for the requested role (single masking
    /// authority — surfaced as `_masked` on object rows).
    pub masked_columns: Vec<String>,
}

#[derive(Clone)]
pub struct CatalogClient {
    inner: ServiceClient,
}

impl CatalogClient {
    pub fn from_env() -> Self {
        Self {
            inner: ServiceClient::from_env("catalog", "CATALOG_INTERNAL_URL", 8082),
        }
    }

    /// Tolerant dataset-summary parse (accepts the public serializeDatasetSummary
    /// shape plus flatter variants).
    fn parse_summary(v: &Value) -> Option<DatasetSummary> {
        let id = v.get("id")?.as_str()?.to_string();
        let name = v.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
        let row_count = v
            .get("currentVersion")
            .and_then(|cv| cv.get("rowCount"))
            .and_then(|rc| rc.as_i64())
            .or_else(|| v.get("rowCount").and_then(|rc| rc.as_i64()));
        Some(DatasetSummary { id, name, row_count })
    }

    /// GET /internal/datasets — all dataset summaries.
    pub async fn list_datasets(&self) -> Result<Vec<DatasetSummary>, ApiError> {
        let v: Value = self
            .inner
            .get_json("/internal/datasets")
            .await
            .map_err(to_api_error)?;
        // tolerate a bare array or { datasets: [...] }
        let items = match &v {
            Value::Array(a) => a.clone(),
            obj => obj
                .get("datasets")
                .and_then(|d| d.as_array())
                .cloned()
                .unwrap_or_default(),
        };
        Ok(items.iter().filter_map(Self::parse_summary).collect())
    }

    /// GET /internal/datasets/{id} — one summary; None on 404.
    pub async fn get_dataset(&self, id: &str) -> Result<Option<DatasetSummary>, ApiError> {
        let path = format!("/internal/datasets/{}", pct(id));
        match self.inner.get_json::<Value>(&path).await {
            Ok(v) => Ok(Self::parse_summary(&v).or_else(|| {
                v.get("dataset").and_then(Self::parse_summary)
            })),
            Err(e) if is_not_found(&e) => Ok(None),
            Err(e) => Err(to_api_error(e)),
        }
    }

    /// GET /internal/datasets/by-name/{name} — lookup for seed-demo; None on 404.
    pub async fn dataset_by_name(&self, name: &str) -> Result<Option<DatasetSummary>, ApiError> {
        let path = format!("/internal/datasets/by-name/{}", pct(name));
        match self.inner.get_json::<Value>(&path).await {
            Ok(v) => Ok(Self::parse_summary(&v).or_else(|| {
                v.get("dataset").and_then(Self::parse_summary)
            })),
            Err(e) if is_not_found(&e) => Ok(None),
            Err(e) => Err(to_api_error(e)),
        }
    }

    /// GET /internal/datasets/{id}/versions/head — gate-aware consumer version
    /// meta; None when the dataset is unknown or has no consumable version.
    pub async fn head_version(&self, id: &str) -> Result<Option<VersionMeta>, ApiError> {
        let path = format!("/internal/datasets/{}/versions/head", pct(id));
        match self.inner.get_json::<Value>(&path).await {
            Ok(v) => Ok(Some(parse_version_meta(&v))),
            Err(e) if is_not_found(&e) => Ok(None),
            Err(e) => Err(to_api_error(e)),
        }
    }

    /// GET /internal/datasets/{id}/versions/head/rows/all — full consumer rows
    /// with masking applied at `role` (None → raw rows: ONLY for the action
    /// write path, which mutates data and must never round-trip MASK_LITERAL).
    /// Ok(None) when the dataset has no consumable version (legacy: empty
    /// object list).
    pub async fn head_rows_full(
        &self,
        id: &str,
        role: Option<&str>,
    ) -> Result<Option<RowsPayload>, ApiError> {
        let mut path = format!("/internal/datasets/{}/versions/head/rows/all", pct(id));
        if let Some(r) = role {
            path.push_str(&format!("?role={}", pct(r)));
        }
        match self.inner.get_json::<Value>(&path).await {
            Ok(v) => Ok(Some(parse_rows_payload(&v))),
            Err(e) if is_not_found(&e) => Ok(None),
            Err(e) => Err(to_api_error(e)),
        }
    }

    /// Rows-only convenience wrapper over [`Self::head_rows_full`].
    pub async fn head_rows(
        &self,
        id: &str,
        role: Option<&str>,
    ) -> Result<Option<Vec<Row>>, ApiError> {
        Ok(self.head_rows_full(id, role).await?.map(|p| p.rows))
    }

    /// POST /internal/datasets/{id}/versions — append a new version (the
    /// single write path; catalog infers the schema when absent, enforces
    /// outputJobId idempotency and emits mf.dataset.version.created).
    pub async fn append_version(
        &self,
        id: &str,
        body: &Value,
    ) -> Result<AppendVersionResult, ApiError> {
        let path = format!("/internal/datasets/{}/versions", pct(id));
        let v: Value = self
            .inner
            .post_json(&path, body)
            .await
            .map_err(to_api_error)?;
        Ok(AppendVersionResult {
            dataset_id: v
                .get("datasetId")
                .and_then(|d| d.as_str())
                .unwrap_or(id)
                .to_string(),
            version_number: v.get("versionNumber").and_then(|n| n.as_i64()).unwrap_or(0),
            row_count: v.get("rowCount").and_then(|n| n.as_i64()).unwrap_or(0),
        })
    }
}

/// Tolerant rows extraction: bare array | { rows } | { data }.
fn extract_rows(v: &Value) -> Vec<Row> {
    let items = match v {
        Value::Array(a) => a,
        obj => obj
            .get("rows")
            .or_else(|| obj.get("data"))
            .and_then(|r| r.as_array())
            .map(|a| a.as_slice())
            .unwrap_or(&[]),
    };
    items
        .iter()
        .filter_map(|item| item.as_object().cloned())
        .collect()
}

/// Parse the catalog internal rows envelope tolerantly (bare arrays and
/// flatter variants degrade to defaults).
fn parse_rows_payload(v: &Value) -> RowsPayload {
    let rows = extract_rows(v);
    let total = v
        .get("total")
        .and_then(|t| t.as_i64())
        .unwrap_or(rows.len() as i64);
    let version_number = v.get("versionNumber").and_then(|n| n.as_i64());
    let schema = match v.get("schema") {
        Some(Value::Array(cols)) => cols
            .iter()
            .filter_map(|c| {
                Some(mf_types::SchemaColumn {
                    name: c.get("name")?.as_str()?.to_string(),
                    column_type: match c.get("type").and_then(|t| t.as_str()) {
                        Some("number") => mf_types::ColumnType::Number,
                        Some("boolean") => mf_types::ColumnType::Boolean,
                        _ => mf_types::ColumnType::String,
                    },
                })
            })
            .collect(),
        _ => vec![],
    };
    let masked_columns = v
        .get("maskedColumns")
        .and_then(|m| m.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|c| c.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    RowsPayload { rows, total, version_number, schema, masked_columns }
}

/// Tolerant version-meta parse: { versionNumber, schema | schemaJson, rowCount }.
fn parse_version_meta(v: &Value) -> VersionMeta {
    let inner = if v.get("version").is_some() {
        v.get("version").unwrap()
    } else {
        v
    };
    let version_number = inner.get("versionNumber").and_then(|n| n.as_i64());
    let row_count = inner.get("rowCount").and_then(|n| n.as_i64());
    let schema = match inner.get("schema") {
        Some(Value::Array(cols)) => cols
            .iter()
            .filter_map(|c| {
                Some(mf_types::SchemaColumn {
                    name: c.get("name")?.as_str()?.to_string(),
                    column_type: match c.get("type").and_then(|t| t.as_str()) {
                        Some("number") => mf_types::ColumnType::Number,
                        Some("boolean") => mf_types::ColumnType::Boolean,
                        _ => mf_types::ColumnType::String,
                    },
                })
            })
            .collect(),
        _ => match inner.get("schemaJson").and_then(|s| s.as_str()) {
            Some(raw) => serde_json::from_str::<Vec<mf_types::SchemaColumn>>(raw).unwrap_or_default(),
            None => vec![],
        },
    };
    VersionMeta { version_number, schema, row_count }
}

/// Percent-encode one path/query segment (dataset ids/names/roles).
fn pct(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>()
        .replace('+', "%20")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_rows_tolerates_envelopes() {
        let bare: Value = serde_json::from_str(r#"[{"a":1}]"#).unwrap();
        assert_eq!(extract_rows(&bare).len(), 1);
        let wrapped: Value = serde_json::from_str(r#"{"rows":[{"a":1},{"a":2}]}"#).unwrap();
        assert_eq!(extract_rows(&wrapped).len(), 2);
        let data: Value = serde_json::from_str(r#"{"data":[{"a":1}]}"#).unwrap();
        assert_eq!(extract_rows(&data).len(), 1);
        let empty: Value = serde_json::from_str(r#"{"other":1}"#).unwrap();
        assert_eq!(extract_rows(&empty).len(), 0);
    }

    #[test]
    fn version_meta_parses_both_schema_forms() {
        let v: Value = serde_json::from_str(
            r#"{"versionNumber":3,"rowCount":10,"schema":[{"name":"id","type":"string"}]}"#,
        )
        .unwrap();
        let m = parse_version_meta(&v);
        assert_eq!(m.version_number, Some(3));
        assert_eq!(m.row_count, Some(10));
        assert_eq!(m.schema[0].name, "id");
        let v2: Value = serde_json::from_str(
            r#"{"versionNumber":1,"schemaJson":"[{\"name\":\"n\",\"type\":\"number\"}]"}"#,
        )
        .unwrap();
        let m2 = parse_version_meta(&v2);
        assert_eq!(m2.schema[0].column_type, mf_types::ColumnType::Number);
    }

    #[test]
    fn summary_parse_uses_current_version() {
        let v: Value = serde_json::from_str(
            r#"{"id":"d1","name":"Shipments","currentVersion":{"versionNumber":2,"rowCount":7,"columnCount":3}}"#,
        )
        .unwrap();
        let s = CatalogClient::parse_summary(&v).unwrap();
        assert_eq!(s.name, "Shipments");
        assert_eq!(s.row_count, Some(7));
    }

    #[test]
    fn rows_payload_parses_catalog_envelope() {
        let v: Value = serde_json::from_str(
            r#"{"rows":[{"a":1},{"a":2}],"total":2,"versionNumber":5,"schema":[{"name":"a","type":"number"}],"maskedColumns":["a"]}"#,
        )
        .unwrap();
        let p = parse_rows_payload(&v);
        assert_eq!(p.rows.len(), 2);
        assert_eq!(p.total, 2);
        assert_eq!(p.version_number, Some(5));
        assert_eq!(p.schema[0].column_type, mf_types::ColumnType::Number);
        assert_eq!(p.masked_columns, vec!["a"]);
        // bare array tolerance: total falls back to rows.len()
        let bare: Value = serde_json::from_str(r#"[{"a":1}]"#).unwrap();
        let p2 = parse_rows_payload(&bare);
        assert_eq!(p2.total, 1);
        assert!(p2.masked_columns.is_empty());
    }

    #[test]
    fn pct_encodes_segments() {
        assert_eq!(pct("Shipments"), "Shipments");
        assert_eq!(pct("a b/c"), "a%20b%2Fc");
    }
}
