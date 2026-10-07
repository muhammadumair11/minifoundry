//! Row normalization + schema inference (port of dataset-service.ts) and the
//! indexed row storage (DatasetVersionRow) read/write helpers.

use mf_types::{ColumnType, Row, SchemaColumn, Value};
use serde_json::Map;
use sqlx::PgPool;

/// Plain decimal number: "42", "-3.14", "0.5" (no scientific notation, no
/// leading '+') — the legacy NUMERIC_RE.
fn numeric_re() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"^-?(?:\d+\.?\d*|\.\d+)$").unwrap())
}

/// Leading-zero identifier guard: /^-?0\d/ (ZIP codes, "012").
fn leading_zero_re() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"^-?0\d").unwrap())
}

/// Port of `normalizeValue`: trim strings, "true"/"false" → bool,
/// numeric-looking strings → number (keeping identifier-like values exact).
pub fn normalize_value(v: Value) -> Value {
    let Value::String(s) = v else { return v };
    let t = s.trim();
    if t.is_empty() {
        return Value::String(String::new());
    }
    if t == "true" {
        return Value::Bool(true);
    }
    if t == "false" {
        return Value::Bool(false);
    }
    if numeric_re().is_match(t) && !leading_zero_re().is_match(t) {
        if let Ok(n) = t.parse::<f64>() {
            if n.is_finite() && (n.fract() != 0.0 || n.abs() <= 9_007_199_254_740_991.0) {
                return crate::jsval::js_number_value(n);
            }
        }
    }
    Value::String(t.to_string())
}

/// Port of `normalizeRows`: trim keys and normalize every cell, preserving
/// column order.
pub fn normalize_rows(rows: &[Map<String, Value>]) -> Vec<Row> {
    rows.iter()
        .map(|raw| {
            let mut row = Map::new();
            for (key, value) in raw {
                let k = if key.trim().is_empty() {
                    key.clone()
                } else {
                    key.trim().to_string()
                };
                row.insert(k, normalize_value(value.clone()));
            }
            row
        })
        .collect()
}

/// Port of `inferSchema`: column order follows first appearance; a column is
/// number/boolean only when EVERY non-null value has that type.
pub fn infer_schema(rows: &[Row]) -> Vec<SchemaColumn> {
    let mut names: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for row in rows {
        for key in row.keys() {
            if seen.insert(key.clone()) {
                names.push(key.clone());
            }
        }
    }
    names
        .into_iter()
        .map(|name| {
            let values: Vec<&Value> = rows
                .iter()
                .filter_map(|r| r.get(&name))
                .filter(|v| !v.is_null())
                .collect();
            let mut column_type = ColumnType::String;
            if !values.is_empty() && values.iter().all(|v| v.is_number()) {
                column_type = ColumnType::Number;
            } else if !values.is_empty() && values.iter().all(|v| v.is_boolean()) {
                column_type = ColumnType::Boolean;
            }
            SchemaColumn { name, column_type }
        })
        .collect()
}

/// Port of `parseJsonSafe` for TEXT-stored JSON payloads.
pub fn parse_json_text<T: serde::de::DeserializeOwned>(raw: &str, fallback: T) -> T {
    if raw.trim().is_empty() {
        return fallback;
    }
    serde_json::from_str(raw).unwrap_or(fallback)
}

/// Parse a version's data_json into rows (fallback []).
pub fn rows_from_data_json(data_json: &str) -> Vec<Row> {
    parse_json_text::<Vec<Row>>(data_json, Vec::new())
}

/// Serialize rows to the stored data_json text (compact, insertion-ordered).
pub fn data_json_string(rows: &[Row]) -> String {
    serde_json::to_string(&rows).unwrap_or_else(|_| "[]".to_string())
}

