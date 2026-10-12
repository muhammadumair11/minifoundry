//! /api/datasets/{id}/rows | /diff | /export — governed row egress.
//! Rows are MASKED per the caller's role BEFORE search/sort/pagination
//! (legacy rows route); export masks before serialization; diff masks both
//! sides at the caller's role (per the port spec — legacy diff predates
//! masking, recorded as a deliberate security alignment).

use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::Response;
use mf_types::{Row, Value};
use mf_web::{actor_from_headers, json_ok, ApiError, ApiResult};
use serde_json::json;
use std::collections::HashMap;

use crate::audit::{audit, AuditOptions};
use crate::csvutil::{rows_to_csv, slugify_name};
use crate::dataset_service::{get_dataset_version, resolve_consumer_version};
use crate::jsval::{canonical_row, compare_values, js_stringify, values_json};
use crate::masking::{apply_masking, fetch_markings, mask_schema, masked_columns_for};
use crate::routes::{parse_version_param, require_dataset};
use crate::rows::{read_version_rows_all, read_version_rows_paged, rows_from_data_json};
use crate::state::{AppState, VersionRow};

/// Shared version selection for rows/export (exact legacy control flow):
/// explicit ?version= wins; ?branch= resolves that branch's head; VIEWERS
/// without explicit selection read the consumer version and may not see
/// drafts.
async fn select_version(
    state: &AppState,
    dataset_id: &str,
    dataset_name: &str,
    version_number: Option<i32>,
    branch_param: Option<&str>,
    role: &str,
) -> ApiResult<VersionRow> {
    let branch_version = match branch_param {
        Some(b) if b != "main" => {
            let head: Option<i32> = sqlx::query_scalar(
                "SELECT head_version FROM dataset_branches WHERE dataset_id = $1 AND name = $2",
            )
            .bind(dataset_id)
            .bind(b)
            .fetch_optional(&state.db)
            .await?;
            head
        }
        _ => None,
    };
    let consumer = if role == "viewer" && version_number.is_none() && branch_version.is_none() {
        resolve_consumer_version(&state.db, dataset_id).await?
    } else {
        None
    };
    let selected = version_number
        .or(branch_version)
        .or_else(|| consumer.as_ref().and_then(|c| c.version_number));
    let version = if selected.is_none() && role == "viewer" {
        None
    } else {
        get_dataset_version(&state.db, dataset_id, selected).await?
    };
    let Some(version) = version else {
        return Err(ApiError::not_found(match version_number {
            Some(n) => format!("Version {n} not found for dataset '{dataset_name}'"),
            None => format!("Dataset '{dataset_name}' has no versions"),
        }));
    };
    if role == "viewer" && version.lifecycle != "published" {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "Draft and branch versions require editor role",
        ));
    }
    Ok(version)
}

fn js_page(raw: Option<&String>, default: i64) -> i64 {
    let n = raw
        .map(|s| crate::jsval::js_parse_number(s))
        .filter(|n| !n.is_nan() && *n != 0.0)
        .unwrap_or(default as f64);
    let n = if n.is_nan() { default as f64 } else { n };
    n.max(1.0) as i64
}

