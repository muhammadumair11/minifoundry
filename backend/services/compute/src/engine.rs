//! Port of `src/lib/transform-engine.ts` — the M4 workbook run lifecycle.
//!
//! Creates the TransformRun row first, resolves input dataset versions via
//! the catalog internal API, dispatches by language (SQL → mf-sqlrun
//! ephemeral SQLite; JavaScript → mf-js sandbox; Python → isolated
//! subprocess), publishes the result rows as a NEW version of the output
//! dataset through catalog's single write door, then finalizes the run
//! (status, logs, duration, outputs, manifest snapshot).
//!
//! Never fails the HTTP request for user-code/validation errors: those are
//! recorded on the run (status failed + error + logs) so callers always get a
//! run back — legacy `runTransform` contract.

use crate::catalog;
use crate::python::execute_python_isolated;
use crate::state::{AppState, TransformRunRow, RUN_COLS};
use mf_internal::ServiceClient;
use mf_sqlrun::{execute_sql_isolated, sanitize_table_name, SqlInputTable, SqlRunOptions};
use mf_types::{LogEntry, LogLevel, Row, SchemaColumn, Value};
use serde::{Deserialize, Serialize};
use sqlx::types::Json;
use std::collections::{HashMap, HashSet};
use std::time::Duration;

// ─── Limits (dataset-service.ts MAX_ROWS) ───────────────────────────────

/// `Number(process.env.MAX_ROWS) || 5000` — learning-scale row cap shared by
/// the runner limits and the post-execution check.
pub fn max_rows() -> usize {
    std::env::var("MAX_ROWS")
        .ok()
        .and_then(|v| v.trim().parse::<f64>().ok())
        .filter(|n| n.is_finite() && *n > 0.0)
        .map(|n| n as usize)
        .unwrap_or(5000)
}

/// Legacy JS call-site limit (transform-engine.ts: timeoutMs 5000).
pub const JS_TIMEOUT_MS: u64 = 5_000;
/// Legacy Python call-site limit (transform-engine.ts: timeoutMs 10000).
pub const PYTHON_TIMEOUT_MS: u64 = 10_000;

// ─── Run logs ───────────────────────────────────────────────────────────

/// Accumulating run log (`logs: LogEntry[]` + `log(level, msg)` in legacy).
#[derive(Default)]
pub struct RunLog {
    pub entries: Vec<LogEntry>,
}

impl RunLog {
    pub fn push(&mut self, level: LogLevel, msg: impl Into<String>) {
        self.entries.push(LogEntry::new(level, msg));
    }
    pub fn info(&mut self, msg: impl Into<String>) {
        self.push(LogLevel::Info, msg);
    }
    pub fn warn(&mut self, msg: impl Into<String>) {
        self.push(LogLevel::Warn, msg);
    }
    pub fn error(&mut self, msg: impl Into<String>) {
        self.push(LogLevel::Error, msg);
    }
    pub fn success(&mut self, msg: impl Into<String>) {
        self.push(LogLevel::Success, msg);
    }
}

// ─── Manifest (replay/provenance snapshot) ──────────────────────────────

/// Port of `TransformManifest` — exact JSON key order and casing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransformManifest {
    pub transform_id: String,
    pub language: String,
    pub source_code: String,
    pub output_dataset_name: String,
    pub configured_inputs: Vec<String>,
    pub inputs: Vec<ManifestInput>,
    pub output_dataset_id: Option<String>,
    pub output_version_number: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestInput {
    pub dataset_id: String,
    pub version_number: i64,
}

// ─── Run inputs (what the engine executes) ──────────────────────────────

/// The code/config a run executes: either the live transform row or the
/// replay snapshot (manifest language/sourceCode/outputDatasetName/inputs).
#[derive(Debug, Clone)]
pub struct TransformSnapshot {
    pub id: String,
    pub language: String,
    pub source_code: String,
    pub input_ids: Vec<String>,
    pub output_dataset_name: String,
}

/// Port of `TransformRunOptions`.
#[derive(Debug, Default, Clone)]
pub struct RunOptions {
    /// datasetId → pinned versionNumber (replay runs).
    pub input_overrides: Option<HashMap<String, i64>>,
    pub replay_of_run_id: Option<String>,
}

