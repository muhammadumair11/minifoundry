//! Column-marking masking (port of governance.ts applyMasking/maskSchema).
//!
//! Markings live in the governance service; catalog fetches them over the
//! internal API for every row-egress path:
//!   • PUBLIC routes (/api/datasets/{id}/rows|diff|export) ALWAYS mask at the
//!     CALLER's actor role; a governance outage degrades to "no markings"
//!     (never fails the request — legacy in-process reads never failed either).
//!   • INTERNAL rows endpoints mask only when the caller passes `role=<r>`
//!     (see contracts/INTERNAL_API.md); governance outage → warn + raw rows.

use mf_types::{Row, SchemaColumn, Value};
use serde::Deserialize;

use crate::state::AppState;

/// 6 dashes — mono-friendly masked cell literal (legacy MASK_LITERAL).
pub const MASK_LITERAL: &str = "------";

/// One column marking as served by governance
/// GET /internal/markings/dataset/{id}.
#[allow(dead_code)] // color is part of the governance contract payload
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMarkingInfo {
    pub column_name: String,
    pub marking_name: String,
    pub min_role: String,
    #[serde(default)]
    pub color: String,
}

/// Fetch a dataset's column markings from governance. TOLERANT: any transport
/// error or non-2xx (governance not running yet / dataset unmarked → 404)
/// yields an empty list — masking then degrades to a no-op, never an error.
pub async fn fetch_markings(state: &AppState, dataset_id: &str) -> Vec<ColumnMarkingInfo> {
    let path = format!("/internal/markings/dataset/{dataset_id}");
    match state.governance.get_json::<Vec<ColumnMarkingInfo>>(&path).await {
        Ok(mut markings) => {
            // legacy getColumnMarkings ordered by columnName asc
            markings.sort_by(|a, b| a.column_name.cmp(&b.column_name));
            markings
        }
        Err(e) => {
            tracing::debug!(dataset_id, error = %e, "governance markings unavailable; treating as unmarked");
            Vec::new()
        }
    }
}

/// Column names whose marking minRole is above the given role's level.
/// Unknown minRole values rank 99 (mask from everyone) — legacy rule.
pub fn masked_columns_for(markings: &[ColumnMarkingInfo], role: &str) -> Vec<String> {
    let role_lvl = mf_auth::role_level(role);
    markings
        .iter()
        .filter(|m| {
            let lvl = match m.min_role.as_str() {
                "viewer" | "editor" | "admin" => mf_auth::role_level(&m.min_role),
                _ => 99,
            };
            lvl > role_lvl
        })
        .map(|m| m.column_name.clone())
        .collect()
}

/// Port of `applyMasking`: replace masked-column values with MASK_LITERAL in
/// every row (key order preserved; new row objects, input never mutated).
/// Returns the rows plus the masked column names.
pub fn apply_masking(rows: Vec<Row>, masked_columns: &[String]) -> (Vec<Row>, Vec<String>) {
    if masked_columns.is_empty() || rows.is_empty() {
        return (rows, masked_columns.to_vec());
    }
    let masked: std::collections::HashSet<&str> =
        masked_columns.iter().map(|s| s.as_str()).collect();
    let out = rows
        .into_iter()
        .map(|row| {
            let mut changed = false;
            let mut out = serde_json::Map::new();
            for (key, value) in &row {
                if masked.contains(key.as_str()) {
                    out.insert(key.clone(), Value::String(MASK_LITERAL.to_string()));
                    changed = true;
                } else {
                    out.insert(key.clone(), value.clone());
                }
            }
            if changed {
                out
            } else {
                row
            }
        })
        .collect();
    (out, masked_columns.to_vec())
}

/// Port of `maskSchema`: additive `markedWith` per column (marking name or
/// null) — role-independent, used by dataset detail + rows endpoints.
pub fn mask_schema(columns: &[SchemaColumn], markings: &[ColumnMarkingInfo]) -> Vec<Value> {
    columns
        .iter()
        .map(|c| {
            let marked_with = markings
                .iter()
                .find(|m| m.column_name == c.name)
                .map(|m| Value::String(m.marking_name.clone()))
                .unwrap_or(Value::Null);
            serde_json::json!({
                "name": c.name,
                "type": c.column_type,
                "markedWith": marked_with,
            })
        })
        .collect()
}

