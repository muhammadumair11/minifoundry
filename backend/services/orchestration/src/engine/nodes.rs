//! Pure node executors over rows — 1:1 ports of the `exec*` functions in
//! `src/lib/engine.ts`. Every executor is a pure function over `&[Row]` (+ the
//! mf-js engine for derive) so it can be unit-tested against hand-computed
//! expectations without a database or network.
//!
//! JS semantics notes (Option<&Value> models JS `undefined` vs `null`):
//! - a missing cell/key is `None` (JS `undefined`); a JSON null is `Some(Null)`
//!   — they differ for strict equality (`undefined !== null`) and for
//!   `String(v)` ("undefined" vs ""), and they agree for `v ?? ''` ("").

use serde_json::{Map, Value};

use crate::values::{js_string_of, key_of, numeric_equals, round_smart, stable_row_key, to_number};

pub type Row = Map<String, Value>;

/// A pipeline graph node (id/type coerced like parseGraph; data defaults {}).
#[derive(Debug, Clone)]
pub struct GraphNode {
    pub id: String,
    pub node_type: String,
    pub data: Map<String, Value>,
}

/// Errors with a clean, user-facing message (graph validation / runtime).
/// The message is the failureCause persisted on the run (legacy PipelineError).
#[derive(Debug, Clone)]
pub struct PipelineError(pub String);

impl std::fmt::Display for PipelineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for PipelineError {}

fn err(msg: impl Into<String>) -> PipelineError {
    PipelineError(msg.into())
}

/// Port of `requireString(node, field)`.
pub fn require_string(node: &GraphNode, field: &str) -> Result<String, PipelineError> {
    match node.data.get(field) {
        Some(Value::String(s)) if !s.trim().is_empty() => Ok(s.clone()),
        _ => Err(err(format!(
            "{} node '{}' requires a string '{}'",
            node.node_type, node.id, field
        ))),
    }
}

// ─── JS undefined-vs-null helpers ───────────────────────────────────────

fn to_number_opt(v: Option<&Value>) -> f64 {
    match v {
        Some(x) => to_number(x),
        None => f64::NAN,
    }
}

/// `String(v)` with undefined → "undefined", null → "".
fn js_string_raw(v: Option<&Value>) -> String {
    match v {
        None => "undefined".to_string(),
        Some(x) => js_string_of(x),
    }
}

/// `String(v ?? '')` — nullish → "".
fn js_string_nullish(v: Option<&Value>) -> String {
    match v {
        None => String::new(),
        Some(Value::Null) => String::new(),
        Some(x) => js_string_of(x),
    }
}

/// keyOf for possibly-missing cells (join/aggregate/dedupe keys).
fn key_of_opt(v: Option<&Value>) -> String {
    match v {
        None => "undefined".to_string(),
        Some(x) => key_of(x),
    }
}

/// numericEquals for possibly-missing cells — `undefined === undefined` is
/// true, `undefined === null` is false (JS strict equality).
fn numeric_equals_opt(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(x), Some(y)) => numeric_equals(x, y),
        _ => false,
    }
}

/// compareValues for possibly-missing cells (`String(a ?? '')` semantics).
fn compare_values_opt(a: Option<&Value>, b: Option<&Value>) -> i32 {
    let x = to_number_opt(a);
    let y = to_number_opt(b);
    if !x.is_nan() && !y.is_nan() {
        return if x < y {
            -1
        } else if x > y {
            1
        } else {
            0
        };
    }
    let sa = js_string_nullish(a);
    let sb = js_string_nullish(b);
    if sa < sb {
        -1
    } else if sa > sb {
        1
    } else {
        0
    }
}

/// Legacy identifier filter used for derive destructuring:
/// `/^[a-zA-Z_$][a-zA-Z0-9_$]*$/`.
fn is_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' || c == '$' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

/// JS object-property key coercion (row[5] === row["5"]).
fn prop_key(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => js_string_of(other),
    }
}

// ─── filter ─────────────────────────────────────────────────────────────

pub fn exec_filter(node: &GraphNode, rows: &[Row]) -> Result<Vec<Row>, PipelineError> {
    let column = require_string(node, "column")?;
    let operator = require_string(node, "operator")?;
    let value = node.data.get("value");
    let mut out = Vec::new();
    for row in rows {
        if match_filter(row.get(&column), &operator, value)? {
            out.push(row.clone());
        }
    }
    Ok(out)
}

fn match_filter(
    cell: Option<&Value>,
    operator: &str,
    value: Option<&Value>,
) -> Result<bool, PipelineError> {
    match operator {
        "eq" => Ok(numeric_equals_opt(cell, value)),
        "neq" => Ok(!numeric_equals_opt(cell, value)),
        "gt" | "gte" | "lt" | "lte" => {
            let x = to_number_opt(cell);
            let y = to_number_opt(value);
            let cmp = if !x.is_nan() && !y.is_nan() {
                if x < y {
                    -1
                } else if x > y {
                    1
                } else {
                    0
                }
            } else {
                compare_values_opt(cell, value)
            };
            Ok(match operator {
                "gt" => cmp > 0,
                "gte" => cmp >= 0,
                "lt" => cmp < 0,
                _ => cmp <= 0,
            })
        }
        "contains" => {
            let haystack = js_string_nullish(cell).to_lowercase();
            let needle = js_string_nullish(value).to_lowercase();
            Ok(haystack.contains(&needle))
        }
        _ => Err(err(format!(
            "Unknown filter operator '{operator}' (supported: eq, neq, gt, gte, lt, lte, contains)"
        ))),
    }
}

