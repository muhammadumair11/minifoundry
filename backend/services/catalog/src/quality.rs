//! Data quality (expectations) engine — port of src/lib/quality.ts.
//!
//! evaluate_rules loads every ENABLED rule of a dataset, evaluates it against
//! one version's rows and stores a QualityResult per rule (all sharing one
//! createdAt, like the legacy createMany). Severity 'error' failures raise a
//! `quality_failed` notification. The aggregate state is stamped onto the
//! version row (feeds the publication gate).

use chrono::{DateTime, Utc};
use mf_events::NotifyEvent;
use mf_types::{Row, Value};
use serde_json::json;
use sqlx::PgPool;

use crate::jsval::{js_num_to_string, js_round, js_stringify, to_number};
use crate::rows::rows_from_data_json;
use crate::state::AppState;

pub const QUALITY_KINDS: [&str; 7] = [
    "not_null",
    "unique",
    "range",
    "allowed_values",
    "regex",
    "freshness",
    "row_count_min",
];

/// Column is required for every kind except the dataset-level ones.
pub fn kind_requires_column(kind: &str) -> bool {
    kind != "freshness" && kind != "row_count_min"
}

pub struct RuleOutcome {
    pub passed: bool,
    pub actual: Option<String>,
    pub message: Option<String>,
}

fn empty(v: Option<&Value>) -> bool {
    match v {
        None => true,
        Some(Value::Null) => true,
        Some(Value::String(s)) => s.is_empty(),
        _ => false,
    }
}

fn rows_word(n: usize) -> String {
    if n == 1 { "row".to_string() } else { "rows".to_string() }
}

fn values_word(n: usize) -> String {
    if n == 1 { "value".to_string() } else { "values".to_string() }
}

/// toNumber with a fallback (the legacy `n()` helper).
fn num_or(v: Option<&Value>, fallback: Option<f64>) -> Option<f64> {
    match v {
        None => fallback,
        Some(v) => {
            let n = to_number(v);
            if n.is_nan() {
                fallback
            } else {
                Some(n)
            }
        }
    }
}