/// Port of `writeVersionRows` — batched inserts into the indexed row storage.
pub async fn write_version_rows(
    db: &PgPool,
    dataset_id: &str,
    version_number: i32,
    rows: &[Row],
) -> Result<(), sqlx::Error> {
    if rows.is_empty() {
        return Ok(());
    }
    const BATCH: usize = 500;
    let mut start = 0usize;
    for chunk in rows.chunks(BATCH) {
        let mut qb = sqlx::QueryBuilder::new(
            "INSERT INTO dataset_version_rows (id, dataset_id, version_number, row_index, row_data) ",
        );
        let base = start;
        qb.push_values(chunk.iter().enumerate(), |mut b, (idx, row)| {
            b.push_bind(mf_db::new_id())
                .push_bind(dataset_id)
                .push_bind(version_number)
                .push_bind((base + idx) as i64)
                .push_bind(serde_json::to_string(row).unwrap_or_else(|_| "{}".into()));
        });
        qb.build().execute(db).await?;
        start += chunk.len();
    }
    Ok(())
}

/// Port of `readVersionRowsPaged` — indexed storage first, dataJson fallback.
pub async fn read_version_rows_paged(
    db: &PgPool,
    dataset_id: &str,
    version_number: i32,
    page: i64,
    page_size: i64,
) -> Result<(Vec<Row>, i64), sqlx::Error> {
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM dataset_version_rows WHERE dataset_id = $1 AND version_number = $2")
            .bind(dataset_id)
            .bind(version_number)
            .fetch_one(db)
            .await?;
    if count > 0 {
        let skip = (page - 1) * page_size;
        let raw: Vec<(String,)> = sqlx::query_as(
            "SELECT row_data FROM dataset_version_rows WHERE dataset_id = $1 AND version_number = $2 \
             ORDER BY row_index ASC LIMIT $3 OFFSET $4",
        )
        .bind(dataset_id)
        .bind(version_number)
        .bind(page_size)
        .bind(skip)
        .fetch_all(db)
        .await?;
        let rows = raw
            .into_iter()
            .map(|(data,)| parse_json_text::<Row>(&data, Map::new()))
            .collect();
        return Ok((rows, count));
    }
    // Fallback: parse dataJson from the version record.
    let version: Option<(String, i32)> = sqlx::query_as(
        "SELECT data_json, row_count FROM dataset_versions WHERE dataset_id = $1 AND version_number = $2",
    )
    .bind(dataset_id)
    .bind(version_number)
    .fetch_optional(db)
    .await?;
    let Some((data_json, row_count)) = version else {
        return Ok((Vec::new(), 0));
    };
    let all = rows_from_data_json(&data_json);
    let start = ((page - 1) * page_size).max(0) as usize;
    let end = start.saturating_add(page_size.max(0) as usize).min(all.len());
    let rows = if start < all.len() { all[start..end].to_vec() } else { Vec::new() };
    Ok((rows, row_count as i64))
}

