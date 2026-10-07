//! Catalog-service internal client (per backend/contracts/INTERNAL_API.md).
//!
//! Orchestration never touches catalog tables: source nodes read rows through
//! `GET /internal/datasets/{id}/versions/{n|head}/rows/all` and output nodes
//! write through `POST /internal/datasets/{id}/versions` (idempotent via
//! `outputJobId`). Masking parity with engine.ts:719 — in shared mode the rows
//! call carries `role=viewer` (legacy applied viewer masking to pipeline
//! reads); in demo mode no role param (raw rows).

use mf_internal::{InternalError, ServiceClient};
use serde_json::{Map, Value};

pub struct CatalogClient {
    client: ServiceClient,
    /// True when the platform runs in demo mode (raw rows; no role param).
    demo: bool,
}

/// Rows fetched for a source node.
pub struct SourceRows {
    pub rows: Vec<Map<String, Value>>,
    /// Version actually read (None = dataset has no consumable version).
    pub version_number: Option<i64>,
}

impl CatalogClient {
    pub fn from_env(demo: bool) -> Self {
        Self {
            client: ServiceClient::from_env("catalog", "CATALOG_INTERNAL_URL", 8082),
            demo,
        }
    }

    fn rows_query(&self) -> &'static str {
        // Shared mode: catalog applies viewer-level marking masks (legacy
        // `applyMasking(datasetId, rows, 'viewer')`); demo mode: raw rows.
        if self.demo {
            ""
        } else {
            "?role=viewer"
        }
    }

    /// Dataset detail (meta + versions) — used for the display name and the
    /// output-removal assessment. 404 → dataset unknown.
    pub async fn dataset_detail(&self, dataset_id: &str) -> Result<Value, InternalError> {
        self.client
            .get_json(&format!("/internal/datasets/{dataset_id}"))
            .await
    }

    /// Lookup a dataset by exact name (compute/engine output datasets).
    pub async fn dataset_by_name(&self, name: &str) -> Result<Value, InternalError> {
        self.client
            .get_json(&format!("/internal/datasets/by-name/{}", pct_encode(name)))
            .await
    }

    /// Create a dataset (engine output datasets get the legacy `derived` tag).
    pub async fn create_dataset(&self, name: &str, tags: &[&str]) -> Result<Value, InternalError> {
        let body = serde_json::json!({ "name": name, "tags": tags });
        self.client.post_json("/internal/datasets", &body).await
    }

    /// Full rows of a version. `version` is an exact number or `"head"`
    /// (gate-aware consumer resolution happens inside catalog).
    pub async fn rows_all(
        &self,
        dataset_id: &str,
        version: &str,
    ) -> Result<SourceRows, InternalError> {
        let path = format!(
            "/internal/datasets/{dataset_id}/versions/{version}/rows/all{}",
            self.rows_query()
        );
        let v: Value = self.client.get_json(&path).await?;
        Ok(parse_rows_response(&v))
    }

    /// Append a new version — THE single write path for engine output.
    /// Idempotent via `outputJobId` (a crashed worker re-POSTing the same job
    /// gets the already-committed version back instead of writing a second).
    pub async fn append_version(
        &self,
        dataset_id: &str,
        body: &Value,
    ) -> Result<Value, InternalError> {
        self.client
            .post_json(&format!("/internal/datasets/{dataset_id}/versions"), body)
            .await
    }

    /// Freshness list for GET /api/health (`[{id,name,rowCount,updatedAt,freshnessMinutes}]`).
    pub async fn health_datasets(&self) -> Result<Vec<Value>, InternalError> {
        let v: Value = self.client.get_json("/internal/health/datasets").await?;
        Ok(match v {
            Value::Array(a) => a,
            Value::Object(mut m) => m
                .remove("datasets")
                .and_then(|d| d.as_array().cloned())
                .unwrap_or_default(),
            _ => vec![],
        })
    }

    /// Remove one dataset version (output cleanup, mode='version').
    pub async fn delete_version(
        &self,
        dataset_id: &str,
        version_number: i64,
    ) -> Result<(), InternalError> {
        self.client
            .delete(&format!(
                "/internal/datasets/{dataset_id}/versions/{version_number}"
            ))
            .await
    }

    /// Remove a whole dataset (output cleanup, mode='dataset').
    pub async fn delete_dataset(&self, dataset_id: &str) -> Result<(), InternalError> {
        self.client
            .delete(&format!("/internal/datasets/{dataset_id}"))
            .await
    }
}

/// Defensive parse of the catalog rows response: accepts `{rows:[...]}` (the
/// public rows contract) or a bare array, plus an optional `versionNumber`
/// (or `version.versionNumber`) so the engine can capture the manifest input.
pub fn parse_rows_response(v: &Value) -> SourceRows {
    let rows_val = match v {
        Value::Array(_) => v,
        Value::Object(m) => m.get("rows").unwrap_or(&Value::Null),
        _ => &Value::Null,
    };
    let mut rows = Vec::new();
    if let Value::Array(arr) = rows_val {
        for item in arr {
            if let Value::Object(m) = item {
                rows.push(m.clone());
            }
        }
    }
    let version_number = v.get("versionNumber").and_then(|x| x.as_i64()).or_else(|| {
        v.get("version")
            .and_then(|ver| ver.get("versionNumber"))
            .and_then(|x| x.as_i64())
    });
    SourceRows {
        rows,
        version_number,
    }
}

/// Minimal percent-encoding for path segments (dataset names may contain
/// spaces/slashes). Unreserved set per RFC 3986.
pub fn pct_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Human-readable transport/API message for PipelineError surfaces.
pub fn internal_error_message(e: &InternalError) -> String {
    match e {
        InternalError::Transport(m) => format!("service unavailable: {m}"),
        InternalError::Api { status, message } => format!("{status}: {message}"),
    }
}

pub fn is_not_found(e: &InternalError) -> bool {
    matches!(e, InternalError::Api { status: 404, .. })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rows_response_shapes() {
        let wrapped =
            parse_rows_response(&json!({"rows": [{"a": 1}], "total": 1, "versionNumber": 4}));
        assert_eq!(wrapped.rows.len(), 1);
        assert_eq!(wrapped.version_number, Some(4));

        let bare = parse_rows_response(&json!([{"a": 1}, {"a": 2}]));
        assert_eq!(bare.rows.len(), 2);
        assert_eq!(bare.version_number, None);

        let nested = parse_rows_response(&json!({"rows": [], "version": {"versionNumber": 2}}));
        assert_eq!(nested.version_number, Some(2));

        let empty = parse_rows_response(&json!({}));
        assert!(empty.rows.is_empty());
        assert_eq!(empty.version_number, None);
    }

    #[test]
    fn pct_encoding() {
        assert_eq!(pct_encode("curated_orders"), "curated_orders");
        assert_eq!(pct_encode("Sales 2024/Q1"), "Sales%202024%2FQ1");
        assert_eq!(pct_encode("a~b.c-d_e"), "a~b.c-d_e");
    }
}
