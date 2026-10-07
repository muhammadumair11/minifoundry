//! /api/foundry/v1/datasets* — public dataset catalog reads (ports of the
//! legacy v1 routes). Data comes from the catalog's internal endpoints with
//! a VIEWER actor + `role=viewer` so column-marking masking is applied at
//! the egress point (catalog computes it once; this facade never sees
//! unmasked rows).
//!
//! Version resolution (legacy resolveConsumerVersion semantics): default is
//! the consumer version (`versions/head` on the catalog — gate-aware); an
//! explicit `?version=` wins but is rejected on gated datasets when it is
//! not the published version. Callee 4xx contracts (404 messages) pass
//! through unchanged; transport failures → 502 'upstream service
//! unavailable' (documented deviation — legacy had in-process DB access).

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::http::{HeaderMap, Uri};
use axum::response::{IntoResponse, Response};
use mf_web::{json_ok, ApiError};
use serde_json::Value;
use std::collections::HashMap;

use crate::fanout::{fanout_err, items_array, payload_root, viewer_actor};
use crate::guard::{self, v1_page_from, v1_pagination};
use crate::routes::{paginate, parse_tags, sort_by_ts_desc, version_param};
use crate::state::AppState;

/// GET /api/foundry/v1/datasets?page=&pageSize=
///
/// latestVersion is the newest main-branch PUBLISHED version (legacy query:
/// `versions where branch=main AND lifecycle=published, desc, take 1`) —
/// NOT the draft head, so gated datasets show their consumer pointer. The
/// catalog list summary carries only `currentVersion` (any lifecycle), so
/// each dataset's detail is fetched in parallel (learning-scale N, bounded
/// fan-out); per-item failures degrade to the summary's currentVersion.
pub async fn list_datasets(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let path = uri.path().to_string();
    let st = state.clone();
    guard::with_api_token(&state, &headers, &path, move |_ctx| async move {
        let (page, page_size) = v1_page_from(&params);
        let resp = st.catalog.get("/internal/datasets").await.map_err(fanout_err)?;
        let summaries = items_array(&resp, "datasets");

        let details: Vec<Option<Value>> = futures::future::join_all(summaries.iter().map(|d| {
            let st = st.clone();
            async move {
                let id = d.get("id").and_then(|v| v.as_str())?;
                st.catalog
                    .get(&format!("/internal/datasets/{id}"))
                    .await
                    .ok()
            }
        }))
        .await;

        let mut items: Vec<Value> = summaries
            .iter()
            .zip(details)
            .map(|(d, detail)| dataset_v1_item(d, detail.as_ref()))
            .collect();
        let total = items.len() as i64;
        sort_by_ts_desc(&mut items, "updatedAt");
        let data = paginate(&items, page, page_size);
        Ok(json_ok(serde_json::json!({
            "data": data,
            "pagination": v1_pagination(page, page_size, total),
        })))
    })
    .await
}

