//! Pure value helpers — ports of the legacy dataset-service/ontology-service
//! primitives (toNumber, compareValues, looseEqual, formatCell, groupLabel,
//! normalizeRows, generatePk). No I/O; unit-tested.

use mf_types::{Row, Value};

// ─── JS-compatible number coercion ────────────────────────────────────────

/// Port of `toNumber()` (dataset-service.ts): number → itself, boolean → 1/0,
/// non-blank string → Number(s) when finite, everything else → NaN.
pub fn to_number(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::Bool(b) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                f64::NAN
            } else {
                js_parse_number(t)
            }
        }
        _ => f64::NAN,
    }
}

/// Approximation of JS `Number(str)` for the values datasets carry: plain
/// decimals + exponent notation. Returns NaN when not finite-numeric (JS
/// hex literals like "0x10" are NOT accepted — documented deviation).
fn js_parse_number(t: &str) -> f64 {
    match t.parse::<f64>() {
        Ok(n) if n.is_finite() => n,
        _ => f64::NAN,
    }
}

/// Finite number from a cell, or None (port of the dashboard-data `toNumber`
/// which returns null for non-numeric cells — booleans are NOT numeric there).
pub fn cell_number(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64().filter(|f| f.is_finite()),
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                None
            } else {
                let n = js_parse_number(t);
                if n.is_nan() {
                    None
                } else {
                    Some(n)
                }
            }
        }
        _ => None,
    }
}

/// Port of `compareValues()`: numeric compare when BOTH sides are numeric,
/// otherwise string compare of `String(a ?? '')`.
pub fn compare_values(a: &Value, b: &Value) -> std::cmp::Ordering {
    let x = to_number(a);
    let y = to_number(b);
    if !x.is_nan() && !y.is_nan() {
        return x.partial_cmp(&y).unwrap_or(std::cmp::Ordering::Equal);
    }
    let sa = js_string(&null_to_empty(a));
    let sb = js_string(&null_to_empty(b));
    sa.cmp(&sb)
}

fn null_to_empty(v: &Value) -> Value {
    match v {
        Value::Null => Value::String(String::new()),
        other => other.clone(),
    }
}

/// Port of `looseEqual()`: identical, numerically equal, or string-equal.
pub fn loose_equal(a: &Value, b: &Value) -> bool {
    if a == b {
        return true;
    }
    if a.is_null() || b.is_null() {
        return false;
    }
    let na = to_number(a);
    let nb = to_number(b);
    if !na.is_nan() && !nb.is_nan() {
        return na == nb;
    }
    js_string(a) == js_string(b)
}