// ─── derive ─────────────────────────────────────────────────────────────

/// Port of `execDerive`. Returns the rows with `newColumn` set plus the count
/// of per-row evaluation failures (the caller logs the legacy warn line:
/// `derive (<id>): N row(s) failed to evaluate '<expr>' — set to null`).
pub fn exec_derive(node: &GraphNode, rows: &[Row]) -> Result<(Vec<Row>, usize), PipelineError> {
    let new_column = require_string(node, "newColumn")?;
    let expression = require_string(node, "expression")?;

    // Validate expression: reject dangerous patterns before evaluation.
    if mf_js::derive_expression_is_dangerous(&expression) {
        return Err(err(format!(
            "derive node '{}': expression contains disallowed identifier",
            node.id
        )));
    }

    let engine = mf_js::default_engine()
        .ok_or_else(|| err(format!("derive node '{}': JS engine unavailable", node.id)))?;

    // Column names from the first row (legacy sampleKeys), identifier-shaped only.
    let sample_keys: Vec<String> = rows
        .first()
        .map(|r| r.keys().filter(|k| is_identifier(k)).cloned().collect())
        .unwrap_or_default();
    let row_values: Vec<Value> = rows.iter().map(|r| Value::Object(r.clone())).collect();

    let (values, failed) = engine
        .eval_derive(&expression, &sample_keys, &row_values)
        .map_err(|e| match e {
            mf_js::JsError::Compile(msg) => err(format!(
                "derive node '{}': invalid expression — {msg}",
                node.id
            )),
            other => err(format!("derive node '{}': {other}", node.id)),
        })?;

    let mut out = Vec::with_capacity(rows.len());
    for (i, row) in rows.iter().enumerate() {
        let mut r = row.clone();
        // undefined results already arrive as Null (engine contract).
        let value = values.get(i).cloned().unwrap_or(Value::Null);
        r.insert(new_column.clone(), value);
        out.push(r);
    }
    Ok((out, failed))
}

// ─── select / rename ────────────────────────────────────────────────────

pub fn exec_select(node: &GraphNode, rows: &[Row]) -> Result<Vec<Row>, PipelineError> {
    let columns = node.data.get("columns");
    let cols: Vec<String> = match columns {
        Some(Value::Array(arr)) if !arr.is_empty() => {
            let mut v = Vec::with_capacity(arr.len());
            for c in arr {
                match c {
                    Value::String(s) => v.push(s.clone()),
                    _ => {
                        return Err(err(format!(
                            "select node '{}' requires a non-empty string array 'columns'",
                            node.id
                        )))
                    }
                }
            }
            v
        }
        _ => {
            return Err(err(format!(
                "select node '{}' requires a non-empty string array 'columns'",
                node.id
            )))
        }
    };
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let mut r = Map::new();
        for c in &cols {
            if let Some(v) = row.get(c) {
                r.insert(c.clone(), v.clone());
            }
        }
        out.push(r);
    }
    Ok(out)
}

pub fn exec_rename(node: &GraphNode, rows: &[Row]) -> Result<Vec<Row>, PipelineError> {
    let mapping = match node.data.get("mapping") {
        Some(Value::Object(m)) => m,
        _ => {
            return Err(err(format!(
                "rename node '{}' requires a 'mapping' object of {{ oldName: newName }}",
                node.id
            )))
        }
    };
    let renames: Vec<(String, String)> = mapping
        .iter()
        .filter(|(_, v)| matches!(v, Value::String(s) if !s.is_empty()))
        .map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string()))
        .collect();
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let mut r = Map::new();
        for (key, value) in row {
            let target = renames.iter().find(|(old, _)| old == key);
            match target {
                Some((_, new)) => {
                    r.insert(new.clone(), value.clone());
                }
                None => {
                    r.insert(key.clone(), value.clone());
                }
            }
        }
        out.push(r);
    }
    Ok(out)
}

// ─── join ───────────────────────────────────────────────────────────────