/// Port of `LoadedInput`.
#[derive(Debug, Clone)]
pub struct LoadedInput {
    pub dataset_id: String,
    pub name: String,
    pub version_number: i64,
    pub rows: Vec<Row>,
    pub schema: Vec<SchemaColumn>,
}

// ─── Table-name helpers (sanitize + collision suffixes) ─────────────────

/// Prisma's own tables lived in the SAME SQLite file as the materialized
/// inputs in the legacy shared-db implementation; names colliding with them
/// (or sqlite internals) were forced to a _2 suffix. The ephemeral database
/// makes the list moot, but the suffix behavior is contract-visible (a
/// dataset named "Dataset" materializes as `dataset_2`) — kept exactly.
pub const PROTECTED_TABLES: &[&str] = &[
    "project",
    "connector",
    "ingestion",
    "dataset",
    "datasetversion",
    "pipeline",
    "pipelinerun",
    "schedule",
    "objecttype",
    "property",
    "linktype",
    "actiontype",
    "actionlog",
    "lineageedge",
    "marking",
    "columnmarking",
    "approvalrequest",
    "auditentry",
    "transform",
    "transformrun",
    "_prisma_migrations",
    "sqlite_sequence",
    "sqlite_stat1",
    "sqlite_schema",
    "sqlite_master",
];

/// Exact port of the legacy `materializeInputs` naming loop:
/// ```text
/// base = sanitizeTableName(name); table = base; n = 2
/// while (used.has(table) || PROTECTED_TABLES.has(table)) table = `${base}_${n++}`
/// used.add(table)
/// ```
/// (sanitizeTableName already lowercases, matching the legacy `.toLowerCase()`
/// set lookups.)
pub fn assign_table_names(names: &[String]) -> Vec<String> {
    let protected: HashSet<&str> = PROTECTED_TABLES.iter().copied().collect();
    let mut used: HashSet<String> = HashSet::new();
    let mut out = Vec::with_capacity(names.len());
    for name in names {
        let base = sanitize_table_name(name);
        let mut table = base.clone();
        let mut n = 2;
        while used.contains(&table) || protected.contains(table.as_str()) {
            table = format!("{base}_{n}");
            n += 1;
        }
        used.insert(table.clone());
        out.push(table);
    }
    out
}

/// Build the materialized SQL input tables (names via assign_table_names,
/// columns = schema column names, rows passed through — mf-sqlrun does the
/// all-TEXT cell mapping).
pub fn build_sql_inputs(inputs: &[LoadedInput]) -> Vec<SqlInputTable> {
    let names: Vec<String> = inputs.iter().map(|i| i.name.clone()).collect();
    let table_names = assign_table_names(&names);
    inputs
        .iter()
        .zip(table_names)
        .map(|(input, name)| SqlInputTable {
            name,
            columns: input.schema.iter().map(|c| c.name.clone()).collect(),
            rows: input.rows.clone(),
        })
        .collect()
}

// ─── SQL validation (engine-level, transform-engine.ts) ─────────────────

/// Strip leading `--` line comments and `/* */` block comments so the first
/// keyword is visible (port of stripLeadingComments).
pub fn strip_leading_comments(sql: &str) -> String {
    let mut s = sql.trim_start();
    loop {
        if let Some(rest) = s.strip_prefix("--") {
            match rest.find('\n') {
                Some(i) => {
                    s = rest[i + 1..].trim_start();
                    continue;
                }
                None => return String::new(),
            }
        }
        if let Some(rest) = s.strip_prefix("/*") {
            match rest.find("*/") {
                Some(i) => {
                    s = rest[i + 2..].trim_start();
                    continue;
                }
                None => return String::new(),
            }
        }
        return s.to_string();
    }
}

/// True when the SQL contains a statement-terminating ';' outside string
/// literals ('' escapes inside single quotes, port of the legacy scanner).
pub fn has_semicolon_outside_quotes(sql: &str) -> bool {
    let chars: Vec<char> = sql.chars().collect();
    let (mut in_single, mut in_double) = (false, false);
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if in_single {
            if c == '\'' {
                if chars.get(i + 1) == Some(&'\'') {
                    i += 1; // escaped ''
                } else {
                    in_single = false;
                }
            }
        } else if in_double {
            if c == '"' {
                in_double = false;
            }
        } else if c == '\'' {
            in_single = true;
        } else if c == '"' {
            in_double = true;
        } else if c == ';' {
            return true;
        }
        i += 1;
    }
    false
}

