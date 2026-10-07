//! Port of `validateRunnerRows` (src/lib/isolated-runner.ts lines 243-263).
//!
//! Applied to the Python subprocess result (the JS path is validated inside
//! mf-js with the same exact messages). Row shape: array of plain objects
//! with string|number|boolean|null cells, capped at maxRows.

use mf_types::{Row, Value};

/// JS `typeof` for a JSON value (arrays are "object" in JS — the special
/// "array" wording is applied by the caller for row elements, like legacy).
pub fn js_type_of(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "object",
        Value::Object(_) => "object",
    }
}

/// Exact legacy validation + error strings:
/// - not an array  → `transform must return an array of row objects (got <t>)`
/// - over the cap  → `transform returned <n> rows; limit is <max>`
/// - bad element   → `row <i>: expected a plain object (got <null|array|t>)`
/// - bad cell      → `row <i> column "<k>": value must be string|number|boolean|null (got <t>)`
pub fn validate_runner_rows(raw: &Value, max_rows: usize) -> Result<Vec<Row>, String> {
    let Some(arr) = raw.as_array() else {
        return Err(format!(
            "transform must return an array of row objects (got {})",
            js_type_of(raw)
        ));
    };
    if arr.len() > max_rows {
        return Err(format!(
            "transform returned {} rows; limit is {max_rows}",
            arr.len()
        ));
    }
    let mut rows: Vec<Row> = Vec::with_capacity(arr.len());
    for (i, el) in arr.iter().enumerate() {
        match el {
            Value::Object(map) => {
                let mut row = Row::new();
                for (key, value) in map {
                    match value {
                        Value::String(_) | Value::Number(_) | Value::Bool(_) | Value::Null => {
                            row.insert(key.clone(), value.clone());
                        }
                        other => {
                            return Err(format!(
                                "row {i} column \"{key}\": value must be string|number|boolean|null (got {})",
                                js_type_of(other)
                            ))
                        }
                    }
                }
                rows.push(row);
            }
            other => {
                let got = match other {
                    Value::Null => "null",
                    Value::Array(_) => "array",
                    _ => js_type_of(other),
                };
                return Err(format!("row {i}: expected a plain object (got {got})"));
            }
        }
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn non_array_messages_match_legacy() {
        assert_eq!(
            validate_runner_rows(&json!(null), 10).unwrap_err(),
            "transform must return an array of row objects (got null)"
        );
        assert_eq!(
            validate_runner_rows(&json!({"a": 1}), 10).unwrap_err(),
            "transform must return an array of row objects (got object)"
        );
        assert_eq!(
            validate_runner_rows(&json!("x"), 10).unwrap_err(),
            "transform must return an array of row objects (got string)"
        );
        assert_eq!(
            validate_runner_rows(&json!(42), 10).unwrap_err(),
            "transform must return an array of row objects (got number)"
        );
        assert_eq!(
            validate_runner_rows(&json!(true), 10).unwrap_err(),
            "transform must return an array of row objects (got boolean)"
        );
    }

    #[test]
    fn row_cap_message_matches_legacy() {
        let raw = json!([{"a": 1}, {"a": 2}, {"a": 3}]);
        assert_eq!(
            validate_runner_rows(&raw, 2).unwrap_err(),
            "transform returned 3 rows; limit is 2"
        );
        assert_eq!(validate_runner_rows(&raw, 3).unwrap().len(), 3);
    }

    #[test]
    fn element_shape_messages_match_legacy() {
        assert_eq!(
            validate_runner_rows(&json!([null]), 10).unwrap_err(),
            "row 0: expected a plain object (got null)"
        );
        assert_eq!(
            validate_runner_rows(&json!([{"ok": 1}, [1, 2]]), 10).unwrap_err(),
            "row 1: expected a plain object (got array)"
        );
        assert_eq!(
            validate_runner_rows(&json!(["str"]), 10).unwrap_err(),
            "row 0: expected a plain object (got string)"
        );
        assert_eq!(
            validate_runner_rows(&json!([7]), 10).unwrap_err(),
            "row 0: expected a plain object (got number)"
        );
    }

    #[test]
    fn cell_value_messages_match_legacy() {
        assert_eq!(
            validate_runner_rows(&json!([{"a": {"b": 1}}]), 10).unwrap_err(),
            "row 0 column \"a\": value must be string|number|boolean|null (got object)"
        );
        assert_eq!(
            validate_runner_rows(&json!([{"a": [1]}]), 10).unwrap_err(),
            "row 0 column \"a\": value must be string|number|boolean|null (got object)"
        );
    }

    #[test]
    fn valid_rows_pass_and_preserve_cell_order() {
        let rows = validate_runner_rows(&json!([{"z": "s", "a": 1, "b": true, "c": null}]), 10)
            .unwrap();
        assert_eq!(rows.len(), 1);
        let keys: Vec<&String> = rows[0].keys().collect();
        assert_eq!(
            keys,
            vec![
                &"z".to_string(),
                &"a".to_string(),
                &"b".to_string(),
                &"c".to_string()
            ]
        );
    }
}