/// `String(v)` for a JSON cell (JS semantics): null → 'null' inside
/// stringification contexts but String(null) === 'null'; the legacy helpers
/// call String(a ?? '') — callers handle the nullish case. Numbers format
/// like JS (integers without a decimal point).
pub fn js_string(v: &Value) -> String {
    match v {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_number_string(n),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// JS `String(number)` formatting: integers stay bare, floats use the
/// shortest round-trip representation (serde_json's ryu output matches JS
/// for normal magnitudes).
pub fn js_number_string(n: &serde_json::Number) -> String {
    if let Some(i) = n.as_i64() {
        return i.to_string();
    }
    if let Some(u) = n.as_u64() {
        return u.to_string();
    }
    if let Some(f) = n.as_f64() {
        if f.is_finite() && f == f.trunc() && f.abs() < 1e21 {
            // JS prints whole floats without a fraction: String(42.0) === '42'
            return format!("{}", f as i64);
        }
        return serde_json::Number::from_f64(f)
            .map(|n| n.to_string())
            .unwrap_or_else(|| "NaN".to_string());
    }
    n.to_string()
}

/// Numeric echo for query-param round-trips: JS `Number('1')` echoes `1`,
/// `Number('2.7')` echoes `2.7`.
pub fn js_num(f: f64) -> Value {
    if f.is_finite() && f == f.trunc() && f.abs() < 1e15 {
        serde_json::json!((f as i64))
    } else {
        Value::Number(serde_json::Number::from_f64(f).unwrap_or_else(|| serde_json::Number::from(0)))
    }
}

/// JSON.stringify of a row's values (query filter input): a JSON array of the
/// row's values in insertion order.
pub fn stringify_values(row: &Row) -> String {
    Value::Array(row.values().cloned().collect()).to_string()
}

/// Port of `formatCell()` (action messages).
pub fn format_cell(v: &Value) -> String {
    match v {
        // JS: undefined → '(missing)' — a JSON body cannot carry undefined;
        // absent params are handled before coercion. Null keeps '(null)'.
        Value::Null => "(null)".to_string(),
        Value::Object(_) | Value::Array(_) => v.to_string(),
        other => js_string(other),
    }
}

/// Stable display label for a group key (dashboard widgets): nullish/'' →
/// '(empty)', booleans → 'true'/'false', else String(v).
pub fn group_label(v: &Value) -> String {
    match v {
        Value::Null => "(empty)".to_string(),
        Value::String(s) if s.is_empty() => "(empty)".to_string(),
        Value::Bool(b) => b.to_string(),
        other => js_string(other),
    }
}

/// One aggregate over a group (port of dashboard-data `aggregate`):
/// count uses the row count; numeric aggs over the collected values with an
/// EMPTY-group fallback of 0.
pub fn aggregate(agg: &str, count: usize, values: &[f64]) -> f64 {
    match agg {
        "count" => count as f64,
        "sum" => values.iter().sum(),
        "avg" => {
            if values.is_empty() {
                0.0
            } else {
                values.iter().sum::<f64>() / values.len() as f64
            }
        }
        "min" => values
            .iter()
            .cloned()
            .min_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
            .unwrap_or(0.0),
        "max" => values
            .iter()
            .cloned()
            .max_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
            .unwrap_or(0.0),
        _ => count as f64,
    }
}

/// Port of `normalizeValue()` (dataset-service): trim strings, "true"/"false"
/// → bool, plain-decimal strings → number (identifier-like values preserved).
pub fn normalize_value(v: &Value) -> Value {
    let Value::String(s) = v else { return v.clone() };
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
    if is_plain_decimal(t) && !has_leading_zero(t) {
        if let Some(n) = parse_json_number(t) {
            return Value::Number(n);
        }
    }
    Value::String(t.to_string())
}

/// /^-?(?:\d+\.?\d*|\.\d+)$/ — plain decimal, no exponent, no leading '+'.
fn is_plain_decimal(t: &str) -> bool {
    let bytes = t.as_bytes();
    let mut i = 0;
    if bytes.first() == Some(&b'-') {
        i = 1;
    }
    let mut digits_before = 0usize;
    let mut digits_after = 0usize;
    let mut dots = 0usize;
    for &b in &bytes[i..] {
        match b {
            b'0'..=b'9' => {
                if dots == 0 {
                    digits_before += 1;
                } else {
                    digits_after += 1;
                }
            }
            b'.' => {
                dots += 1;
                if dots > 1 {
                    return false;
                }
            }
            _ => return false,
        }
    }
    (digits_before + digits_after) > 0
}

/// /^-?0\d/ — leading zeros keep the value a string (ZIP codes etc.).
fn has_leading_zero(t: &str) -> bool {
    let body = t.strip_prefix('-').unwrap_or(t);
    let mut chars = body.chars();
    chars.next() == Some('0') && chars.next().is_some_and(|c| c.is_ascii_digit())
}

/// Parse into a serde_json Number, preferring integers (JS Number is f64 but
/// JSON round-trips integers exactly; safe-integer rule from normalizeValue).
fn parse_json_number(t: &str) -> Option<serde_json::Number> {
    let f: f64 = t.parse().ok()?;
    if !f.is_finite() {
        return None;
    }
    if f == f.trunc() && f.abs() <= 9_007_199_254_740_991.0 {
        if let Ok(i) = t.parse::<i64>() {
            return Some(serde_json::Number::from(i));
        }
    }
    serde_json::Number::from_f64(f)
}

/// Trim keys + normalize every cell (port of `normalizeRows`).
pub fn normalize_rows(rows: &[Row]) -> Vec<Row> {
    rows.iter()
        .map(|raw| {
            let mut out = Row::new();
            for (k, v) in raw {
                let key = k.trim();
                let key = if key.is_empty() { k.as_str() } else { key };
                out.insert(key.to_string(), normalize_value(v));
            }
            out
        })
        .collect()
}

/// Port of `generatePk()`: max+1 when every existing pk is numeric,
/// PREFIX-#### increment when they all share that pattern, else NEW-<ts36>.
pub fn generate_pk(rows: &[Row], column: &str) -> Value {
    let values: Vec<&Value> = rows
        .iter()
        .filter_map(|r| r.get(column))
        .filter(|v| !v.is_null() && !(matches!(v, Value::String(s) if s.trim().is_empty())))
        .collect();
    if values.is_empty() {
        return Value::String(new_fallback_pk());
    }

    let nums: Vec<f64> = values.iter().map(|v| to_number(v)).collect();
    if nums.iter().all(|n| !n.is_nan()) {
        let max = nums.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        let next = max + 1.0;
        if next == next.trunc() && next.abs() <= i64::MAX as f64 {
            return Value::Number(serde_json::Number::from(next as i64));
        }
        return Value::Number(serde_json::Number::from_f64(next).unwrap_or_else(|| serde_json::Number::from(0)));
    }

    // /^([A-Za-z][A-Za-z0-9]*?)-(\d+)$/ shared prefix pattern
    let re = regex::Regex::new(r"^([A-Za-z][A-Za-z0-9]*?)-([0-9]+)$").expect("static regex");
    let mut matches: Vec<(String, String)> = Vec::with_capacity(values.len());
    for v in &values {
        let s = js_string(v);
        match re.captures(&s) {
            Some(c) => matches.push((c[1].to_string(), c[2].to_string())),
            None => return Value::String(new_fallback_pk()),
        }
    }
    let prefix = matches[0].0.clone();
    if matches.iter().all(|(p, _)| *p == prefix) {
        let width = matches.iter().map(|(_, d)| d.len()).max().unwrap_or(1);
        let max = matches
            .iter()
            .filter_map(|(_, d)| d.parse::<i64>().ok())
            .max()
            .unwrap_or(0);
        return Value::String(format!("{prefix}-{:0>width$}", max + 1, width = width));
    }
    Value::String(new_fallback_pk())
}

/// `NEW-${Date.now().toString(36).toUpperCase()}`
fn new_fallback_pk() -> String {
    let ms = chrono::Utc::now().timestamp_millis();
    format!("NEW-{}", to_base36(ms).to_uppercase())
}

/// JS `Number.prototype.toString(36)` for non-negative integers.
fn to_base36(mut n: i64) -> String {
    if n == 0 {
        return "0".to_string();
    }
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    while n > 0 {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_else(|_| "0".into())
}

/// Row index whose pk column loosely equals `pk_value` (port of
/// findRowIndexByPk); None when no row matches.
pub fn find_row_index_by_pk(rows: &[Row], pk_column: &str, pk_value: &Value) -> Option<usize> {
    rows.iter()
        .position(|row| match row.get(pk_column) {
            Some(cell) => loose_equal(cell, pk_value),
            None => pk_value.is_null(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row(pairs: Vec<(&str, Value)>) -> Row {
        let mut m = Row::new();
        for (k, v) in pairs {
            m.insert(k.to_string(), v);
        }
        m
    }

    #[test]
    fn to_number_matches_js() {
        assert_eq!(to_number(&json!(42)), 42.0);
        assert_eq!(to_number(&json!("42")), 42.0);
        assert_eq!(to_number(&json!(" -3.5 ")), -3.5);
        assert!(to_number(&json!("")).is_nan());
        assert!(to_number(&json!("abc")).is_nan());
        assert!(to_number(&Value::Null).is_nan());
        assert_eq!(to_number(&json!(true)), 1.0);
        assert_eq!(to_number(&json!(false)), 0.0);
        assert!(to_number(&json!("Infinity")).is_nan());
    }

    #[test]
    fn compare_numeric_then_string() {
        assert_eq!(compare_values(&json!(2), &json!("10")), std::cmp::Ordering::Less);
        assert_eq!(compare_values(&json!("b"), &json!("a")), std::cmp::Ordering::Greater);
        assert_eq!(compare_values(&json!("5"), &json!(5)), std::cmp::Ordering::Equal);
    }

    #[test]
    fn loose_equal_tolerant() {
        assert!(loose_equal(&json!("5"), &json!(5)));
        assert!(loose_equal(&json!("a"), &json!("a")));
        assert!(!loose_equal(&Value::Null, &json!("a")));
        assert!(!loose_equal(&json!("a"), &json!("b")));
        assert!(loose_equal(&json!(true), &json!(true)));
    }

    #[test]
    fn js_number_string_matches_js() {
        assert_eq!(js_number_string(&serde_json::Number::from(42)), "42");
        assert_eq!(js_number_string(&serde_json::Number::from_f64(42.0).unwrap()), "42");
        assert_eq!(js_number_string(&serde_json::Number::from_f64(4.25).unwrap()), "4.25");
    }

    #[test]
    fn format_cell_specials() {
        assert_eq!(format_cell(&Value::Null), "(null)");
        assert_eq!(format_cell(&json!("x")), "x");
        assert_eq!(format_cell(&json!(3)), "3");
        assert_eq!(format_cell(&json!({"a":1})), r#"{"a":1}"#);
    }

    #[test]
    fn group_label_collapses_empty() {
        assert_eq!(group_label(&Value::Null), "(empty)");
        assert_eq!(group_label(&json!("")), "(empty)");
        assert_eq!(group_label(&json!(true)), "true");
        assert_eq!(group_label(&json!(7)), "7");
        assert_eq!(group_label(&json!("x")), "x");
    }

    #[test]
    fn aggregates() {
        assert_eq!(aggregate("count", 3, &[]), 3.0);
        assert_eq!(aggregate("sum", 0, &[1.0, 2.5]), 3.5);
        assert_eq!(aggregate("avg", 0, &[1.0, 2.0]), 1.5);
        assert_eq!(aggregate("avg", 0, &[]), 0.0);
        assert_eq!(aggregate("min", 0, &[3.0, 1.0]), 1.0);
        assert_eq!(aggregate("min", 0, &[]), 0.0);
        assert_eq!(aggregate("max", 0, &[3.0, 1.0]), 3.0);
        assert_eq!(aggregate("max", 0, &[]), 0.0);
    }

    #[test]
    fn normalize_value_rules() {
        assert_eq!(normalize_value(&json!(" 42 ")), json!(42));
        assert_eq!(normalize_value(&json!("true")), json!(true));
        assert_eq!(normalize_value(&json!("false")), json!(false));
        assert_eq!(normalize_value(&json!(" 007 ")), json!("007"));
        assert_eq!(normalize_value(&json!("")), json!(""));
        assert_eq!(normalize_value(&json!("  ")), json!(""));
        assert_eq!(normalize_value(&json!("1e3")), json!("1e3"));
        assert_eq!(normalize_value(&json!("abc ")), json!("abc"));
        assert_eq!(normalize_value(&json!(7)), json!(7));
        assert_eq!(normalize_value(&json!("-2.25")), json!(-2.25));
    }

    #[test]
    fn generate_pk_numeric_increment() {
        let rows = vec![
            row(vec![("id", json!(3))]),
            row(vec![("id", json!(10))]),
        ];
        assert_eq!(generate_pk(&rows, "id"), json!(11));
    }

    #[test]
    fn generate_pk_prefix_pattern() {
        let rows = vec![
            row(vec![("id", json!("CUST-0009"))]),
            row(vec![("id", json!("CUST-0010"))]),
        ];
        assert_eq!(generate_pk(&rows, "id"), json!("CUST-0011"));
        let mixed = vec![row(vec![("id", json!("A-1"))]), row(vec![("id", json!("B-2"))])];
        let v = generate_pk(&mixed, "id");
        assert!(matches!(v, Value::String(s) if s.starts_with("NEW-")));
    }

    #[test]
    fn generate_pk_empty_fallback() {
        let v = generate_pk(&[], "id");
        assert!(matches!(v, Value::String(s) if s.starts_with("NEW-")));
    }

    #[test]
    fn base36_matches_js() {
        assert_eq!(to_base36(0), "0");
        assert_eq!(to_base36(35), "z");
        assert_eq!(to_base36(36), "10");
        // JS: (123456).toString(36) === '2n9c'
        assert_eq!(to_base36(123456), "2n9c");
    }

    #[test]
    fn find_row_index_loose() {
        let rows = vec![row(vec![("id", json!("A"))]), row(vec![("id", json!(5))])];
        assert_eq!(find_row_index_by_pk(&rows, "id", &json!("A")), Some(0));
        assert_eq!(find_row_index_by_pk(&rows, "id", &json!("5")), Some(1));
        assert_eq!(find_row_index_by_pk(&rows, "id", &json!("nope")), None);
    }

    #[test]
    fn stringify_values_shape() {
        let r = row(vec![("a", json!("x")), ("b", json!(1)), ("c", Value::Null)]);
        assert_eq!(stringify_values(&r), r#"["x",1,null]"#);
    }
}