/// All rows of a version (indexed storage when present, dataJson otherwise).
pub async fn read_version_rows_all(
    db: &PgPool,
    dataset_id: &str,
    version_number: i32,
    data_json: &str,
) -> Result<Vec<Row>, sqlx::Error> {
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM dataset_version_rows WHERE dataset_id = $1 AND version_number = $2")
            .bind(dataset_id)
            .bind(version_number)
            .fetch_one(db)
            .await?;
    if count > 0 {
        let raw: Vec<(String,)> = sqlx::query_as(
            "SELECT row_data FROM dataset_version_rows WHERE dataset_id = $1 AND version_number = $2 \
             ORDER BY row_index ASC",
        )
        .bind(dataset_id)
        .bind(version_number)
        .fetch_all(db)
        .await?;
        return Ok(raw
            .into_iter()
            .map(|(data,)| parse_json_text::<Row>(&data, Map::new()))
            .collect());
    }
    Ok(rows_from_data_json(data_json))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row(raw: &str) -> Row {
        serde_json::from_str(raw).unwrap()
    }

    #[test]
    fn normalize_value_matches_legacy() {
        assert_eq!(normalize_value(json!("  hi  ")), json!("hi"));
        assert_eq!(normalize_value(json!("true")), json!(true));
        assert_eq!(normalize_value(json!("False")), json!("False"));
        assert_eq!(normalize_value(json!("42")), json!(42));
        assert_eq!(normalize_value(json!("-3.25")), json!(-3.25));
        assert_eq!(normalize_value(json!(".5")), json!(0.5));
        // identifier-like values stay exact strings
        assert_eq!(normalize_value(json!("0123")), json!("0123"));
        assert_eq!(normalize_value(json!("-0123")), json!("-0123"));
        // no scientific notation / leading +
        assert_eq!(normalize_value(json!("1e5")), json!("1e5"));
        assert_eq!(normalize_value(json!("+5")), json!("+5"));
        // empty stays empty string; non-strings pass through
        assert_eq!(normalize_value(json!("   ")), json!(""));
        assert_eq!(normalize_value(json!("")), json!(""));
        assert_eq!(normalize_value(json!(7)), json!(7));
        assert_eq!(normalize_value(Value::Null), Value::Null);
        assert_eq!(normalize_value(json!({"a":1})), json!({"a":1}));
    }

    #[test]
    fn normalize_trims_keys_preserving_order() {
        let raw = row(r#"{" b ": 1, "a": " x ", "": 2}"#);
        let out = normalize_rows(&[raw])[0].clone();
        let keys: Vec<&String> = out.keys().collect();
        assert_eq!(keys, vec!["b", "a", ""]);
        assert_eq!(out["a"], json!("x"));
        assert_eq!(out["b"], json!(1));
    }

    #[test]
    fn infer_schema_widening_and_order() {
        let rows = vec![
            row(r#"{"id":"1","n":"5","b":"true","s":"x"}"#),
            row(r#"{"n":6,"extra":null,"id":"2","b":"false"}"#),
        ];
        let rows = normalize_rows(&rows);
        let schema = infer_schema(&rows);
        let names: Vec<&str> = schema.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["id", "n", "b", "s", "extra"]);
        // "1"/"2" normalize to numbers → id is number; s only appears once
        assert_eq!(schema[0].column_type, ColumnType::Number);
        assert_eq!(schema[1].column_type, ColumnType::Number);
        assert_eq!(schema[2].column_type, ColumnType::Boolean);
        assert_eq!(schema[3].column_type, ColumnType::String);
        assert_eq!(schema[4].column_type, ColumnType::String); // all-null → string
    }

    #[test]
    fn infer_schema_types() {
        // numbers only when EVERY non-null value is a number
        let rows = vec![row(r#"{"n":1,"m":2}"#), row(r#"{"n":"3"}"#)];
        let schema = infer_schema(&rows);
        assert_eq!(schema[0].column_type, ColumnType::String); // mixed → string
        assert_eq!(schema[1].column_type, ColumnType::Number);
        // nulls are ignored
        let rows = vec![row(r#"{"b":true}"#), row(r#"{"b":null}"#)];
        assert_eq!(infer_schema(&rows)[0].column_type, ColumnType::Boolean);
        // all-null column → string
        let rows = vec![row(r#"{"z":null}"#)];
        assert_eq!(infer_schema(&rows)[0].column_type, ColumnType::String);
        // empty rows → empty schema
        assert!(infer_schema(&[]).is_empty());
    }

    #[test]
    fn risk_dataset_schema_matches_fixture() {
        let rows = normalize_rows(&[
            row(r#"{"supplier":"Northline Foods","region":"EMEA","risk_score":22,"tier":"A"}"#),
        ]);
        let schema = infer_schema(&rows);
        let v = serde_json::to_value(&schema).unwrap();
        assert_eq!(
            v,
            json!([
                {"name":"supplier","type":"string"},
                {"name":"region","type":"string"},
                {"name":"risk_score","type":"number"},
                {"name":"tier","type":"string"}
            ])
        );
    }

    #[test]
    fn parse_json_text_fallback() {
        assert_eq!(parse_json_text::<Vec<Row>>("", vec![]).len(), 0);
        assert_eq!(parse_json_text::<Vec<Row>>("nope", vec![]).len(), 0);
        assert_eq!(rows_from_data_json(r#"[{"a":1}]"#).len(), 1);
        assert_eq!(data_json_string(&[row(r#"{"z":1,"a":2}"#)]), r#"[{"z":1,"a":2}]"#);
    }
}