/// Port of `validateSql`: trim, strip ONE trailing ';', reject empty SQL,
/// multi-statement SQL and anything that is not SELECT/WITH (leading comments
/// skipped). Exact legacy error strings.
pub fn validate_sql(raw: &str, log: &mut RunLog) -> Result<String, String> {
    log.info("validating SQL (SELECT/WITH only, single statement)");
    let mut sql = raw.trim().to_string();
    if sql.ends_with(';') {
        sql = sql[..sql.len() - 1].trim_end().to_string();
    }
    if sql.is_empty() {
        return Err("SQL is empty".to_string());
    }
    if has_semicolon_outside_quotes(&sql) {
        return Err(
            "bad SQL: multiple statements are not allowed (found \";\" mid-query)".to_string(),
        );
    }
    let body = strip_leading_comments(&sql);
    let first_word: String = body
        .chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect::<String>()
        .to_lowercase();
    if first_word != "select" && first_word != "with" {
        let shown = if first_word.is_empty() {
            "—".to_string()
        } else {
            first_word
        };
        return Err(format!(
            "bad SQL: only SELECT or WITH queries are allowed (first word: \"{shown}\")"
        ));
    }
    Ok(sql)
}

// ─── Input loading (loadInputs) ─────────────────────────────────────────

/// Port of `loadInputs`: resolve every configured input dataset id (in
/// order) to its consumer version (or the pinned override), reading rows +
/// schema from the catalog. Missing datasets/versions skip with a warn log —
/// EXCEPT pinned ones, which fail the run with the exact legacy messages.
pub async fn load_inputs(
    catalog_client: &ServiceClient,
    input_ids: &[String],
    overrides: Option<&HashMap<String, i64>>,
    log: &mut RunLog,
) -> Result<Vec<LoadedInput>, String> {
    let mut loaded: Vec<LoadedInput> = Vec::new();
    if input_ids.is_empty() {
        log.warn("no input datasets configured");
    }
    for id in input_ids {
        let pinned = overrides.and_then(|m| m.get(id)).copied();
        let dataset = catalog::get_dataset(catalog_client, id)
            .await
            .map_err(|e| e.to_string())?;
        let Some(dataset) = dataset else {
            if pinned.is_some() {
                return Err(format!("Pinned input dataset '{id}' no longer exists"));
            }
            log.warn(format!("input dataset '{id}' no longer exists — skipped"));
            continue;
        };
        let name = dataset
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        // Version resolution: pinned number wins; otherwise the catalog's
        // head endpoint resolves the consumer version (gate-aware) exactly
        // like legacy resolveConsumerVersion + getDatasetVersion.
        let (meta, version_number) = match pinned {
            Some(n) => {
                let Some(meta) = catalog::get_version(catalog_client, id, &n.to_string())
                    .await
                    .map_err(|e| e.to_string())?
                else {
                    return Err(format!(
                        "Pinned input dataset '{id}' v{n} no longer exists"
                    ));
                };
                (meta, n)
            }
            None => {
                let Some(meta) = catalog::get_version(catalog_client, id, "head")
                    .await
                    .map_err(|e| e.to_string())?
                else {
                    log.warn(format!("input \"{name}\" has no versions — skipped"));
                    continue;
                };
                match meta.get("versionNumber").and_then(|v| v.as_i64()) {
                    Some(n) => (meta, n),
                    None => {
                        log.warn(format!("input \"{name}\" has no versions — skipped"));
                        continue;
                    }
                }
            }
        };

        let rows = catalog::get_rows_all(catalog_client, id, &version_number.to_string())
            .await
            .map_err(|e| e.to_string())?;
        let schema = catalog::version_schema(&meta);
        log.info(format!(
            "loaded input \"{name}\" v{version_number} ({} rows)",
            rows.len()
        ));
        loaded.push(LoadedInput {
            dataset_id: id.clone(),
            name,
            version_number,
            rows,
            schema,
        });
    }
    Ok(loaded)
}