/// Port of `evaluateOne` — exact legacy messages.
pub fn evaluate_one(
    kind: &str,
    column: Option<&str>,
    config: &Value,
    rows: &[Row],
    dataset_updated_at: DateTime<Utc>,
) -> RuleOutcome {
    let total = rows.len();
    match kind {
        "not_null" => {
            let col = column.unwrap_or("");
            let violations = rows.iter().filter(|r| empty(r.get(col))).count();
            RuleOutcome {
                passed: violations == 0,
                actual: Some(format!("{violations} violating {}", rows_word(violations))),
                message: Some(if violations == 0 {
                    format!("not_null ok on '{col}' across {total} rows")
                } else {
                    format!("{violations} of {total} rows have null/empty '{col}'")
                }),
            }
        }
        "unique" => {
            let col = column.unwrap_or("");
            // Insertion-ordered counts (JS Map semantics) via an ordered Vec.
            let mut counts: Vec<(String, i64)> = Vec::new();
            for r in rows {
                let key = match r.get(col) {
                    None | Some(Value::Null) => "\u{2205}null".to_string(),
                    Some(v) => js_stringify(v),
                };
                match counts.iter_mut().find(|(k, _)| *k == key) {
                    Some(entry) => entry.1 += 1,
                    None => counts.push((key, 1)),
                }
            }
            let mut violations: i64 = 0;
            let mut dups: Vec<String> = Vec::new();
            for (key, count) in &counts {
                if *count > 1 {
                    violations += count - 1;
                    if dups.len() < 3 {
                        dups.push(format!("'{key}'\u{d7}{count}"));
                    }
                }
            }
            RuleOutcome {
                passed: violations == 0,
                actual: Some(format!("{violations} duplicate {}", values_word(violations as usize))),
                message: Some(if violations == 0 {
                    format!("unique ok on '{col}' across {total} rows")
                } else {
                    format!(
                        "{violations} duplicate values in '{col}' ({}){}",
                        dups.join(", "),
                        if dups.len() == 3 { "\u{2026}" } else { "" }
                    )
                }),
            }
        }
        "range" => {
            let col = column.unwrap_or("");
            let min = num_or(config.get("min"), None);
            let max = num_or(config.get("max"), None);
            let violations = rows
                .iter()
                .filter(|r| {
                    let v = to_number(r.get(col).unwrap_or(&Value::Null));
                    if v.is_nan() {
                        return true;
                    }
                    if let Some(min) = min {
                        if v < min {
                            return true;
                        }
                    }
                    if let Some(max) = max {
                        if v > max {
                            return true;
                        }
                    }
                    false
                })
                .count();
            let bounds = match (min, max) {
                (Some(min), Some(max)) => {
                    format!("[{}, {}]", js_num_to_string(min), js_num_to_string(max))
                }
                (Some(min), None) => format!(">= {}", js_num_to_string(min)),
                (None, Some(max)) => format!("<= {}", js_num_to_string(max)),
                (None, None) => "(unbounded)".to_string(),
            };
            RuleOutcome {
                passed: violations == 0,
                actual: Some(format!("{violations} violating {}", rows_word(violations))),
                message: Some(if violations == 0 {
                    format!("range ok on '{col}' {bounds} across {total} rows")
                } else {
                    format!("{violations} of {total} rows outside range {bounds} for '{col}'")
                }),
            }
        }
        "allowed_values" => {
            let col = column.unwrap_or("");
            let allowed: std::collections::HashSet<String> = config
                .get("values")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter().map(js_stringify).collect())
                .unwrap_or_default();
            let violations = rows
                .iter()
                .filter(|r| match r.get(col) {
                    None | Some(Value::Null) => true,
                    Some(v) => !allowed.contains(&js_stringify(v)),
                })
                .count();
            RuleOutcome {
                passed: violations == 0,
                actual: Some(format!("{violations} violating {}", rows_word(violations))),
                message: Some(if violations == 0 {
                    format!(
                        "allowed_values ok on '{col}' ({} values) across {total} rows",
                        allowed.len()
                    )
                } else {
                    format!(
                        "{violations} of {total} rows have values outside the allowed list for '{col}'"
                    )
                }),
            }
        }
        "regex" => {
            let col = column.unwrap_or("");
            let pattern = config
                .get("pattern")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let re = match regex::Regex::new(pattern) {
                Ok(re) => re,
                Err(_) => {
                    return RuleOutcome {
                        passed: false,
                        actual: Some("invalid pattern".to_string()),
                        message: Some(format!("Invalid regex pattern '{pattern}'")),
                    }
                }
            };
            let violations = rows
                .iter()
                .filter(|r| {
                    let s = match r.get(col) {
                        None | Some(Value::Null) => String::new(),
                        Some(v) => js_stringify(v),
                    };
                    !re.is_match(&s)
                })
                .count();
            RuleOutcome {
                passed: violations == 0,
                actual: Some(format!("{violations} violating {}", rows_word(violations))),
                message: Some(if violations == 0 {
                    format!("regex ok on '{col}' across {total} rows")
                } else {
                    format!("{violations} of {total} rows don't match /{pattern}/ on '{col}'")
                }),
            }
        }
        "freshness" => {
            let max_age_minutes = num_or(config.get("maxAgeMinutes"), Some(60.0)).unwrap_or(60.0);
            let age_minutes =
                (Utc::now() - dataset_updated_at).num_milliseconds() as f64 / 60_000.0;
            let passed = age_minutes <= max_age_minutes;
            let actual = format!("{} min old", js_round(age_minutes));
            RuleOutcome {
                passed,
                actual: Some(actual.clone()),
                message: Some(if passed {
                    format!(
                        "dataset updated {actual} (limit {} min)",
                        js_num_to_string(max_age_minutes)
                    )
                } else {
                    format!(
                        "dataset is {actual}, older than the {} min limit",
                        js_num_to_string(max_age_minutes)
                    )
                }),
            }
        }
        "row_count_min" => {
            let min_rows = num_or(config.get("minRows"), Some(1.0)).unwrap_or(1.0);
            let passed = (total as f64) >= min_rows;
            RuleOutcome {
                passed,
                actual: Some(format!("{total} rows")),
                message: Some(if passed {
                    format!("{total} rows >= {} required", js_num_to_string(min_rows))
                } else {
                    format!(
                        "only {total} rows, needs at least {}",
                        js_num_to_string(min_rows)
                    )
                }),
            }
        }
        _ => RuleOutcome {
            passed: false,
            actual: None,
            message: Some(format!("Unknown rule kind '{kind}'")),
        },
    }
}