/// GET /api/datasets/{id}/rows — paginated rows with substring search
/// (?query=) and optional sort (?orderBy=&dir=), masked at the caller's role.
pub async fn get_rows(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    query: axum::extract::Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    let (dataset_id, dataset_name) = require_dataset(&state.db, &id).await?;
    let version_number = parse_version_param(query.get("version"))?;
    let version = select_version(
        &state,
        &dataset_id,
        &dataset_name,
        version_number,
        query.get("branch").map(|s| s.as_str()),
        &actor.role,
    )
    .await?;

    let columns = version.schema_json.0.clone();
    let page = js_page(query.get("page"), 1);
    let page_size = {
        let raw = js_page(query.get("pageSize"), 50);
        raw.clamp(1, 200)
    };
    let q = query.get("query").filter(|s| !s.is_empty());
    let order_by = query.get("orderBy").filter(|s| !s.is_empty());

    let markings = fetch_markings(&state, &dataset_id).await;

    if q.is_none() && order_by.is_none() {
        let (rows, total) = read_version_rows_paged(
            &state.db,
            &dataset_id,
            version.version_number,
            page,
            page_size,
        )
        .await?;
        let masked_columns = masked_columns_for(&markings, &actor.role);
        let (rows, masked_columns) = apply_masking(rows, &masked_columns);
        return Ok(json_ok(json!({
            "rows": rows,
            "total": total,
            "page": page,
            "pageSize": page_size,
            "columns": mask_schema(&columns, &markings),
            "maskedColumns": masked_columns,
        })));
    }

    // Search/sort path: load ALL rows, mask FIRST (so neither cell values nor
    // the search filter can leak governed values), then filter/sort/paginate.
    let raw = read_version_rows_all(
        &state.db,
        &dataset_id,
        version.version_number,
        &version.data_json,
    )
    .await?;
    let masked_columns = masked_columns_for(&markings, &actor.role);
    let (masked_rows, masked_columns) = apply_masking(raw, &masked_columns);
    let mut rows = masked_rows;

    if let Some(q) = q {
        let needle = q.to_lowercase();
        rows.retain(|row| values_json(row).to_lowercase().contains(&needle));
    }
    if let Some(order_by) = order_by {
        let desc = query.get("dir").map(|d| d == "desc").unwrap_or(false);
        rows.sort_by(|a, b| {
            let cmp = compare_values(a.get(order_by), b.get(order_by));
            if desc {
                cmp.reverse()
            } else {
                cmp
            }
        });
    }

    let total = rows.len() as i64;
    let start = ((page - 1) * page_size).max(0) as usize;
    let end = (start + page_size as usize).min(rows.len());
    let page_rows: Vec<Row> = if start < rows.len() {
        rows[start..end].to_vec()
    } else {
        Vec::new()
    };

    Ok(json_ok(json!({
        "rows": page_rows,
        "total": total,
        "page": page,
        "pageSize": page_size,
        "columns": mask_schema(&columns, &markings),
        "maskedColumns": masked_columns,
    })))
}

// ─── Diff ────────────────────────────────────────────────────────────────

const CAP: usize = 100;

fn key_of(row: &Row, key_column: &str) -> String {
    match row.get(key_column) {
        None | Some(Value::Null) => "\u{2205}null".to_string(),
        Some(v) => js_stringify(v),
    }
}