/// The `{ rows, datasets, schemas }` input object handed to JS/Python
/// workbooks (rows = the FIRST input's rows; datasets/schemas keyed by
/// dataset name — duplicate names: last wins, like Object.fromEntries).
pub fn build_script_input(inputs: &[LoadedInput]) -> Value {
    let first_rows: Vec<Value> = inputs
        .first()
        .map(|i| i.rows.iter().map(|r| Value::Object(r.clone())).collect())
        .unwrap_or_default();
    let mut datasets = mf_types::Map::new();
    let mut schemas = mf_types::Map::new();
    for input in inputs {
        datasets.insert(
            input.name.clone(),
            Value::Array(input.rows.iter().map(|r| Value::Object(r.clone())).collect()),
        );
        schemas.insert(
            input.name.clone(),
            serde_json::to_value(&input.schema).unwrap_or(Value::Array(Vec::new())),
        );
    }
    Value::Object({
        let mut m = mf_types::Map::new();
        m.insert("rows".into(), Value::Array(first_rows));
        m.insert("datasets".into(), Value::Object(datasets));
        m.insert("schemas".into(), Value::Object(schemas));
        m
    })
}

// ─── Main entry (runTransform) ──────────────────────────────────────────

/// Run a transform synchronously: create the run row, execute, publish the
/// output version, finalize. Only INFRASTRUCTURE failures (run-row writes)
/// bubble up as Err; user-code/validation/catalog failures are recorded on
/// the returned run (status failed + error + logs).
pub async fn run_transform(
    state: &AppState,
    t: &TransformSnapshot,
    opts: RunOptions,
) -> Result<TransformRunRow, sqlx::Error> {
    let run_id = mf_db::new_id();
    sqlx::query(
        "INSERT INTO transform_runs (id, transform_id, status, logs_json, replay_of_run_id) \
         VALUES ($1, $2, 'running', '[]', $3)",
    )
    .bind(&run_id)
    .bind(&t.id)
    .bind(opts.replay_of_run_id.clone())
    .execute(&state.db)
    .await?;

    let mut log = RunLog::default();
    let started_at = mf_db::now();
    let max_rows = max_rows();

    let mut error: Option<String> = None;
    let mut row_count: Option<i32> = None;
    let mut output_dataset_id: Option<String> = None;
    let mut output_version_number: Option<i32> = None;
    let mut manifest = TransformManifest {
        transform_id: t.id.clone(),
        language: t.language.clone(),
        source_code: t.source_code.clone(),
        output_dataset_name: t.output_dataset_name.clone(),
        configured_inputs: t.input_ids.clone(),
        inputs: Vec::new(),
        output_dataset_id: None,
        output_version_number: None,
    };

    // try { ... } catch (err) { status = 'failed'; error = ...; log('error', ...) }
    let outcome = execute_run(
        state,
        &run_id,
        t,
        &opts,
        &mut log,
        &mut manifest,
        &mut row_count,
        &mut output_dataset_id,
        &mut output_version_number,
        max_rows,
    )
    .await;
    let status = match outcome {
        Ok(()) => "success",
        Err(msg) => {
            log.error(msg.clone());
            error = Some(msg);
            "failed"
        }
    };

    let duration_ms = (mf_db::now() - started_at).num_milliseconds().max(0) as i32;
    let logs_json = serde_json::to_value(&log.entries).unwrap_or(Value::Array(Vec::new()));
    let manifest_json = serde_json::to_value(&manifest).unwrap_or(Value::Null);

    let finished: TransformRunRow = sqlx::query_as(&format!(
        "UPDATE transform_runs SET status = $1, logs_json = $2, duration_ms = $3, \
         row_count = $4, output_dataset_id = $5, output_version_number = $6, \
         manifest_json = $7, error = $8, finished_at = now() \
         WHERE id = $9 RETURNING {RUN_COLS}"
    ))
    .bind(status)
    .bind(Json(logs_json))
    .bind(duration_ms)
    .bind(row_count)
    .bind(output_dataset_id.clone())
    .bind(output_version_number)
    .bind(Json(manifest_json))
    .bind(error.clone())
    .bind(&run_id)
    .fetch_one(&state.db)
    .await?;
    Ok(finished)
}