pub struct EvaluateQualityResponse {
    pub version_number: i32,
    pub results: Vec<Value>,
    pub passed: i64,
    pub failed: i64,
}

/// Quality evaluation errors carry their legacy HTTP status.
pub struct QualityError {
    pub status: u16,
    pub message: String,
}

/// Port of `evaluateRules` — never throws for rule-level issues; missing
/// dataset (404) / version (400) surface as QualityError.
pub async fn evaluate_rules(
    state: &AppState,
    dataset_id: &str,
    version_number: i32,
    trigger: &str,
) -> Result<EvaluateQualityResponse, QualityError> {
    let pool: &PgPool = &state.db;
    let dataset: Option<(String, DateTime<Utc>)> =
        sqlx::query_as("SELECT name, updated_at FROM datasets WHERE id = $1")
            .bind(dataset_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| QualityError { status: 500, message: e.to_string() })?;
    let Some((dataset_name, dataset_updated_at)) = dataset else {
        return Err(QualityError {
            status: 404,
            message: format!("Dataset '{dataset_id}' not found"),
        });
    };
    let version: Option<(String,)> = sqlx::query_as(
        "SELECT data_json FROM dataset_versions WHERE dataset_id = $1 AND version_number = $2",
    )
    .bind(dataset_id)
    .bind(version_number)
    .fetch_optional(pool)
    .await
    .map_err(|e| QualityError { status: 500, message: e.to_string() })?;
    let Some((data_json,)) = version else {
        return Err(QualityError {
            status: 400,
            message: format!("Version {version_number} not found"),
        });
    };
    let rules: Vec<crate::state::RuleRow> = sqlx::query_as(&format!(
        "SELECT {} FROM quality_rules WHERE dataset_id = $1 AND enabled = TRUE \
         ORDER BY created_at ASC, id ASC",
        crate::state::RULE_COLS
    ))
    .bind(dataset_id)
    .fetch_all(pool)
    .await
    .map_err(|e| QualityError { status: 500, message: e.to_string() })?;

    let rows = rows_from_data_json(&data_json);
    let outcomes: Vec<(crate::state::RuleRow, RuleOutcome)> = rules
        .into_iter()
        .map(|rule| {
            let outcome = evaluate_one(
                &rule.kind,
                rule.column_name.as_deref(),
                &rule.config_json.0,
                &rows,
                dataset_updated_at,
            );
            (rule, outcome)
        })
        .collect();

    // One shared createdAt for the whole batch (legacy createMany + new Date()).
    let now = Utc::now();
    for (rule, outcome) in &outcomes {
        let result = sqlx::query(
            "INSERT INTO quality_results (id, rule_id, dataset_id, version_number, passed, \
              actual, message, trigger, created_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        )
        .bind(mf_db::new_id())
        .bind(&rule.id)
        .bind(dataset_id)
        .bind(version_number)
        .bind(outcome.passed)
        .bind(&outcome.actual)
        .bind(&outcome.message)
        .bind(trigger)
        .bind(now)
        .execute(pool)
        .await;
        if let Err(e) = result {
            tracing::warn!(error = %e, "quality result insert failed");
        }
    }

    // Severity 'error' failures raise platform notifications (never-throw).
    for (rule, outcome) in &outcomes {
        if !outcome.passed && rule.severity == "error" {
            let body = outcome
                .message
                .clone()
                .or_else(|| outcome.actual.clone())
                .unwrap_or_else(|| "Quality rule failed".to_string());
            let event = NotifyEvent {
                user_email: None,
                notif_type: "quality_failed".to_string(),
                title: format!("Quality failed: {dataset_name} \u{b7} {}", rule.name),
                body: Some(body),
                resource_type: Some("dataset".to_string()),
                resource_id: Some(dataset_id.to_string()),
                href: Some(format!("/datasets/{dataset_id}")),
            };
            mf_events::publish_json_quiet(&state.nats, mf_events::subject::NOTIFY, &event).await;
        }
    }

    let passed = outcomes.iter().filter(|(_, o)| o.passed).count() as i64;
    let failed = outcomes.len() as i64 - passed;
    let error_failures = outcomes
        .iter()
        .filter(|(r, o)| !o.passed && r.severity == "error")
        .count() as i64;
    let warn_failures = failed - error_failures;
    let quality_state = if outcomes.is_empty() {
        "not_evaluated"
    } else if error_failures > 0 {
        "failed"
    } else if warn_failures > 0 {
        "warned"
    } else {
        "passed"
    };
    let summary = json!({
        "passed": passed,
        "failed": failed,
        "errorFailures": error_failures,
        "warnFailures": warn_failures,
        "evaluatedAt": mf_types::ts::format(&now),
    });
    let update = sqlx::query(
        "UPDATE dataset_versions SET quality_state = $3, quality_summary_json = $4 \
         WHERE dataset_id = $1 AND version_number = $2",
    )
    .bind(dataset_id)
    .bind(version_number)
    .bind(quality_state)
    .bind(sqlx::types::Json(&summary))
    .execute(pool)
    .await;
    if let Err(e) = update {
        tracing::warn!(error = %e, "quality state stamp failed");
    }

    let results = outcomes
        .iter()
        .map(|(rule, outcome)| {
            json!({
                "ruleName": rule.name,
                "kind": rule.kind,
                "passed": outcome.passed,
                "actual": outcome.actual,
                "message": outcome.message,
                "severity": rule.severity,
            })
        })
        .collect();

    Ok(EvaluateQualityResponse { version_number, results, passed, failed })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(raw: &str) -> Row {
        serde_json::from_str(raw).unwrap()
    }

    fn rows(raw: &[&str]) -> Vec<Row> {
        raw.iter().map(|r| row(r)).collect()
    }

    fn now() -> DateTime<Utc> {
        Utc::now()
    }

    #[test]
    fn not_null_messages_match_legacy() {
        let r = rows(&[r#"{"a":"x"}"#, r#"{"a":""}"#, r#"{"a":null}"#, r#"{}"#]);
        let o = evaluate_one("not_null", Some("a"), &json!({}), &r, now());
        assert!(!o.passed);
        assert_eq!(o.actual.as_deref(), Some("3 violating rows"));
        assert_eq!(o.message.as_deref(), Some("3 of 4 rows have null/empty 'a'"));
        let r = rows(&[r#"{"a":"x"}"#]);
        let o = evaluate_one("not_null", Some("a"), &json!({}), &r, now());
        assert!(o.passed);
        assert_eq!(o.actual.as_deref(), Some("0 violating rows"));
        assert_eq!(o.message.as_deref(), Some("not_null ok on 'a' across 1 rows"));
        // singular
        let r = rows(&[r#"{"a":"x"}"#, r#"{"a":""}"#]);
        let o = evaluate_one("not_null", Some("a"), &json!({}), &r, now());
        assert_eq!(o.actual.as_deref(), Some("1 violating row"));
    }

    #[test]
    fn unique_messages_match_legacy() {
        // Golden: contracts/reads/dataset-quality.json range/not_null messages
        let r = rows(&[
            r#"{"id":"a"}"#,
            r#"{"id":"b"}"#,
            r#"{"id":"a"}"#,
            r#"{"id":"a"}"#,
            r#"{"id":null}"#,
        ]);
        let o = evaluate_one("unique", Some("id"), &json!({}), &r, now());
        assert!(!o.passed);
        assert_eq!(o.actual.as_deref(), Some("2 duplicate values"));
        assert_eq!(
            o.message.as_deref(),
            Some("2 duplicate values in 'id' ('a'\u{d7}3)")
        );
        // nulls group under ∅null
        let r = rows(&[r#"{"id":null}"#, r#"{"id":null}"#]);
        let o = evaluate_one("unique", Some("id"), &json!({}), &r, now());
        assert_eq!(o.message.as_deref(), Some("1 duplicate values in 'id' ('\u{2205}null'\u{d7}2)"));
    }

    #[test]
    fn range_messages_match_fixture() {
        // Golden values from contracts/reads/dataset-quality.json
        let r = rows(&[
            r#"{"risk_score":22}"#,
            r#"{"risk_score":58}"#,
            r#"{"risk_score":41}"#,
            r#"{"risk_score":140}"#,
            r#"{"risk_score":15}"#,
        ]);
        let o = evaluate_one("range", Some("risk_score"), &json!({"min":0,"max":100}), &r, now());
        assert!(!o.passed);
        assert_eq!(o.actual.as_deref(), Some("1 violating row"));
        assert_eq!(
            o.message.as_deref(),
            Some("1 of 5 rows outside range [0, 100] for 'risk_score'")
        );
        // non-numeric → violation; unbounded
        let r = rows(&[r#"{"v":"abc"}"#]);
        let o = evaluate_one("range", Some("v"), &json!({}), &r, now());
        assert!(!o.passed);
        assert!(o.message.unwrap().contains("(unbounded)"));
        // bounds rendering
        let r = rows(&[r#"{"v":5}"#]);
        let o = evaluate_one("range", Some("v"), &json!({"min":1}), &r, now());
        assert!(o.message.unwrap().contains(">= 1"));
        let o = evaluate_one("range", Some("v"), &json!({"max":10.5}), &r, now());
        assert!(o.message.unwrap().contains("<= 10.5"));
    }

    #[test]
    fn allowed_values_messages() {
        let r = rows(&[r#"{"t":"A"}"#, r#"{"t":"C"}"#, r#"{"t":null}"#]);
        let o = evaluate_one(
            "allowed_values",
            Some("t"),
            &json!({"values": ["A", "B"]}),
            &r,
            now(),
        );
        assert!(!o.passed);
        assert_eq!(o.actual.as_deref(), Some("2 violating rows"));
        assert_eq!(
            o.message.as_deref(),
            Some("2 of 3 rows have values outside the allowed list for 't'")
        );
        let r = rows(&[r#"{"t":"A"}"#]);
        let o = evaluate_one("allowed_values", Some("t"), &json!({"values":["A"]}), &r, now());
        assert_eq!(
            o.message.as_deref(),
            Some("allowed_values ok on 't' (1 values) across 1 rows")
        );
        // numeric values compared as String(v)
        let r = rows(&[r#"{"t":1}"#]);
        let o = evaluate_one("allowed_values", Some("t"), &json!({"values":[1]}), &r, now());
        assert!(o.passed);
    }

    #[test]
    fn regex_messages() {
        let r = rows(&[r#"{"e":"a@b.c"}"#, r#"{"e":"nope"}"#]);
        let o = evaluate_one("regex", Some("e"), &json!({"pattern":"^.*@.*$"}), &r, now());
        assert!(!o.passed);
        assert_eq!(
            o.message.as_deref(),
            Some("1 of 2 rows don't match /^.*@.*$/ on 'e'")
        );
        let o = evaluate_one("regex", Some("e"), &json!({"pattern":"("}), &r, now());
        assert!(!o.passed);
        assert_eq!(o.actual.as_deref(), Some("invalid pattern"));
        assert_eq!(o.message.as_deref(), Some("Invalid regex pattern '('"));
        // null values test as ""
        let r = rows(&[r#"{"e":null}"#]);
        let o = evaluate_one("regex", Some("e"), &json!({"pattern":"^$"}), &r, now());
        assert!(o.passed);
    }

    #[test]
    fn freshness_and_row_count() {
        let fresh = Utc::now() - chrono::Duration::minutes(30);
        let o = evaluate_one("freshness", None, &json!({"maxAgeMinutes":60}), &[], fresh);
        assert!(o.passed);
        assert_eq!(o.actual.as_deref(), Some("30 min old"));
        assert_eq!(
            o.message.as_deref(),
            Some("dataset updated 30 min old (limit 60 min)")
        );
        let stale = Utc::now() - chrono::Duration::minutes(120);
        let o = evaluate_one("freshness", None, &json!({"maxAgeMinutes":60}), &[], stale);
        assert!(!o.passed);
        assert_eq!(
            o.message.as_deref(),
            Some("dataset is 120 min old, older than the 60 min limit")
        );
        // default 60 when config missing/NaN
        let o = evaluate_one("freshness", None, &json!({}), &[], now());
        assert!(o.message.unwrap().contains("limit 60 min"));

        let r = rows(&[r#"{"a":1}"#; 3]);
        let o = evaluate_one("row_count_min", None, &json!({"minRows":5}), &r, now());
        assert!(!o.passed);
        assert_eq!(o.actual.as_deref(), Some("3 rows"));
        assert_eq!(o.message.as_deref(), Some("only 3 rows, needs at least 5"));
        let o = evaluate_one("row_count_min", None, &json!({"minRows":2}), &r, now());
        assert_eq!(o.message.as_deref(), Some("3 rows >= 2 required"));
    }

    #[test]
    fn unknown_kind() {
        let o = evaluate_one("bogus", None, &json!({}), &[], now());
        assert!(!o.passed);
        assert_eq!(o.message.as_deref(), Some("Unknown rule kind 'bogus'"));
    }
}