/// Pure diff computation (unit-testable): schema diff by column name, row
/// diff keyed by the FIRST schema column value, each list capped at 100.
pub fn compute_diff(
    dataset_id: &str,
    from_num: i32,
    to_num: i32,
    from_schema: &[mf_types::SchemaColumn],
    to_schema: &[mf_types::SchemaColumn],
    from_rows: Vec<Row>,
    to_rows: Vec<Row>,
) -> Value {
    let from_cols: HashMap<&str, &mf_types::SchemaColumn> =
        from_schema.iter().map(|c| (c.name.as_str(), c)).collect();
    let to_cols: HashMap<&str, &mf_types::SchemaColumn> =
        to_schema.iter().map(|c| (c.name.as_str(), c)).collect();

    let added: Vec<Value> = to_schema
        .iter()
        .filter(|c| !from_cols.contains_key(c.name.as_str()))
        .map(|c| json!({ "name": c.name, "type": c.column_type }))
        .collect();
    let removed: Vec<Value> = from_schema
        .iter()
        .filter(|c| !to_cols.contains_key(c.name.as_str()))
        .map(|c| json!({ "name": c.name, "type": c.column_type }))
        .collect();
    let changed: Vec<Value> = to_schema
        .iter()
        .filter_map(|c| {
            let prev = from_cols.get(c.name.as_str())?;
            if prev.column_type != c.column_type {
                Some(json!({
                    "name": c.name,
                    "fromType": prev.column_type,
                    "toType": c.column_type,
                }))
            } else {
                None
            }
        })
        .collect();

    let key_column = to_schema
        .first()
        .or_else(|| from_schema.first())
        .map(|c| c.name.clone());

    let mut added_rows: Vec<Row> = Vec::new();
    let mut removed_rows: Vec<Row> = Vec::new();
    let mut changed_rows: Vec<Value> = Vec::new();
    let mut truncated = false;

    if let Some(key_column) = key_column {
        // first-wins maps (legacy Map.set guarded by has())
        let mut from_map: Vec<(String, &Row)> = Vec::new();
        for row in &from_rows {
            let k = key_of(row, &key_column);
            if !from_map.iter().any(|(ek, _)| *ek == k) {
                from_map.push((k, row));
            }
        }
        let mut to_map_keys: Vec<String> = Vec::new();
        for row in &to_rows {
            let k = key_of(row, &key_column);
            if !to_map_keys.contains(&k) {
                to_map_keys.push(k);
            }
        }

        for row in &to_rows {
            let key = key_of(row, &key_column);
            match from_map.iter().find(|(k, _)| *k == key) {
                None => {
                    if added_rows.len() < CAP {
                        added_rows.push(row.clone());
                    } else {
                        truncated = true;
                    }
                }
                Some((_, prev)) => {
                    if canonical_row(prev) != canonical_row(row) {
                        if changed_rows.len() < CAP {
                            changed_rows.push(json!({
                                "key": key,
                                "before": prev,
                                "after": row,
                            }));
                        } else {
                            truncated = true;
                        }
                    }
                }
            }
        }
        for row in &from_rows {
            let key = key_of(row, &key_column);
            if !to_map_keys.contains(&key) {
                if removed_rows.len() < CAP {
                    removed_rows.push(row.clone());
                } else {
                    truncated = true;
                }
            }
        }
    }

    json!({
        "datasetId": dataset_id,
        "fromVersion": from_num,
        "toVersion": to_num,
        "schema": { "added": added, "removed": removed, "changed": changed },
        "rowCount": { "from": from_rows.len(), "to": to_rows.len() },
        "addedRows": added_rows,
        "removedRows": removed_rows,
        "changedRows": changed_rows,
        "truncated": truncated,
    })
}

/// GET /api/datasets/{id}/diff?from=<n>&to=<m> — version diff (no role guard
/// in legacy; reads are open).
pub async fn get_diff(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    query: axum::extract::Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_dataset(&state.db, &id).await?;

    let parse_side = |raw: Option<&String>| -> Option<i32> {
        // Number(null) === 0 → invalid; matches the legacy coercion checks
        let n = crate::jsval::js_parse_number(raw.map(|s| s.as_str()).unwrap_or(""));
        if n.is_finite() && n.fract() == 0.0 && n >= 1.0 {
            Some(n as i32)
        } else {
            None
        }
    };
    let (Some(from_num), Some(to_num)) =
        (parse_side(query.get("from")), parse_side(query.get("to")))
    else {
        return Err(ApiError::bad_request(
            "Query parameters 'from' and 'to' must be version numbers",
        ));
    };

    let from_version = sqlx::query_as::<_, (sqlx::types::Json<Vec<mf_types::SchemaColumn>>, String)>(
        "SELECT schema_json, data_json FROM dataset_versions WHERE dataset_id = $1 AND version_number = $2",
    )
    .bind(&id)
    .bind(from_num)
    .fetch_optional(&state.db)
    .await?;
    let Some((from_schema, from_data)) = from_version else {
        return Err(ApiError::bad_request(format!(
            "Version {from_num} not found"
        )));
    };
    let to_version = sqlx::query_as::<_, (sqlx::types::Json<Vec<mf_types::SchemaColumn>>, String)>(
        "SELECT schema_json, data_json FROM dataset_versions WHERE dataset_id = $1 AND version_number = $2",
    )
    .bind(&id)
    .bind(to_num)
    .fetch_optional(&state.db)
    .await?;
    let Some((to_schema, to_data)) = to_version else {
        return Err(ApiError::bad_request(format!("Version {to_num} not found")));
    };

    // Masking at the caller's role (port spec: every public row-egress path).
    let markings = fetch_markings(&state, &id).await;
    let masked_columns = masked_columns_for(&markings, &actor.role);
    let from_rows = rows_from_data_json(&from_data);
    let to_rows = rows_from_data_json(&to_data);
    let (from_rows, _) = apply_masking(from_rows, &masked_columns);
    let (to_rows, _) = apply_masking(to_rows, &masked_columns);

    let diff = compute_diff(
        &id,
        from_num,
        to_num,
        &from_schema.0,
        &to_schema.0,
        from_rows,
        to_rows,
    );
    Ok(json_ok(diff))
}