pub fn exec_join(node: &GraphNode, inputs: &[Vec<Row>]) -> Result<Vec<Row>, PipelineError> {
    if inputs.len() != 2 {
        return Err(err(format!(
            "join node '{}' requires exactly 2 inputs (found {})",
            node.id,
            inputs.len()
        )));
    }
    let (left, right) = (&inputs[0], &inputs[1]);
    let how_raw = node.data.get("how");
    let how: String = match how_raw {
        None | Some(Value::Null) => "inner".to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => js_string_of(other),
    };
    if how != "inner" && how != "left" {
        return Err(err(format!(
            "join node '{}': 'how' must be 'inner' or 'left' (got '{}')",
            node.id, how
        )));
    }
    let left_key = require_string(node, "leftKey")?;
    let right_key = require_string(node, "rightKey")?;

    // Column names of the right side (order-preserving union across right rows).
    let mut right_cols: Vec<String> = Vec::new();
    let mut seen_right: std::collections::HashSet<String> = std::collections::HashSet::new();
    for r in right {
        for k in r.keys() {
            if seen_right.insert(k.clone()) {
                right_cols.push(k.clone());
            }
        }
    }

    let mut index: HashMap<String, Vec<&Row>> = HashMap::new();
    for r in right {
        index
            .entry(key_of_opt(r.get(&right_key)))
            .or_default()
            .push(r);
    }

    let mut out: Vec<Row> = Vec::new();
    for l in left {
        let matches = index
            .get(&key_of_opt(l.get(&left_key)))
            .map(|v| v.as_slice())
            .unwrap_or(&[]);
        if matches.is_empty() {
            if how == "left" {
                let mut row = l.clone();
                for k in &right_cols {
                    let target = if row.contains_key(k) {
                        format!("right_{k}")
                    } else {
                        k.clone()
                    };
                    row.insert(target, Value::Null);
                }
                out.push(row);
            }
            continue;
        }
        for r in matches {
            let mut row = l.clone();
            for k in &right_cols {
                let target = if row.contains_key(k) {
                    format!("right_{k}")
                } else {
                    k.clone()
                };
                let value = r.get(k).cloned().unwrap_or(Value::Null);
                row.insert(target, value);
            }
            out.push(row);
        }
    }
    Ok(out)
}

use std::collections::HashMap;

// ─── aggregate ──────────────────────────────────────────────────────────

pub fn exec_aggregate(node: &GraphNode, rows: &[Row]) -> Result<Vec<Row>, PipelineError> {
    let raw_group_by = node.data.get("groupBy");
    if let Some(v) = raw_group_by {
        if !v.is_array() && !v.is_null() {
            return Err(err(format!(
                "aggregate node '{}': 'groupBy' must be an array of column names",
                node.id
            )));
        }
    }
    let group_by: Vec<String> = match raw_group_by {
        Some(Value::Array(arr)) => arr.iter().map(prop_key).collect(),
        _ => vec![],
    };
    let ops = match node.data.get("ops") {
        Some(Value::Array(arr)) if !arr.is_empty() => arr,
        _ => {
            return Err(err(format!(
                "aggregate node '{}' requires a non-empty 'ops' array",
                node.id
            )))
        }
    };

    // Group in first-appearance order (JS Map iteration order).
    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, (Row, Vec<Row>)> = HashMap::new();
    if group_by.is_empty() {
        order.push("__all__".to_string());
        groups.insert(
            "__all__".to_string(),
            (rows.first().cloned().unwrap_or_default(), rows.to_vec()),
        );
    } else {
        for row in rows {
            let key = group_by
                .iter()
                .map(|c| key_of_opt(row.get(c)))
                .collect::<Vec<_>>()
                .join("\u{241F}");
            match groups.get_mut(&key) {
                Some(g) => g.1.push(row.clone()),
                None => {
                    order.push(key.clone());
                    groups.insert(key, (row.clone(), vec![row.clone()]));
                }
            }
        }
    }

    let mut out: Vec<Row> = Vec::new();
    for key in &order {
        let (first, group_rows) = groups.get(key).expect("group present");
        let mut row = Map::new();
        for c in &group_by {
            row.insert(c.clone(), first.get(c).cloned().unwrap_or(Value::Null));
        }
        for op_spec in ops {
            let empty_spec = Map::new();
            let spec = match op_spec {
                Value::Object(m) => m,
                _ => &empty_spec,
            };
            let kind = match spec.get("op") {
                Some(Value::String(s)) => s.clone(),
                _ => String::new(),
            };
            if !["sum", "avg", "min", "max", "count"].contains(&kind.as_str()) {
                return Err(err(format!(
                    "aggregate node '{}': unknown op '{}' (supported: sum, avg, min, max, count)",
                    node.id,
                    js_string_raw(spec.get("op"))
                )));
            }
            let column: Option<String> = match spec.get("column") {
                Some(Value::String(s)) => Some(s.clone()),
                _ => None,
            };
            if kind != "count" && column.is_none() {
                return Err(err(format!(
                    "aggregate node '{}': op '{}' requires a 'column'",
                    node.id, kind
                )));
            }
            let alias = match spec.get("alias") {
                Some(Value::String(s)) if !s.is_empty() => s.clone(),
                _ => {
                    if kind == "count" {
                        "count".to_string()
                    } else {
                        format!("{kind}_{}", column.clone().unwrap_or_default())
                    }
                }
            };

            if kind == "count" {
                let n = match &column {
                    Some(c) => group_rows
                        .iter()
                        .filter(|r| match r.get(c) {
                            None | Some(Value::Null) => false,
                            Some(_) => true,
                        })
                        .count(),
                    None => group_rows.len(),
                };
                row.insert(alias, Value::from(n as i64));
                continue;
            }

            let col = column.as_ref().expect("checked above");
            let nums: Vec<f64> = group_rows
                .iter()
                .map(|r| to_number_opt(r.get(col)))
                .filter(|n| !n.is_nan())
                .collect();
            if nums.is_empty() {
                row.insert(alias, Value::Null);
            } else {
                let value = match kind.as_str() {
                    "sum" => crate::values::json_number(round_smart(nums.iter().sum())),
                    "avg" => crate::values::json_number(round_smart(
                        nums.iter().sum::<f64>() / nums.len() as f64,
                    )),
                    "min" => crate::values::json_number(
                        nums.iter().cloned().fold(f64::INFINITY, f64::min),
                    ),
                    _ => crate::values::json_number(
                        nums.iter().cloned().fold(f64::NEG_INFINITY, f64::max),
                    ),
                };
                row.insert(alias, value);
            }
        }
        out.push(row);
    }
    Ok(out)
}