/// PUBLIC-route masking: always applied at the caller's role; governance
/// outage → empty markings (rows pass through unchanged).
pub async fn mask_rows_public(
    state: &AppState,
    dataset_id: &str,
    rows: Vec<Row>,
    role: &str,
) -> (Vec<Row>, Vec<String>) {
    let markings = fetch_markings(state, dataset_id).await;
    let masked_columns = masked_columns_for(&markings, role);
    apply_masking(rows, &masked_columns)
}

/// INTERNAL-route masking (opt-in `role` query param): None → raw rows with
/// no governance call. Some(role) → mask; governance outage → warn + raw
/// (tolerant degradation per INTERNAL_API.md).
pub async fn mask_rows_internal(
    state: &AppState,
    dataset_id: &str,
    rows: Vec<Row>,
    role: Option<&str>,
) -> Vec<Row> {
    let Some(role) = role else { return rows };
    let path = format!("/internal/markings/dataset/{dataset_id}");
    let markings = match state.governance.get_json::<Vec<ColumnMarkingInfo>>(&path).await {
        Ok(mut m) => {
            m.sort_by(|a, b| a.column_name.cmp(&b.column_name));
            m
        }
        Err(e) => {
            tracing::warn!(
                dataset_id,
                error = %e,
                "governance markings unreachable while role masking requested; returning raw rows"
            );
            return rows;
        }
    };
    let masked_columns = masked_columns_for(&markings, role);
    apply_masking(rows, &masked_columns).0
}

#[cfg(test)]
mod tests {
    use super::*;
    use mf_types::ColumnType;
    use serde_json::json;

    fn marking(col: &str, min_role: &str, name: &str) -> ColumnMarkingInfo {
        ColumnMarkingInfo {
            column_name: col.into(),
            marking_name: name.into(),
            min_role: min_role.into(),
            color: "rose".into(),
        }
    }

    fn row(raw: &str) -> Row {
        serde_json::from_str(raw).unwrap()
    }

    #[test]
    fn masked_columns_by_role_level() {
        let markings = vec![
            marking("salary", "admin", "PII"),
            marking("email", "editor", "Contact"),
            marking("weird", "overseer", "X"),
        ];
        // order follows the (columnName-sorted) input; levels filter per role
        assert_eq!(masked_columns_for(&markings, "viewer"), vec!["salary", "email", "weird"]);
        assert_eq!(masked_columns_for(&markings, "editor"), vec!["salary", "weird"]);
        assert_eq!(masked_columns_for(&markings, "admin"), vec!["weird"]); // unknown minRole masks from everyone
        assert_eq!(masked_columns_for(&markings, "anonymous").len(), 3);
    }

    #[test]
    fn apply_masking_replaces_values_preserving_order() {
        let rows = vec![row(r#"{"a":1,"secret":"x","b":true}"#)];
        let (out, cols) = apply_masking(rows, &["secret".to_string()]);
        assert_eq!(cols, vec!["secret"]);
        let keys: Vec<&String> = out[0].keys().collect();
        assert_eq!(keys, vec!["a", "secret", "b"]);
        assert_eq!(out[0]["secret"], json!("------"));
        assert_eq!(out[0]["a"], json!(1));
    }

    #[test]
    fn apply_masking_noop_paths() {
        let rows = vec![row(r#"{"a":1}"#)];
        let (out, cols) = apply_masking(rows.clone(), &[]);
        assert_eq!(out, rows);
        assert!(cols.is_empty());
        // masked column absent from rows → still reported
        let (_, cols) = apply_masking(rows, &["zzz".to_string()]);
        assert_eq!(cols, vec!["zzz"]);
    }

    #[test]
    fn mask_schema_adds_marked_with() {
        let columns = vec![
            SchemaColumn { name: "a".into(), column_type: ColumnType::String },
            SchemaColumn { name: "secret".into(), column_type: ColumnType::Number },
        ];
        let markings = vec![marking("secret", "admin", "PII")];
        let out = mask_schema(&columns, &markings);
        assert_eq!(
            out,
            vec![
                json!({"name": "a", "type": "string", "markedWith": null}),
                json!({"name": "secret", "type": "number", "markedWith": "PII"}),
            ]
        );
        // key order matters for the fixture contract
        assert_eq!(
            serde_json::to_string(&out[1]).unwrap(),
            r#"{"name":"secret","type":"number","markedWith":"PII"}"#
        );
    }
}