// ─── Export ──────────────────────────────────────────────────────────────

/// GET /api/datasets/{id}/export?version= — CSV export (viewer+ allowed:
/// reads are open), masked per the caller's role BEFORE serialization,
/// audited as dataset.export.
pub async fn export_dataset(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    query: axum::extract::Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    let (dataset_id, dataset_name) = require_dataset(&state.db, &id).await?;
    let version_number = parse_version_param(query.get("version"))?;
    let version = select_version(
        &state,
        &dataset_id,
        &dataset_name,
        version_number,
        None,
        &actor.role,
    )
    .await?;

    let schema = version.schema_json.0.clone();
    let raw = rows_from_data_json(&version.data_json);
    let (rows, _masked) =
        crate::masking::mask_rows_public(&state, &dataset_id, raw, &actor.role).await;

    audit(
        &state,
        &actor,
        AuditOptions::new("dataset.export", "dataset")
            .resource_id(Some(&dataset_id))
            .resource_name(Some(&dataset_name))
            .detail(Some(&format!(
                "version={} rows={} format=csv",
                version.version_number,
                rows.len()
            ))),
    )
    .await;

    let filename = format!(
        "{}-v{}.csv",
        slugify_name(&dataset_name),
        version.version_number
    );
    let csv = rows_to_csv(&schema, &rows);
    let mut resp = Response::new(axum::body::Body::from(csv));
    *resp.status_mut() = StatusCode::OK;
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/csv; charset=utf-8"),
    );
    resp.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!("attachment; filename=\"{filename}\""))
            .unwrap_or_else(|_| HeaderValue::from_static("attachment")),
    );
    Ok(resp)
}