// ─── sort / dedupe / union / limit ──────────────────────────────────────

pub fn exec_sort(node: &GraphNode, rows: &[Row]) -> Result<Vec<Row>, PipelineError> {
    let by = match node.data.get("by") {
        Some(Value::Array(arr)) if !arr.is_empty() => arr,
        _ => {
            return Err(err(format!(
                "sort node '{}' requires a non-empty 'by' array of {{ column, dir }}",
                node.id
            )))
        }
    };
    let mut keys: Vec<(String, bool)> = Vec::with_capacity(by.len());
    for k in by {
        let column = match k.get("column").and_then(|c| c.as_str()) {
            Some(c) => c.to_string(),
            None => {
                return Err(err(format!(
                    "sort node '{}': each by entry needs a string 'column'",
                    node.id
                )))
            }
        };
        let desc = k.get("dir").and_then(|d| d.as_str()) == Some("desc");
        keys.push((column, desc));
    }
    let mut out = rows.to_vec();
    out.sort_by(|a, b| {
        for (column, desc) in &keys {
            let cmp = compare_values_opt(a.get(column), b.get(column));
            if cmp != 0 {
                return match (*desc, cmp) {
                    (true, c) if c > 0 => std::cmp::Ordering::Less,
                    (true, _) => std::cmp::Ordering::Greater,
                    (false, c) if c < 0 => std::cmp::Ordering::Less,
                    (false, _) => std::cmp::Ordering::Greater,
                };
            }
        }
        std::cmp::Ordering::Equal
    });
    Ok(out)
}

pub fn exec_dedupe(node: &GraphNode, rows: &[Row]) -> Result<Vec<Row>, PipelineError> {
    let raw_keys = node.data.get("keys");
    if let Some(v) = raw_keys {
        if !v.is_array() && !v.is_null() {
            return Err(err(format!(
                "dedupe node '{}': 'keys' must be an array of column names",
                node.id
            )));
        }
    }
    let keys: Vec<String> = match raw_keys {
        Some(Value::Array(arr)) => arr.iter().map(prop_key).collect(),
        _ => vec![],
    };
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out = Vec::new();
    for row in rows {
        let key = if !keys.is_empty() {
            keys.iter()
                .map(|k| key_of_opt(row.get(k)))
                .collect::<Vec<_>>()
                .join("\u{241F}")
        } else {
            stable_row_key(row)
        };
        if seen.insert(key) {
            out.push(row.clone());
        }
    }
    Ok(out)
}

pub fn exec_union(node: &GraphNode, inputs: &[Vec<Row>]) -> Result<Vec<Row>, PipelineError> {
    if inputs.len() != 2 {
        return Err(err(format!(
            "union node '{}' requires exactly 2 inputs (found {})",
            node.id,
            inputs.len()
        )));
    }
    let (a, b) = (&inputs[0], &inputs[1]);
    let mut columns: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for row in a.iter().chain(b.iter()) {
        for k in row.keys() {
            if seen.insert(k.clone()) {
                columns.push(k.clone());
            }
        }
    }
    let mut out = Vec::with_capacity(a.len() + b.len());
    for row in a.iter().chain(b.iter()) {
        let mut r = Map::new();
        for c in &columns {
            r.insert(c.clone(), row.get(c).cloned().unwrap_or(Value::Null));
        }
        out.push(r);
    }
    Ok(out)
}

pub fn exec_limit(node: &GraphNode, rows: &[Row]) -> Result<Vec<Row>, PipelineError> {
    let n_val = node.data.get("n");
    let n: usize = match n_val {
        Some(Value::Number(num)) => {
            if let Some(i) = num.as_i64() {
                if i < 0 {
                    return Err(limit_err(node));
                }
                i as usize
            } else if let Some(f) = num.as_f64() {
                // JS Number.isInteger(5.0) === true
                if f.is_finite() && f == f.trunc() && f >= 0.0 {
                    f as usize
                } else {
                    return Err(limit_err(node));
                }
            } else {
                return Err(limit_err(node));
            }
        }
        _ => return Err(limit_err(node)),
    };
    Ok(rows.iter().take(n).cloned().collect())
}

fn limit_err(node: &GraphNode) -> PipelineError {
    err(format!(
        "limit node '{}' requires a non-negative integer 'n'",
        node.id
    ))
}

// ─── helpers used by the graph orchestrator ─────────────────────────────

