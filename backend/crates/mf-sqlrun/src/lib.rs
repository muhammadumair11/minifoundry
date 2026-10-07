//! MiniFoundry — ephemeral SQLite execution for SQL workbooks.
//!
//! Port of `executeSqlIsolated()` in `src/lib/isolated-runner.ts`:
//! - in-memory SQLite that NEVER touches the app database;
//! - input tables materialized with ALL columns as TEXT and values stringified
//!   (`typeof v === 'string' ? v : String(v)`; null → NULL);
//! - single statement only; must start with SELECT or WITH (after trimming
//!   trailing semicolons); inner `;` rejected;
//! - result rows capped (`DEFAULT_MAX_ROWS = 50_000`);
//! - cells sanitized to JSON-serializable values.
//!
//! The full execution body is completed in Phase 4 (compute service) together
//! with the cell-type normalization tests captured from the legacy engine;
//! this skeleton fixes the public contract and validation rules.

use mf_types::Row;
use serde_json::Value;

#[derive(Debug, thiserror::Error)]
pub enum SqlError {
    #[error("Only SELECT statements are allowed in isolated SQL execution")]
    NotSelect,
    #[error("Multiple statements are not allowed")]
    MultipleStatements,
    #[error("SQL result has {rows} rows; limit is {limit}")]
    RowLimit { rows: usize, limit: usize },
    #[error("{0}")]
    Engine(String),
}

/// One materialized input table (name already sanitized by the caller —
/// `sanitizeTableName`: lowercase, non [a-z0-9_] → `_`, collision suffixes).
#[derive(Debug, Clone)]
pub struct SqlInputTable {
    pub name: String,
    pub columns: Vec<String>,
    pub rows: Vec<Row>,
}

#[derive(Debug, Clone)]
pub struct SqlRunOptions {
    pub max_rows: usize,
}

impl Default for SqlRunOptions {
    fn default() -> Self {
        Self { max_rows: 50_000 }
    }
}

/// Sanitize a dataset name into a safe table base name (legacy
/// `sanitizeTableName`): lowercase, every non-[a-z0-9_] char becomes `_`.
pub fn sanitize_table_name(name: &str) -> String {
    let out: String = name
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if out.is_empty() {
        "table".into()
    } else {
        out
    }
}

/// Quote a SQL identifier (`"` → `""` inside the quotes).
pub fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Validate the statement shape (legacy rules) — returns the trimmed SQL.
pub fn validate_statement(sql: &str) -> Result<String, SqlError> {
    let trimmed = sql.trim().trim_end_matches(';').trim().to_string();
    let lower = trimmed.to_lowercase();
    if !(lower.starts_with("select") && is_word_boundary(&lower, 6))
        && !(lower.starts_with("with") && is_word_boundary(&lower, 4))
    {
        return Err(SqlError::NotSelect);
    }
    if trimmed.contains(';') {
        return Err(SqlError::MultipleStatements);
    }
    Ok(trimmed)
}

fn is_word_boundary(s: &str, len: usize) -> bool {
    match s.as_bytes().get(len) {
        None => true,
        Some(b) => !(b.is_ascii_alphanumeric() || *b == b'_'),
    }
}

/// Convert a cell value into its TEXT materialization (legacy semantics:
/// null/undefined → NULL; strings pass through; everything else String(v)).
pub fn to_text_param(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        Value::Bool(b) => Some(if *b { "true".into() } else { "false".into() }),
        Value::Number(n) => Some(n.to_string()),
        other => Some(other.to_string()),
    }
}