/// Small helper for tests: row map from a JSON literal.
#[cfg(test)]
pub(crate) fn row(raw: &str) -> Row {
    serde_json::from_str(raw).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use mf_types::{ColumnType, SchemaColumn};

    fn col(name: &str, t: ColumnType) -> SchemaColumn {
        SchemaColumn {
            name: name.into(),
            column_type: t,
        }
    }

    #[test]
    fn diff_matches_golden_fixture_1v1() {
        // contracts/reads/dataset-diff.json (from=1,to=1 — identical)
        let schema = vec![
            col("supplier", ColumnType::String),
            col("region", ColumnType::String),
            col("risk_score", ColumnType::Number),
            col("tier", ColumnType::String),
        ];
        let rows = vec![
            row(r#"{"supplier":"Northline Foods","region":"EMEA","risk_score":22,"tier":"A"}"#),
            row(r#"{"supplier":"Gulf Plastics","region":"EMEA","risk_score":77,"tier":"C"}"#),
        ];
        let d = compute_diff("ds1", 1, 1, &schema, &schema, rows.clone(), rows);
        assert_eq!(d["datasetId"], "ds1");
        assert_eq!(d["fromVersion"], 1);
        assert_eq!(d["toVersion"], 1);
        assert_eq!(
            d["schema"],
            json!({"added": [], "removed": [], "changed": []})
        );
        assert_eq!(d["rowCount"], json!({"from": 2, "to": 2}));
        assert_eq!(d["addedRows"], json!([]));
        assert_eq!(d["removedRows"], json!([]));
        assert_eq!(d["changedRows"], json!([]));
        assert_eq!(d["truncated"], json!(false));
    }

    #[test]
    fn diff_matches_golden_fixture_changed_row() {
        // contracts/reads/dataset-diff-2v.json — Gulf Plastics 77 → 140
        let schema = vec![
            col("supplier", ColumnType::String),
            col("risk_score", ColumnType::Number),
        ];
        let from = vec![
            row(r#"{"supplier":"Gulf Plastics","risk_score":77}"#),
            row(r#"{"supplier":"Baltic Grain Co","risk_score":15}"#),
        ];
        let to = vec![
            row(r#"{"supplier":"Gulf Plastics","risk_score":140}"#),
            row(r#"{"supplier":"Baltic Grain Co","risk_score":15}"#),
        ];
        let d = compute_diff("ds1", 1, 2, &schema, &schema, from, to);
        assert_eq!(d["addedRows"], json!([]));
        assert_eq!(d["removedRows"], json!([]));
        assert_eq!(
            d["changedRows"],
            json!([{
                "key": "Gulf Plastics",
                "before": {"supplier": "Gulf Plastics", "risk_score": 77},
                "after": {"supplier": "Gulf Plastics", "risk_score": 140},
            }])
        );
        assert_eq!(d["truncated"], json!(false));
    }

    #[test]
    fn diff_schema_changes_and_added_removed() {
        let from_schema = vec![col("a", ColumnType::String), col("b", ColumnType::String)];
        let to_schema = vec![col("a", ColumnType::Number), col("c", ColumnType::Boolean)];
        let from = vec![row(r#"{"a":"1","b":"x"}"#)];
        let to = vec![row(r#"{"a":1,"c":true}"#)];
        let d = compute_diff("d", 1, 2, &from_schema, &to_schema, from, to);
        assert_eq!(d["schema"]["added"], json!([{"name":"c","type":"boolean"}]));
        assert_eq!(
            d["schema"]["removed"],
            json!([{"name":"b","type":"string"}])
        );
        assert_eq!(
            d["schema"]["changed"],
            json!([{"name":"a","fromType":"string","toType":"number"}])
        );
        // key column = "a": String("1") === String(1) → same key → CHANGED row
        assert_eq!(d["addedRows"], json!([]));
        assert_eq!(d["removedRows"], json!([]));
        assert_eq!(d["changedRows"][0]["key"], json!("1"));
        assert_eq!(d["changedRows"][0]["after"], json!({"a":1,"c":true}));
    }

    #[test]
    fn diff_null_keys_use_empty_set_literal() {
        let schema = vec![col("k", ColumnType::String)];
        let from = vec![row(r#"{"k":null}"#)];
        let to = vec![row(r#"{"k":null,"x":1}"#)];
        let d = compute_diff("d", 1, 2, &schema, &schema, from, to);
        assert_eq!(d["changedRows"][0]["key"], json!("\u{2205}null"));
    }

    #[test]
    fn diff_caps_at_100_and_flags_truncated() {
        let schema = vec![col("k", ColumnType::Number)];
        let from: Vec<Row> = (0..150).map(|i| row(&format!(r#"{{"k":{i}}}"#))).collect();
        let to: Vec<Row> = Vec::new();
        let d = compute_diff("d", 1, 2, &schema, &schema, from, to);
        assert_eq!(d["removedRows"].as_array().unwrap().len(), 100);
        assert_eq!(d["truncated"], json!(true));
    }

    #[test]
    fn diff_without_key_column_yields_empty_row_diffs() {
        let d = compute_diff(
            "d",
            1,
            2,
            &[],
            &[],
            vec![row(r#"{"a":1}"#)],
            vec![row(r#"{"b":2}"#)],
        );
        assert_eq!(d["addedRows"], json!([]));
        assert_eq!(d["removedRows"], json!([]));
        assert_eq!(d["rowCount"], json!({"from": 1, "to": 1}));
    }
}