/// Port of `singleInput()` — the 1-input arity check shared by most nodes.
pub fn single_input<'a>(
    node: &GraphNode,
    inputs: &'a [Vec<Row>],
) -> Result<&'a [Row], PipelineError> {
    if inputs.len() != 1 {
        return Err(err(format!(
            "{} node '{}' requires exactly 1 input (found {})",
            node.node_type,
            node.id,
            inputs.len()
        )));
    }
    Ok(&inputs[0])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn node(node_type: &str, data: Value) -> GraphNode {
        GraphNode {
            id: format!("{node_type}-1"),
            node_type: node_type.to_string(),
            data: match data {
                Value::Object(m) => m,
                _ => Map::new(),
            },
        }
    }

    fn rows(v: Value) -> Vec<Row> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|r| match r {
                Value::Object(m) => m.clone(),
                _ => panic!("row must be object"),
            })
            .collect()
    }

    fn vals(v: Value) -> Vec<Value> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|x| match x {
                Value::Object(m) => Value::Object(m.clone()),
                other => other.clone(),
            })
            .collect()
    }

    fn rows_json(rs: &[Row]) -> Value {
        Value::Array(rs.iter().map(|r| Value::Object(r.clone())).collect())
    }

    // ─── filter ─────────────────────────────────────────────────────────

    #[test]
    fn filter_operators() {
        let data = rows(json!([
            {"city": "Berlin", "qty": 10, "ok": true, "note": null},
            {"city": "Paris", "qty": "20", "ok": false, "note": "hello world"},
            {"city": "Rome", "qty": 5, "ok": true, "note": "Hello"},
        ]));

        // eq — numeric coercion ("20" == 20) and bool/"true" parity
        let f = node(
            "filter",
            json!({"column": "qty", "operator": "eq", "value": 20}),
        );
        assert_eq!(exec_filter(&f, &data).unwrap().len(), 1);
        let f = node(
            "filter",
            json!({"column": "ok", "operator": "eq", "value": "true"}),
        );
        assert_eq!(exec_filter(&f, &data).unwrap().len(), 2);

        // neq
        let f = node(
            "filter",
            json!({"column": "city", "operator": "neq", "value": "Paris"}),
        );
        let out = exec_filter(&f, &data).unwrap();
        assert_eq!(out.len(), 2);

        // gt / gte / lt / lte (numeric strings compare numerically)
        let f = node(
            "filter",
            json!({"column": "qty", "operator": "gt", "value": 9}),
        );
        assert_eq!(exec_filter(&f, &data).unwrap().len(), 2); // 10, "20"
        let f = node(
            "filter",
            json!({"column": "qty", "operator": "gte", "value": 10}),
        );
        assert_eq!(exec_filter(&f, &data).unwrap().len(), 2);
        let f = node(
            "filter",
            json!({"column": "qty", "operator": "lt", "value": 10}),
        );
        assert_eq!(exec_filter(&f, &data).unwrap().len(), 1); // 5
        let f = node(
            "filter",
            json!({"column": "qty", "operator": "lte", "value": 10}),
        );
        assert_eq!(exec_filter(&f, &data).unwrap().len(), 2);

        // string compare fallback when either side is non-numeric
        let f = node(
            "filter",
            json!({"column": "city", "operator": "gt", "value": "Paris"}),
        );
        let out = exec_filter(&f, &data).unwrap();
        assert_eq!(out.len(), 1); // "Rome" > "Paris"

        // contains — case-insensitive, null → ""
        let f = node(
            "filter",
            json!({"column": "note", "operator": "contains", "value": "hello"}),
        );
        assert_eq!(exec_filter(&f, &data).unwrap().len(), 2);
        let f = node(
            "filter",
            json!({"column": "note", "operator": "contains", "value": ""}),
        );
        assert_eq!(exec_filter(&f, &data).unwrap().len(), 3); // null → "" contains ""

        // unknown operator → exact legacy message
        let f = node(
            "filter",
            json!({"column": "qty", "operator": "regex", "value": 1}),
        );
        let e = exec_filter(&f, &data).unwrap_err();
        assert_eq!(
            e.0,
            "Unknown filter operator 'regex' (supported: eq, neq, gt, gte, lt, lte, contains)"
        );
    }

    #[test]
    fn filter_missing_cell_is_undefined_not_null() {
        let data = rows(json!([{"a": null}, {"a": 1}, {}]));
        // eq null: only the explicit null matches (undefined !== null in JS)
        let f = node(
            "filter",
            json!({"column": "a", "operator": "eq", "value": null}),
        );
        assert_eq!(exec_filter(&f, &data).unwrap().len(), 1);
        // missing value in the node data behaves as undefined: matches only
        // rows where the cell is missing too
        let f = node("filter", json!({"column": "a", "operator": "eq"}));
        assert_eq!(exec_filter(&f, &data).unwrap().len(), 1);
    }

    #[test]
    fn filter_requires_string_column_and_operator() {
        let data = rows(json!([{"a": 1}]));
        let f = node("filter", json!({"operator": "eq", "value": 1}));
        assert_eq!(
            exec_filter(&f, &data).unwrap_err().0,
            "filter node 'filter-1' requires a string 'column'"
        );
        let f = node("filter", json!({"column": "a", "value": 1}));
        assert_eq!(
            exec_filter(&f, &data).unwrap_err().0,
            "filter node 'filter-1' requires a string 'operator'"
        );
    }

    // ─── derive ─────────────────────────────────────────────────────────

    #[test]
    fn derive_bare_identifiers_and_row_access() {
        let data = rows(json!([
            {"quantity": 2, "unit_price_at_sale": 1.5},
            {"quantity": 3, "unit_price_at_sale": 2},
        ]));
        let d = node(
            "derive",
            json!({"newColumn": "revenue", "expression": "quantity * unit_price_at_sale"}),
        );
        let (out, failed) = exec_derive(&d, &data).unwrap();
        assert_eq!(failed, 0);
        assert_eq!(
            rows_json(&out),
            json!([
                {"quantity": 2, "unit_price_at_sale": 1.5, "revenue": 3},
                {"quantity": 3, "unit_price_at_sale": 2, "revenue": 6},
            ])
        );
        // row.col access always works too
        let d = node(
            "derive",
            json!({"newColumn": "rev", "expression": "row.quantity * 10"}),
        );
        let (out, failed) = exec_derive(&d, &data).unwrap();
        assert_eq!(failed, 0);
        assert_eq!(out[0].get("rev"), Some(&json!(20)));
    }

    #[test]
    fn derive_dangerous_expression_rejected() {
        let data = rows(json!([{"a": 1}]));
        let d = node(
            "derive",
            json!({"newColumn": "x", "expression": "process.exit(1)"}),
        );
        assert_eq!(
            exec_derive(&d, &data).unwrap_err().0,
            "derive node 'derive-1': expression contains disallowed identifier"
        );
        let d = node(
            "derive",
            json!({"newColumn": "x", "expression": "fetch('http://x')"}),
        );
        assert_eq!(
            exec_derive(&d, &data).unwrap_err().0,
            "derive node 'derive-1': expression contains disallowed identifier"
        );
    }

    #[test]
    fn derive_invalid_expression_error_shape() {
        let data = rows(json!([{"a": 1}]));
        let d = node("derive", json!({"newColumn": "x", "expression": "a +* 2"}));
        let e = exec_derive(&d, &data).unwrap_err().0;
        assert!(
            e.starts_with("derive node 'derive-1': invalid expression — "),
            "got: {e}"
        );
    }

    #[test]
    fn derive_per_row_failures_counted() {
        let data = rows(json!([{"a": 2}, {"a": null}, {}]));
        let d = node(
            "derive",
            json!({"newColumn": "x", "expression": "a.toFixed(2)"}),
        );
        let (out, failed) = exec_derive(&d, &data).unwrap();
        // row 0 ok; rows 1/2 throw on null/undefined receiver
        assert_eq!(failed, 2);
        assert_eq!(out[0].get("x"), Some(&json!("2.00")));
        assert_eq!(out[1].get("x"), Some(&json!(null)));
        assert_eq!(out[2].get("x"), Some(&json!(null)));
    }

    #[test]
    fn derive_overwrites_existing_column_in_place() {
        let data = rows(json!([{"a": 1, "b": 2}]));
        let d = node("derive", json!({"newColumn": "a", "expression": "b * 10"}));
        let (out, _) = exec_derive(&d, &data).unwrap();
        // JS spread keeps the original key position when overwriting
        let keys: Vec<&String> = out[0].keys().collect();
        assert_eq!(keys, vec!["a", "b"]);
        assert_eq!(out[0].get("a"), Some(&json!(20)));
    }

    // ─── select / rename ────────────────────────────────────────────────

    #[test]
    fn select_keeps_order_and_skips_missing() {
        let data = rows(json!([{"a": 1, "b": 2, "c": 3}]));
        let s = node("select", json!({"columns": ["c", "a", "zz"]}));
        let out = exec_select(&s, &data).unwrap();
        assert_eq!(rows_json(&out), json!([{"c": 3, "a": 1}]));

        let bad = node("select", json!({"columns": []}));
        assert_eq!(
            exec_select(&bad, &data).unwrap_err().0,
            "select node 'select-1' requires a non-empty string array 'columns'"
        );
        let bad = node("select", json!({"columns": ["a", 3]}));
        assert_eq!(
            exec_select(&bad, &data).unwrap_err().0,
            "select node 'select-1' requires a non-empty string array 'columns'"
        );
    }

    #[test]
    fn rename_maps_columns() {
        let data = rows(json!([{"old": 1, "keep": 2}, {"old": 3}]));
        let r = node("rename", json!({"mapping": {"old": "new", "noop": ""}}));
        let out = exec_rename(&r, &data).unwrap();
        assert_eq!(rows_json(&out), json!([{"new": 1, "keep": 2}, {"new": 3}]));

        let bad = node("rename", json!({}));
        assert_eq!(
            exec_rename(&bad, &data).unwrap_err().0,
            "rename node 'rename-1' requires a 'mapping' object of { oldName: newName }"
        );
    }

    // ─── join ───────────────────────────────────────────────────────────

    #[test]
    fn join_inner_and_left_with_suffix_and_nulls() {
        let left = rows(json!([
            {"id": 1, "name": "a"},
            {"id": "2", "name": "b"},
            {"id": 3, "name": "c"},
        ]));
        let right = rows(json!([
            {"id": 1, "score": 10, "name": "right-a"},
            {"id": 1, "score": 11},
            {"id": 2, "score": 20},
        ]));
        let j = node(
            "join",
            json!({"how": "inner", "leftKey": "id", "rightKey": "id"}),
        );
        let out = exec_join(&j, &[left.clone(), right.clone()]).unwrap();
        // id 1 matches twice (multi-match fan-out), "2"==2 numeric key match;
        // the right "id" column collides with the left one → "right_id".
        assert_eq!(
            rows_json(&out),
            json!([
                {"id": 1, "name": "a", "right_id": 1, "score": 10, "right_name": "right-a"},
                {"id": 1, "name": "a", "right_id": 1, "score": 11, "right_name": null},
                {"id": "2", "name": "b", "right_id": 2, "score": 20, "right_name": null},
            ])
        );

        let j = node(
            "join",
            json!({"how": "left", "leftKey": "id", "rightKey": "id"}),
        );
        let out = exec_join(&j, &[left.clone(), right.clone()]).unwrap();
        assert_eq!(out.len(), 4);
        // unmatched left row gets every right column as null
        assert_eq!(
            Value::Object(out[3].clone()),
            json!({"id": 3, "name": "c", "right_id": null, "score": null, "right_name": null})
        );

        // how validation
        let j = node(
            "join",
            json!({"how": "full", "leftKey": "id", "rightKey": "id"}),
        );
        assert_eq!(
            exec_join(&j, &[left.clone(), right.clone()]).unwrap_err().0,
            "join node 'join-1': 'how' must be 'inner' or 'left' (got 'full')"
        );
        // arity
        let j = node("join", json!({"leftKey": "id", "rightKey": "id"}));
        let out = exec_join(&j, std::slice::from_ref(&left)).unwrap_err();
        assert_eq!(
            out.0,
            "join node 'join-1' requires exactly 2 inputs (found 1)"
        );
    }

    #[test]
    fn join_missing_keys_group_under_undefined() {
        let left = rows(json!([{"n": 1}, {"n": 2}]));
        let right = rows(json!([{"v": "x"}, {"v": "y"}]));
        let j = node(
            "join",
            json!({"how": "inner", "leftKey": "k", "rightKey": "k"}),
        );
        let out = exec_join(&j, &[left, right]).unwrap();
        // every row on both sides has key "undefined" → 2x2 fan-out (legacy keyOf)
        assert_eq!(out.len(), 4);
    }

    // ─── aggregate ──────────────────────────────────────────────────────

    #[test]
    fn aggregate_group_by_with_all_ops() {
        let data = rows(json!([
            {"city": "Berlin", "qty": 10, "missing": null},
            {"city": "Berlin", "qty": "5"},
            {"city": "Paris", "qty": 4},
            {"city": "Paris", "qty": 7},
            {"city": "Paris", "qty": "abc"},
        ]));
        let a = node(
            "aggregate",
            json!({
                "groupBy": ["city"],
                "ops": [
                    {"op": "sum", "column": "qty"},
                    {"op": "avg", "column": "qty", "alias": "avgQty"},
                    {"op": "min", "column": "qty"},
                    {"op": "max", "column": "qty"},
                    {"op": "count"},
                    {"op": "count", "column": "missing", "alias": "missingCount"},
                ],
            }),
        );
        let out = exec_aggregate(&a, &data).unwrap();
        assert_eq!(
            rows_json(&out),
            json!([
                {"city": "Berlin", "sum_qty": 15, "avgQty": 7.5, "min_qty": 5, "max_qty": 10, "count": 2, "missingCount": 0},
                {"city": "Paris", "sum_qty": 11, "avgQty": 5.5, "min_qty": 4, "max_qty": 7, "count": 3, "missingCount": 0},
            ])
        );
    }

    #[test]
    fn aggregate_global_when_no_group_by() {
        let data = rows(json!([{"q": 1}, {"q": 2}]));
        let a = node(
            "aggregate",
            json!({"ops": [{"op": "count"}, {"op": "sum", "column": "q"}]}),
        );
        let out = exec_aggregate(&a, &data).unwrap();
        assert_eq!(rows_json(&out), json!([{"count": 2, "sum_q": 3}]));

        // empty input, no groupBy → single group with null aggregates
        let out = exec_aggregate(&a, &[]).unwrap();
        assert_eq!(rows_json(&out), json!([{"count": 0, "sum_q": null}]));
    }

    #[test]
    fn aggregate_float_noise_rounded() {
        let data = rows(json!([{"q": 0.1}, {"q": 0.2}]));
        let a = node("aggregate", json!({"ops": [{"op": "sum", "column": "q"}]}));
        let out = exec_aggregate(&a, &data).unwrap();
        assert_eq!(out[0].get("sum_q"), Some(&json!(0.3)));
    }

    #[test]
    fn aggregate_errors() {
        let data = rows(json!([{"q": 1}]));
        let a = node("aggregate", json!({"ops": []}));
        assert_eq!(
            exec_aggregate(&a, &data).unwrap_err().0,
            "aggregate node 'aggregate-1' requires a non-empty 'ops' array"
        );
        let a = node(
            "aggregate",
            json!({"groupBy": "q", "ops": [{"op": "count"}]}),
        );
        assert_eq!(
            exec_aggregate(&a, &data).unwrap_err().0,
            "aggregate node 'aggregate-1': 'groupBy' must be an array of column names"
        );
        let a = node(
            "aggregate",
            json!({"ops": [{"op": "median", "column": "q"}]}),
        );
        assert_eq!(
            exec_aggregate(&a, &data).unwrap_err().0,
            "aggregate node 'aggregate-1': unknown op 'median' (supported: sum, avg, min, max, count)"
        );
        let a = node("aggregate", json!({"ops": [{"op": "sum"}]}));
        assert_eq!(
            exec_aggregate(&a, &data).unwrap_err().0,
            "aggregate node 'aggregate-1': op 'sum' requires a 'column'"
        );
    }

    // ─── sort ───────────────────────────────────────────────────────────

    #[test]
    fn sort_multi_key_numeric_and_string() {
        let data = rows(json!([
            {"city": "Berlin", "qty": 2},
            {"city": "Aachen", "qty": 10},
            {"city": "Berlin", "qty": 1},
            {"city": "Aachen", "qty": "3"},
        ]));
        let s = node(
            "sort",
            json!({"by": [{"column": "city", "dir": "asc"}, {"column": "qty", "dir": "desc"}]}),
        );
        let out = exec_sort(&s, &data).unwrap();
        assert_eq!(
            rows_json(&out),
            json!([
                {"city": "Aachen", "qty": 10},
                {"city": "Aachen", "qty": "3"},
                {"city": "Berlin", "qty": 2},
                {"city": "Berlin", "qty": 1},
            ])
        );
        // dir defaults to asc when not "desc"
        let s = node("sort", json!({"by": [{"column": "qty"}]}));
        let out = exec_sort(&s, &data).unwrap();
        assert_eq!(out[0].get("qty"), Some(&json!(1)));
        assert_eq!(out[3].get("qty"), Some(&json!(10))); // numeric, "3" between 2 and 10
        assert_eq!(out[2].get("qty"), Some(&json!("3")));

        let bad = node("sort", json!({"by": []}));
        assert_eq!(
            exec_sort(&bad, &data).unwrap_err().0,
            "sort node 'sort-1' requires a non-empty 'by' array of { column, dir }"
        );
        let bad = node("sort", json!({"by": [{"dir": "asc"}]}));
        assert_eq!(
            exec_sort(&bad, &data).unwrap_err().0,
            "sort node 'sort-1': each by entry needs a string 'column'"
        );
    }

    // ─── dedupe ─────────────────────────────────────────────────────────

    #[test]
    fn dedupe_whole_rows_and_keys() {
        let data = rows(json!([
            {"a": 1, "b": "x"},
            {"a": 1, "b": "x"},
            {"a": 1, "b": "y"},
            {"b": "x", "a": 1},
        ]));
        let d = node("dedupe", json!({}));
        let out = exec_dedupe(&d, &data).unwrap();
        // key order does not matter for whole-row dedupe (sorted-keys hash):
        // rows 0/1/3 are identical → one survivor, plus the "y" variant.
        assert_eq!(out.len(), 2);

        let data2 = rows(json!([
            {"id": "1", "v": "a"},
            {"id": 1, "v": "b"},
            {"id": 2, "v": "c"},
        ]));
        let d = node("dedupe", json!({"keys": ["id"]}));
        let out = exec_dedupe(&d, &data2).unwrap();
        // "1" and 1 canonicalize to the same key → first occurrence wins
        assert_eq!(
            rows_json(&out),
            json!([{"id": "1", "v": "a"}, {"id": 2, "v": "c"}])
        );

        let bad = node("dedupe", json!({"keys": "id"}));
        assert_eq!(
            exec_dedupe(&bad, &data).unwrap_err().0,
            "dedupe node 'dedupe-1': 'keys' must be an array of column names"
        );
    }

    // ─── union ──────────────────────────────────────────────────────────

    #[test]
    fn union_fills_missing_columns_with_null() {
        let a = rows(json!([{"x": 1, "y": 2}]));
        let b = rows(json!([{"y": 3, "z": 4}]));
        let u = node("union", json!({}));
        let out = exec_union(&u, &[a, b]).unwrap();
        assert_eq!(
            rows_json(&out),
            json!([
                {"x": 1, "y": 2, "z": null},
                {"x": null, "y": 3, "z": 4},
            ])
        );
        let out = exec_union(&u, &[rows(json!([{"x":1}]))]).unwrap_err();
        assert_eq!(
            out.0,
            "union node 'union-1' requires exactly 2 inputs (found 1)"
        );
    }

    // ─── limit ──────────────────────────────────────────────────────────

    #[test]
    fn limit_slices_and_validates() {
        let data = rows(json!([{"a": 1}, {"a": 2}, {"a": 3}]));
        let l = node("limit", json!({"n": 2}));
        assert_eq!(exec_limit(&l, &data).unwrap().len(), 2);
        let l = node("limit", json!({"n": 0}));
        assert_eq!(exec_limit(&l, &data).unwrap().len(), 0);
        let l = node("limit", json!({"n": 10}));
        assert_eq!(exec_limit(&l, &data).unwrap().len(), 3);
        for bad in [
            json!({"n": -1}),
            json!({"n": 1.5}),
            json!({"n": "2"}),
            json!({}),
        ] {
            let l = node("limit", bad);
            assert_eq!(
                exec_limit(&l, &data).unwrap_err().0,
                "limit node 'limit-1' requires a non-negative integer 'n'"
            );
        }
        // JS Number.isInteger(2.0) === true
        let l = node("limit", json!({"n": 2.0}));
        assert_eq!(exec_limit(&l, &data).unwrap().len(), 2);
    }

    // ─── misc ───────────────────────────────────────────────────────────

    #[test]
    fn unused_helper_coverage() {
        // keep vals() referenced (test-helper parity with legacy fixtures)
        assert_eq!(vals(json!([1, {"a": 2}])), vec![json!(1), json!({"a": 2})]);
    }
}