/// The engine `try` block: inputs → dispatch → row cap → publish.
#[allow(clippy::too_many_arguments)]
async fn execute_run(
    state: &AppState,
    run_id: &str,
    t: &TransformSnapshot,
    opts: &RunOptions,
    log: &mut RunLog,
    manifest: &mut TransformManifest,
    row_count: &mut Option<i32>,
    output_dataset_id: &mut Option<String>,
    output_version_number: &mut Option<i32>,
    max_rows: usize,
) -> Result<(), String> {
    log.info(format!("run started (language={})", t.language));
    let inputs = load_inputs(
        &state.catalog,
        &t.input_ids,
        opts.input_overrides.as_ref(),
        log,
    )
    .await?;
    manifest.inputs = inputs
        .iter()
        .map(|i| ManifestInput {
            dataset_id: i.dataset_id.clone(),
            version_number: i.version_number,
        })
        .collect();

    let rows: Vec<Row> = match t.language.as_str() {
        "javascript" => {
            let input = build_script_input(&inputs);
            log.info("executing javascript via isolated worker thread");
            let engine = mf_js::default_engine()
                .ok_or_else(|| "isolated runner not configured".to_string())?;
            let limits = mf_js::JsLimits {
                timeout: Duration::from_millis(JS_TIMEOUT_MS),
                max_rows,
            };
            // eval_workbook is synchronous (QuickJS wall-clock interrupt) —
            // run it off the async runtime, like the legacy worker_thread.
            let source = t.source_code.clone();
            let values = tokio::task::spawn_blocking(move || {
                engine
                    .eval_workbook(&source, &input, &limits)
                    .map_err(|e| e.to_string())
            })
            .await
            .map_err(|e| format!("worker error: {e}"))??;
            // eval_workbook results are already row-validated; map to Rows.
            let mut rows = Vec::with_capacity(values.len());
            for (i, v) in values.into_iter().enumerate() {
                match v {
                    Value::Object(m) => rows.push(m),
                    other => {
                        return Err(format!(
                            "row {i}: expected a plain object (got {})",
                            match other {
                                Value::Null => "null",
                                Value::Array(_) => "array",
                                _ => crate::validate::js_type_of(&other),
                            }
                        ))
                    }
                }
            }
            rows
        }
        "python" => {
            let input = build_script_input(&inputs);
            log.info("executing python via isolated subprocess");
            let (outcome, stdout) =
                execute_python_isolated(&t.source_code, &input, PYTHON_TIMEOUT_MS, max_rows).await;
            // User print() output surfaces as run logs (before the outcome).
            for line in stdout {
                log.info(line);
            }
            outcome?
        }
        _ => {
            // sql (default)
            let sql = validate_sql(&t.source_code, log)?;
            log.info("executing SQL via isolated ephemeral database");
            let sql_inputs = build_sql_inputs(&inputs);
            execute_sql_isolated(&sql, &sql_inputs, Some(SqlRunOptions { max_rows }))
                .map_err(|e| e.to_string())?
        }
    };

    if rows.len() > max_rows {
        return Err(format!(
            "Transform produced {} rows; the current storage limit is {max_rows}. No output was written.",
            rows.len()
        ));
    }
    // Legacy assigns rowCount BEFORE publishing — a failed publish keeps it.
    *row_count = Some(rows.len() as i32);

    // Publish the output as a NEW version of the output dataset through the
    // catalog's single write door (idempotent via outputJobId = run id; the
    // catalog writes row storage, version lineage edges, quality evaluation
    // and emits mf.dataset.version.created centrally).
    let dataset_id = catalog::ensure_dataset_by_name(&state.catalog, &t.output_dataset_name)
        .await
        .map_err(|e| e.to_string())?;
    let rows_json: Vec<Value> = rows.iter().map(|r| Value::Object(r.clone())).collect();
    let body = serde_json::json!({
        "rows": rows_json,
        "createdBy": format!("transform:{run_id}"),
        "outputJobId": run_id,
        "inputs": manifest.inputs,
        "transformRunId": run_id,
        "transformId": t.id,
    });
    let (version_number, published_rows) = catalog::post_version(&state.catalog, &dataset_id, &body)
        .await
        .map_err(|e| e.to_string())?;

    *output_dataset_id = Some(dataset_id.clone());
    *output_version_number = Some(version_number as i32);
    manifest.output_dataset_id = Some(dataset_id);
    manifest.output_version_number = Some(version_number);
    log.success(format!(
        "published output \"{}\" v{version_number} ({published_rows} rows)",
        t.output_dataset_name
    ));
    Ok(())
}