/// Execute a validated SELECT against an ephemeral in-memory database
/// containing exactly `inputs`. Full implementation lands in Phase 4.
pub fn execute_sql_isolated(
    sql: &str,
    inputs: &[SqlInputTable],
    options: Option<SqlRunOptions>,
) -> Result<Vec<Row>, SqlError> {
    let opts = options.unwrap_or_default();
    let statement = validate_statement(sql)?;

    let conn =
        rusqlite::Connection::open_in_memory().map_err(|e| SqlError::Engine(e.to_string()))?;
    for input in inputs {
        if input.columns.is_empty() {
            continue;
        }
        let col_defs: Vec<String> = input
            .columns
            .iter()
            .map(|c| format!("{} TEXT", quote_ident(c)))
            .collect();
        let create = format!(
            "CREATE TABLE {} ({})",
            quote_ident(&input.name),
            col_defs.join(", ")
        );
        conn.execute_batch(&create)
            .map_err(|e| SqlError::Engine(e.to_string()))?;
        if input.rows.is_empty() {
            continue;
        }
        let placeholders = vec!["?"; input.columns.len()].join(", ");
        let insert = format!(
            "INSERT INTO {} VALUES ({})",
            quote_ident(&input.name),
            placeholders
        );
        let mut stmt = conn
            .prepare(&insert)
            .map_err(|e| SqlError::Engine(e.to_string()))?;
        for row in &input.rows {
            let values: Vec<Option<String>> = input
                .columns
                .iter()
                .map(|c| row.get(c).map(to_text_param).unwrap_or(None))
                .collect();
            let params: Vec<&dyn rusqlite::ToSql> =
                values.iter().map(|v| v as &dyn rusqlite::ToSql).collect();
            stmt.execute(params.as_slice())
                .map_err(|e| SqlError::Engine(e.to_string()))?;
        }
    }

    let mut stmt = conn
        .prepare(&statement)
        .map_err(|e| SqlError::Engine(e.to_string()))?;
    let col_count = stmt.column_count();
    let col_names: Vec<String> = (0..col_count)
        .map(|i| stmt.column_name(i).unwrap_or("?").to_string())
        .collect();
    let raw = stmt
        .query_map([], |r| {
            let mut out = Vec::with_capacity(col_count);
            for (i, name) in col_names.iter().enumerate() {
                // Legacy cell mapping (isolated-runner.ts lines 78-84):
                //   v == null ? null
                //     : typeof v === 'number' || typeof v === 'boolean' ? v
                //     : String(v)
                // node:sqlite hands back number for INTEGER/REAL, string for
                // TEXT, Uint8Array for BLOB (String(Uint8Array) = comma-joined
                // decimal bytes in JS). JS numbers have no int/float split —
                // whole REALs must serialize as `3`, not `3.0`.
                let v = match r.get_ref(i)? {
                    rusqlite::types::ValueRef::Null => Value::Null,
                    rusqlite::types::ValueRef::Integer(n) => Value::Number(n.into()),
                    rusqlite::types::ValueRef::Real(f) => {
                        if f.fract() == 0.0 && f >= i64::MIN as f64 && f <= i64::MAX as f64 {
                            Value::Number((f as i64).into())
                        } else {
                            serde_json::Number::from_f64(f)
                                .map(Value::Number)
                                .unwrap_or(Value::Null)
                        }
                    }
                    rusqlite::types::ValueRef::Text(t) => {
                        Value::String(String::from_utf8_lossy(t).into_owned())
                    }
                    rusqlite::types::ValueRef::Blob(b) => {
                        let joined: Vec<String> = b.iter().map(|byte| byte.to_string()).collect();
                        Value::String(joined.join(","))
                    }
                };
                out.push((name.clone(), v));
            }
            Ok(out)
        })
        .map_err(|e| SqlError::Engine(e.to_string()))?;

    let mut rows: Vec<Row> = Vec::new();
    for mapped in raw {
        let cells = mapped.map_err(|e| SqlError::Engine(e.to_string()))?;
        let mut row = Row::new();
        for (k, v) in cells {
            row.insert(k, v);
        }
        rows.push(row);
        if rows.len() > opts.max_rows {
            return Err(SqlError::RowLimit {
                rows: rows.len(),
                limit: opts.max_rows,
            });
        }
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table(rows: &[(&str, &str)]) -> SqlInputTable {
        SqlInputTable {
            name: "shipments".into(),
            columns: vec!["id".into(), "city".into()],
            rows: rows
                .iter()
                .map(|(id, city)| {
                    let mut r = Row::new();
                    r.insert("id".into(), Value::String(id.to_string()));
                    r.insert("city".into(), Value::String(city.to_string()));
                    r
                })
                .collect(),
        }
    }

    #[test]
    fn validate_rules() {
        assert!(validate_statement("SELECT 1").is_ok());
        assert!(validate_statement("  select * from t;  ").is_ok());
        assert!(validate_statement("WITH x AS (SELECT 1) SELECT * FROM x").is_ok());
        assert!(matches!(
            validate_statement("UPDATE t SET a=1"),
            Err(SqlError::NotSelect)
        ));
        assert!(matches!(
            validate_statement("DELETE FROM t"),
            Err(SqlError::NotSelect)
        ));
        assert!(matches!(
            validate_statement("SELECT 1; DROP TABLE t"),
            Err(SqlError::MultipleStatements)
        ));
        assert!(matches!(
            validate_statement("selectx 1"),
            Err(SqlError::NotSelect)
        ));
    }

    #[test]
    fn sanitize_names() {
        assert_eq!(sanitize_table_name("Shipments"), "shipments");
        assert_eq!(sanitize_table_name("Active Shipments"), "active_shipments");
        assert_eq!(sanitize_table_name(""), "table");
        assert_eq!(quote_ident("we\"ird"), "\"we\"\"ird\"");
    }

    #[test]
    fn executes_select_over_materialized_inputs() {
        let inputs = vec![table(&[("1", "berlin"), ("2", "paris")])];
        let rows =
            execute_sql_isolated("SELECT id, city FROM shipments ORDER BY id", &inputs, None)
                .unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].get("city").unwrap(), "berlin");
    }

    #[test]
    fn row_limit_enforced() {
        let inputs = vec![table(&[("1", "a"), ("2", "b"), ("3", "c")])];
        let err = execute_sql_isolated(
            "SELECT * FROM shipments",
            &inputs,
            Some(SqlRunOptions { max_rows: 2 }),
        )
        .unwrap_err();
        assert!(matches!(err, SqlError::RowLimit { .. }));
    }
}