/// GET /api/foundry/v1/datasets/{id}?version=
pub async fn dataset_detail(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path(id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let path = uri.path().to_string();
    let st = state.clone();
    guard::with_api_token(&state, &headers, &path, move |_ctx| async move {
        let version_number = version_param(&params)?;
        let resolved = resolve_version(&st, &id, version_number).await?;
        let schema = mark_schema(&st, &id, &resolved.schema).await;

        Ok(json_ok(serde_json::json!({
            "dataset": {
                "id": resolved.root.get("id").cloned().unwrap_or(Value::String(id.clone())),
                "name": resolved.name,
                "description": resolved.root.get("description").cloned().unwrap_or(Value::Null),
                "tags": parse_tags(resolved.root.get("tags").unwrap_or(&Value::Null)),
                "projectId": resolved.root.get("projectId").cloned().unwrap_or(Value::Null),
                "keepLastN": resolved.root.get("keepLastN").cloned().unwrap_or(Value::Null),
                "version": {
                    "versionNumber": resolved.version_number,
                    "schema": schema,
                    "rowCount": resolved.row_count,
                    "createdAt": resolved.created_at,
                },
            },
            "versions": resolved.versions,
        })))
    })
    .await
}

/// GET /api/foundry/v1/datasets/{id}/rows?version=&page=&pageSize=
pub async fn dataset_rows(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path(id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let path = uri.path().to_string();
    let st = state.clone();
    guard::with_api_token(&state, &headers, &path, move |_ctx| async move {
        let version_number = version_param(&params)?;
        let (page, page_size) = v1_page_from(&params);
        let resolved = resolve_version(&st, &id, version_number).await?;
        let (rows, masked_columns) = fetch_rows(&st, &id, &resolved).await?;

        // Masking already applied by the catalog (role=viewer) — paginate after.
        let data = paginate(&rows, page, page_size);
        Ok(json_ok(serde_json::json!({
            "data": data,
            "pagination": v1_pagination(page, page_size, resolved.row_count),
            "version": {
                "versionNumber": resolved.version_number,
                "rowCount": resolved.row_count,
            },
            "maskedColumns": masked_columns,
        })))
    })
    .await
}

/// GET /api/foundry/v1/datasets/{id}/export?version= — CSV export (masked
/// for viewer; NOT audited, same as legacy).
pub async fn dataset_export(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path(id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let path = uri.path().to_string();
    let st = state.clone();
    guard::with_api_token(&state, &headers, &path, move |_ctx| async move {
        let version_number = version_param(&params)?;
        let resolved = resolve_version(&st, &id, version_number).await?;
        let (rows, _masked) = fetch_rows(&st, &id, &resolved).await?;

        let csv = crate::csv::rows_to_csv(&resolved.schema, &rows);
        let filename = format!(
            "{}-v{}.csv",
            crate::csv::slugify_name(&resolved.name),
            resolved.version_number
        );
        let mut resp = (StatusCode::OK, csv).into_response();
        resp.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/csv; charset=utf-8"),
        );
        if let Ok(v) = HeaderValue::from_str(&format!("attachment; filename=\"{filename}\"")) {
            resp.headers_mut().insert(header::CONTENT_DISPOSITION, v);
        }
        Ok(resp)
    })
    .await
}

// ─── shared helpers ─────────────────────────────────────────────────────

/// Everything the detail/rows/export routes need about one dataset version.
pub struct ResolvedVersion {
    /// Dataset-detail root object (unwrapped from `{dataset:…}` envelopes).
    pub root: Value,
    pub name: String,
    pub version_number: Value,
    pub row_count: i64,
    pub schema: Vec<Value>,
    pub created_at: Value,
    /// Published main-branch versions (versionNumber desc) for the detail
    /// envelope — legacy `{versionNumber, rowCount, createdAt}` projection.
    pub versions: Vec<Value>,
}

/// Ports the legacy consumer-version resolution chain:
/// dataset existence → explicit-version gate check → version meta fetch
/// (`head` = gate-aware consumer version, resolved by the catalog).
async fn resolve_version(
    state: &AppState,
    id: &str,
    version_number: Option<i64>,
) -> Result<ResolvedVersion, ApiError> {
    let detail = state
        .catalog
        .get(&format!("/internal/datasets/{id}"))
        .await
        .map_err(fanout_err)?;
    let root = payload_root(&detail, &["dataset"]).clone();
    let name = root
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or(id)
        .to_string();

    // Gated datasets: an explicit ?version= must equal the published pointer
    // (legacy: `Version ${n} is not published for dataset '${name}'`).
    if let Some(n) = version_number {
        let gated = root.get("qualityGate").and_then(|v| v.as_bool()).unwrap_or(false);
        if let Some(published) = root.get("publishedVersion").and_then(|v| v.as_i64()) {
            if gated && n != published {
                return Err(ApiError::not_found(format!(
                    "Version {n} is not published for dataset '{name}'"
                )));
            }
        }
    }

    let seg = match version_number {
        Some(n) => n.to_string(),
        None => "head".to_string(),
    };
    let meta = state
        .catalog
        .get_as(
            &format!("/internal/datasets/{id}/versions/{seg}"),
            &viewer_actor(),
        )
        .await
        .map_err(fanout_err)?;
    let vroot = payload_root(&meta, &["version"]).clone();

    let resolved_number = vroot
        .get("versionNumber")
        .cloned()
        .or_else(|| version_number.map(|n| Value::Number(n.into())))
        .unwrap_or(Value::Null);
    let row_count = vroot.get("rowCount").and_then(|v| v.as_i64()).unwrap_or(0);
    let schema = vroot
        .get("schema")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let created_at = vroot.get("createdAt").cloned().unwrap_or(Value::Null);

    Ok(ResolvedVersion {
        root,
        name,
        version_number: resolved_number,
        row_count,
        schema,
        created_at,
        versions: published_versions(&detail),
    })
}

/// Published main-branch versions from a catalog detail envelope
/// (`{dataset, versions:[…]}`), projected + sorted versionNumber desc —
/// exactly the legacy detail-route query.
pub fn published_versions(envelope: &Value) -> Vec<Value> {
    let mut versions: Vec<Value> = envelope
        .get("versions")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter(|v| {
                    v.get("lifecycle")
                        .and_then(|x| x.as_str())
                        .map(|l| l == "published")
                        .unwrap_or(true)
                        && v.get("branch")
                            .and_then(|x| x.as_str())
                            .map(|b| b == "main")
                            .unwrap_or(true)
                })
                .map(|v| {
                    serde_json::json!({
                        "versionNumber": v.get("versionNumber").cloned().unwrap_or(Value::Null),
                        "rowCount": v.get("rowCount").cloned().unwrap_or(Value::Null),
                        "createdAt": v.get("createdAt").cloned().unwrap_or(Value::Null),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    versions.sort_by(|a, b| {
        b["versionNumber"]
            .as_i64()
            .unwrap_or(0)
            .cmp(&a["versionNumber"].as_i64().unwrap_or(0))
    });
    versions
}

/// Newest published main-branch version as the v1 `latestVersion` block.
fn latest_published_version(envelope: &Value) -> Option<Value> {
    published_versions(envelope).into_iter().next()
}

/// Full masked rows for one resolved version (catalog applies viewer
/// masking; `role=viewer` per the internal-API clarification + the actor
/// header for good measure).
async fn fetch_rows(
    state: &AppState,
    id: &str,
    resolved: &ResolvedVersion,
) -> Result<(Vec<Value>, Value), ApiError> {
    let seg = match resolved.version_number.as_i64() {
        Some(n) => n.to_string(),
        None => "head".to_string(),
    };
    let body = state
        .catalog
        .get_as(
            &format!("/internal/datasets/{id}/versions/{seg}/rows/all?role=viewer"),
            &viewer_actor(),
        )
        .await
        .map_err(fanout_err)?;
    let root = payload_root(&body, &["rows"]);
    let rows = if root.is_array() {
        root.as_array().cloned().unwrap_or_default()
    } else {
        items_array(root, "rows")
    };
    let masked = body
        .get("maskedColumns")
        .cloned()
        .filter(|v| v.is_array())
        .unwrap_or(Value::Array(vec![]));
    Ok((rows, masked))
}

/// Additive `markedWith` annotation from governance's internal markings
/// (legacy maskSchema). Governance unreachable → nulls (annotation-only;
/// actual masking is enforced by the catalog regardless).
async fn mark_schema(state: &AppState, dataset_id: &str, schema: &[Value]) -> Vec<Value> {
    let markings: HashMap<String, String> = match state
        .governance
        .get(&format!("/internal/markings/dataset/{dataset_id}"))
        .await
    {
        Ok(v) => items_array(&v, "markings")
            .into_iter()
            .filter_map(|m| {
                Some((
                    m.get("columnName")?.as_str()?.to_string(),
                    m.get("markingName")?.as_str()?.to_string(),
                ))
            })
            .collect(),
        Err(e) => {
            tracing::warn!(error = %e, "governance markings unavailable; markedWith degrades to null");
            HashMap::new()
        }
    };
    schema
        .iter()
        .map(|col| {
            let mut c = match col {
                Value::Object(m) => Value::Object(m.clone()),
                other => serde_json::json!({ "name": other.as_str().unwrap_or_default() }),
            };
            let name = c.get("name").and_then(|v| v.as_str()).unwrap_or_default();
            c["markedWith"] = markings
                .get(name)
                .map(|n| Value::String(n.clone()))
                .unwrap_or(Value::Null);
            c
        })
        .collect()
}

/// v1 dataset-list item (fixture reads/v1-datasets.json). `detail` (the
/// catalog detail envelope, when the parallel fetch succeeded) provides the
/// published-latest version; otherwise the summary's own version-ish keys
/// are the best-effort fallback.
pub fn dataset_v1_item(d: &Value, detail: Option<&Value>) -> Value {
    let root = payload_root(d, &["dataset"]);
    let latest = detail
        .and_then(latest_published_version)
        .or_else(|| {
            ["latestPublishedVersion", "latestVersion", "consumerVersion", "currentVersion"]
                .iter()
                .find_map(|k| root.get(*k).filter(|v| v.is_object()))
                .map(|v| {
                    serde_json::json!({
                        "versionNumber": v.get("versionNumber").cloned().unwrap_or(Value::Null),
                        "rowCount": v.get("rowCount").cloned().unwrap_or(Value::Null),
                        "createdAt": v.get("createdAt").cloned().unwrap_or(Value::Null),
                    })
                })
        })
        .unwrap_or(Value::Null);
    // The detail envelope is fresher for updatedAt when present.
    let detail_root = detail.map(|dv| payload_root(dv, &["dataset"]));
    let updated_at = detail_root
        .and_then(|r| r.get("updatedAt").cloned())
        .or_else(|| root.get("updatedAt").cloned())
        .unwrap_or(Value::Null);
    serde_json::json!({
        "id": root.get("id").cloned().unwrap_or(Value::Null),
        "name": root.get("name").cloned().unwrap_or(Value::Null),
        "description": root.get("description").cloned().unwrap_or(Value::Null),
        "tags": parse_tags(root.get("tags").unwrap_or(&Value::Null)),
        "projectId": root.get("projectId").cloned().unwrap_or(Value::Null),
        "latestVersion": latest,
        "updatedAt": updated_at,
    })
}