// ─── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn sanitize_matches_legacy() {
        assert_eq!(sanitize_table_name("Shipments"), "shipments");
        assert_eq!(sanitize_table_name("Active Shipments"), "active_shipments");
        assert_eq!(sanitize_table_name("Ünïcode Náme"), "_n_code_n_me");
        assert_eq!(sanitize_table_name(""), "table");
    }

    #[test]
    fn collision_suffixes_match_legacy_loop() {
        let assigned = assign_table_names(&names(&[
            "Shipments",
            "Active Shipments",
            "active_shipments",
            "shipments",
        ]));
        assert_eq!(
            assigned,
            vec![
                "shipments".to_string(),
                "active_shipments".to_string(),
                "active_shipments_2".to_string(),
                "shipments_2".to_string(),
            ]
        );
    }

    #[test]
    fn protected_tables_force_suffix() {
        let assigned = assign_table_names(&names(&["Dataset", "dataset", "Transform"]));
        assert_eq!(
            assigned,
            vec![
                "dataset_2".to_string(),
                "dataset_3".to_string(),
                "transform_2".to_string(),
            ]
        );
    }

    #[test]
    fn sql_validation_exact_legacy_strings() {
        let mut log = RunLog::default();
        assert_eq!(validate_sql("   ", &mut log).unwrap_err(), "SQL is empty");
        assert_eq!(validate_sql(";", &mut log).unwrap_err(), "SQL is empty");
        assert_eq!(
            validate_sql("SELECT 1; DROP TABLE x", &mut log).unwrap_err(),
            "bad SQL: multiple statements are not allowed (found \";\" mid-query)"
        );
        assert_eq!(
            validate_sql("UPDATE t SET a = 1", &mut log).unwrap_err(),
            "bad SQL: only SELECT or WITH queries are allowed (first word: \"update\")"
        );
        assert_eq!(
            validate_sql("/* c */ DELETE FROM t", &mut log).unwrap_err(),
            "bad SQL: only SELECT or WITH queries are allowed (first word: \"delete\")"
        );
        assert_eq!(
            validate_sql("1234", &mut log).unwrap_err(),
            "bad SQL: only SELECT or WITH queries are allowed (first word: \"—\")"
        );
        // one trailing ';' is stripped; comments skipped; WITH allowed
        assert_eq!(
            validate_sql("  SELECT * FROM t ;  ", &mut log).unwrap(),
            "SELECT * FROM t"
        );
        assert_eq!(
            validate_sql("-- lead\nSELECT 1", &mut log).unwrap(),
            "-- lead\nSELECT 1"
        );
        assert!(validate_sql(
            "WITH x AS (SELECT 1) SELECT * FROM x",
            &mut log
        )
        .is_ok());
        // ';' inside string literals passes the engine check (the isolated
        // runner rejects it later — same as legacy)
        assert!(validate_sql("SELECT 'a;b'", &mut log).is_ok());
        assert_eq!(
            log.entries.first().map(|e| e.msg.as_str()),
            Some("validating SQL (SELECT/WITH only, single statement)")
        );
    }

    #[test]
    fn semicolon_scanner_handles_quotes() {
        assert!(!has_semicolon_outside_quotes("SELECT 'a;b'"));
        assert!(!has_semicolon_outside_quotes("SELECT \"a;b\""));
        assert!(!has_semicolon_outside_quotes("SELECT 'it''s;fine'"));
        assert!(has_semicolon_outside_quotes("SELECT 'a' ; "));
    }

    #[test]
    fn manifest_shape_is_exact_legacy_contract() {
        let manifest = TransformManifest {
            transform_id: "t1".into(),
            language: "python".into(),
            source_code: "def transform(i): return []".into(),
            output_dataset_name: "out".into(),
            configured_inputs: vec!["d1".into(), "d2".into()],
            inputs: vec![
                ManifestInput {
                    dataset_id: "d1".into(),
                    version_number: 3,
                },
                ManifestInput {
                    dataset_id: "d2".into(),
                    version_number: 1,
                },
            ],
            output_dataset_id: Some("d9".into()),
            output_version_number: Some(7),
        };
        let v = serde_json::to_value(&manifest).unwrap();
        let keys: Vec<&String> = v.as_object().unwrap().keys().collect();
        assert_eq!(
            keys,
            vec![
                "transformId",
                "language",
                "sourceCode",
                "outputDatasetName",
                "configuredInputs",
                "inputs",
                "outputDatasetId",
                "outputVersionNumber"
            ]
        );
        assert_eq!(v["inputs"][0]["datasetId"], "d1");
        assert_eq!(v["inputs"][1]["versionNumber"], 1);
        // round-trips for replay parsing
        let back: TransformManifest = serde_json::from_value(v).unwrap();
        assert_eq!(back.inputs.len(), 2);
        assert_eq!(back.output_version_number, Some(7));
    }

    #[test]
    fn log_accumulates_in_order_with_levels() {
        let mut log = RunLog::default();
        log.info("run started (language=sql)");
        log.warn("no input datasets configured");
        log.success("published output \"o\" v1 (0 rows)");
        log.error("boom");
        let v = serde_json::to_value(&log.entries).unwrap();
        assert_eq!(v[0]["level"], "info");
        assert_eq!(v[1]["level"], "warn");
        assert_eq!(v[2]["level"], "success");
        assert_eq!(v[3]["level"], "error");
        let keys: Vec<&String> = v[0].as_object().unwrap().keys().collect();
        assert_eq!(keys, vec!["ts", "level", "msg"]);
        assert!(v[0]["ts"].as_str().unwrap().ends_with('Z'));
    }

    fn loaded(name: &str, schema: &[&str], rows: Vec<Row>) -> LoadedInput {
        LoadedInput {
            dataset_id: format!("ds-{name}"),
            name: name.to_string(),
            version_number: 1,
            rows,
            schema: schema
                .iter()
                .map(|c| SchemaColumn {
                    name: c.to_string(),
                    column_type: mf_types::ColumnType::String,
                })
                .collect(),
        }
    }

    #[test]
    fn sql_inputs_materialize_schema_columns_and_collisions() {
        let inputs = vec![
            loaded("Active Shipments", &["id", "city"], vec![json!({"id": "1", "city": "berlin", "extra": "ignored"}).as_object().unwrap().clone()]),
            loaded("active_shipments", &["id"], Vec::new()),
        ];
        let tables = build_sql_inputs(&inputs);
        assert_eq!(tables[0].name, "active_shipments");
        assert_eq!(tables[0].columns, vec!["id".to_string(), "city".to_string()]);
        assert_eq!(tables[0].rows.len(), 1);
        assert_eq!(tables[1].name, "active_shipments_2");
        assert!(tables[1].rows.is_empty());

        // end-to-end through mf-sqlrun: the "extra" row key outside the
        // schema is NOT materialized (legacy column set = schema columns)
        let rows = execute_sql_isolated(
            "SELECT id, city FROM active_shipments",
            &tables,
            Some(SqlRunOptions { max_rows: 10 }),
        )
        .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].get("city"), Some(&json!("berlin")));
        assert!(rows[0].get("extra").is_none());
        let err = execute_sql_isolated(
            "SELECT * FROM extra",
            &tables,
            Some(SqlRunOptions { max_rows: 10 }),
        )
        .unwrap_err();
        assert!(err.to_string().contains("no such table"), "got {err}");
    }

    #[test]
    fn script_input_shape_matches_legacy() {
        let row: Row = json!({"a": 1}).as_object().unwrap().clone();
        let inputs = vec![loaded("First", &["a"], vec![row.clone()]), loaded("Second", &["b"], Vec::new())];
        let v = build_script_input(&inputs);
        let keys: Vec<&String> = v.as_object().unwrap().keys().collect();
        assert_eq!(keys, vec!["rows", "datasets", "schemas"]);
        assert_eq!(v["rows"], json!([{"a": 1}]));
        assert_eq!(v["datasets"]["First"], json!([{"a": 1}]));
        assert_eq!(v["datasets"]["Second"], json!([]));
        assert_eq!(v["schemas"]["First"], json!([{"name": "a", "type": "string"}]));
    }

    #[test]
    fn max_rows_defaults_to_5000() {
        // env may set MAX_ROWS in CI; only assert the documented fallback
        // when it is unset.
        if std::env::var("MAX_ROWS").is_err() {
            assert_eq!(max_rows(), 5000);
        }
    }
}
