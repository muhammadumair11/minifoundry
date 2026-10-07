//! JavaScript value-semantics helpers.
//!
//! The legacy contracts embed JS behaviors in observable strings: `String(v)`
//! coercion in quality messages / diff keys, `Number(s)` parsing in
//! comparisons, `Math.round` (half-up) in freshness metrics and JSON number
//! formatting (`22` not `22.0`). These helpers reproduce exactly the subset
//! the catalog domain exercises.

use serde_json::{Map, Value};

/// JS `Math.round` — half UP (toward +∞), NOT half away from zero.
pub fn js_round(x: f64) -> i64 {
    if !x.is_finite() {
        return 0;
    }
    (x + 0.5).floor() as i64
}

/// Format a JS number the way template literals / String(n) do.
/// Covers the learning-scale domain exactly (integers without `.0`, shortest
/// round-trip decimals); exponent-form extremes (|x| >= 1e21, < 1e-6) keep
/// Rust's positional rendering — a documented, contract-invisible deviation.
pub fn js_num_to_string(n: f64) -> String {
    if n.is_nan() {
        return "NaN".to_string();
    }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if n.fract() == 0.0 && n.abs() < 1e15 {
        // integer-valued → no decimal point (JS prints 22, -0 → "0")
        let i = n as i64;
        return i.to_string();
    }
    format!("{n}")
}

/// serde_json Number → JS string form.
pub fn js_number_string(n: &serde_json::Number) -> String {
    if let Some(u) = n.as_u64() {
        return u.to_string();
    }
    if let Some(i) = n.as_i64() {
        return i.to_string();
    }
    if let Some(f) = n.as_f64() {
        return js_num_to_string(f);
    }
    n.to_string()
}

/// Build the JSON Value JS would produce for a computed number: integers as
/// integer JSON values (`22`), everything else as f64 (`97.2`).
pub fn js_number_value(v: f64) -> Value {
    if v.is_finite() && v.fract() == 0.0 && v.abs() <= 9_007_199_254_740_991.0 {
        Value::Number(serde_json::Number::from(v as i64))
    } else {
        serde_json::Number::from_f64(v).map(Value::Number).unwrap_or(Value::Null)
    }
}

/// JS `String(v)` for row-cell values (string | number | bool | null | json).
pub fn js_stringify(v: &Value) -> String {
    match v {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_number_string(n),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// JS `String(a ?? '')` — the compareValues/diff fallback (null → "").
pub fn js_stringify_or_empty(v: Option<&Value>) -> String {
    match v {
        None => String::new(),
        Some(Value::Null) => String::new(),
        Some(other) => js_stringify(other),
    }
}

/// JS `Number(s)` for strings — decimal (with exponent), hex/octal/binary
/// literals, Infinity; everything else NaN. Whitespace is trimmed like JS.
pub fn js_parse_number(raw: &str) -> f64 {
    let s = raw.trim();
    if s.is_empty() {
        return 0.0; // Number("") === 0
    }
    match s {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let body = s.strip_prefix('+').unwrap_or(s);
    // hex / octal / binary literals
    for (prefix, radix) in [("0x", 16u32), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(digits) = body.strip_prefix(prefix) {
            let neg = false;
            let _ = neg;
            if !digits.is_empty()
                && digits
                    .chars()
                    .all(|c| c.is_digit(radix))
            {
                if let Ok(n) = i64::from_str_radix(digits, radix) {
                    return n as f64;
                }
            }
            return f64::NAN;
        }
    }
    // plain decimal: ^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$
    if is_js_decimal(body) {
        if let Ok(n) = body.parse::<f64>() {
            return n;
        }
    }
    f64::NAN
}

fn is_js_decimal(s: &str) -> bool {
    let bytes = s.as_bytes();
    let mut i = 0;
    if i < bytes.len() && (bytes[i] == b'-' || bytes[i] == b'+') {
        i += 1;
    }
    let start = i;
    let mut digits_before = 0;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
        digits_before += 1;
    }
    let mut digits_after = 0;
    if i < bytes.len() && bytes[i] == b'.' {
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
            digits_after += 1;
        }
    }
    if digits_before + digits_after == 0 || i == start {
        return false;
    }
    if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
        i += 1;
        if i < bytes.len() && (bytes[i] == b'-' || bytes[i] == b'+') {
            i += 1;
        }
        let exp_start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i == exp_start {
            return false;
        }
    }
    i == bytes.len()
}

/// Port of `toNumber()` (dataset-service.ts): NaN when not numeric.
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
            if s.trim().is_empty() {
                f64::NAN
            } else {
                let n = js_parse_number(s);
                if n.is_finite() {
                    n
                } else {
                    f64::NAN
                }
            }
        }
        _ => f64::NAN,
    }
}

/// Port of `compareValues()` — numeric compare when both sides are numeric,
/// otherwise `String(a ?? '')` vs `String(b ?? '')`.
pub fn compare_values(a: Option<&Value>, b: Option<&Value>) -> std::cmp::Ordering {
    let x = to_number(&a.cloned().unwrap_or(Value::Null));
    let y = to_number(&b.cloned().unwrap_or(Value::Null));
    if !x.is_nan() && !y.is_nan() {
        return x.partial_cmp(&y).unwrap_or(std::cmp::Ordering::Equal);
    }
    let sa = js_stringify_or_empty(a);
    let sb = js_stringify_or_empty(b);
    sa.cmp(&sb)
}

/// Canonical JSON of a row for diff equality: keys sorted, `[["k",v],...]` —
/// byte-identical to the legacy `canonical()` (JSON.stringify of sorted pairs).
pub fn canonical_row(row: &Map<String, Value>) -> String {
    let mut keys: Vec<&String> = row.keys().collect();
    keys.sort();
    let pairs: Vec<(&String, &Value)> = keys.iter().map(|k| (*k, &row[*k])).collect();
    serde_json::to_string(&pairs).unwrap_or_default()
}

/// JS `JSON.stringify(Object.values(row))` — the rows-route search haystack.
pub fn values_json(row: &Map<String, Value>) -> String {
    let values: Vec<&Value> = row.values().collect();
    serde_json::to_string(&values).unwrap_or_default()
}

/// JS `Array.prototype.localeCompare` approximation for ASCII names
/// (case-insensitive primary, case-sensitive tiebreak).
pub fn locale_compare(a: &str, b: &str) -> std::cmp::Ordering {
    let la = a.to_lowercase();
    let lb = b.to_lowercase();
    la.cmp(&lb).then_with(|| a.cmp(b))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn math_round_is_half_up() {
        assert_eq!(js_round(2.5), 3);
        assert_eq!(js_round(-2.5), -2); // JS Math.round(-2.5) === -2
        assert_eq!(js_round(2.4), 2);
        assert_eq!(js_round(0.0), 0);
    }

    #[test]
    fn number_strings_match_js() {
        assert_eq!(js_num_to_string(22.0), "22");
        assert_eq!(js_num_to_string(-3.5), "-3.5");
        assert_eq!(js_num_to_string(97.2), "97.2");
        assert_eq!(js_num_to_string(0.0), "0");
        assert_eq!(js_number_string(json!(140).as_number().unwrap()), "140");
        assert_eq!(js_number_string(json!(0.42).as_number().unwrap()), "0.42");
    }

    #[test]
    fn number_values_keep_integer_form() {
        assert_eq!(js_number_value(12.0), json!(12));
        assert_eq!(js_number_value(12.03), json!(12.03));
        assert_eq!(serde_json::to_string(&js_number_value(12.0)).unwrap(), "12");
    }

    #[test]
    fn parse_number_matches_js() {
        assert_eq!(js_parse_number("42"), 42.0);
        assert_eq!(js_parse_number(" -3.25 "), -3.25);
        assert_eq!(js_parse_number("1e3"), 1000.0);
        assert_eq!(js_parse_number(".5"), 0.5);
        assert_eq!(js_parse_number("5."), 5.0);
        assert_eq!(js_parse_number("0x10"), 16.0);
        assert!(js_parse_number("abc").is_nan());
        assert!(js_parse_number("5abc").is_nan());
        assert!(js_parse_number("true").is_nan());
        assert_eq!(js_parse_number(""), 0.0);
        assert!(js_parse_number("Infinity").is_infinite());
    }

    #[test]
    fn to_number_and_compare() {
        assert_eq!(to_number(&json!(5)), 5.0);
        assert_eq!(to_number(&json!(true)), 1.0);
        assert_eq!(to_number(&json!(" 7 ")), 7.0);
        assert!(to_number(&json!("")).is_nan());
        assert!(to_number(&Value::Null).is_nan());
        assert_eq!(compare_values(Some(&json!(2)), Some(&json!(10))), std::cmp::Ordering::Less);
        // mixed → string compare: "apple" vs "Banana" (case-insensitive NOT applied here)
        assert_eq!(
            compare_values(Some(&json!("apple")), Some(&json!("Banana"))),
            std::cmp::Ordering::Greater
        );
        assert_eq!(compare_values(None, Some(&json!("x"))), std::cmp::Ordering::Less);
    }

    #[test]
    fn canonical_row_is_key_order_insensitive() {
        let a: Map<String, Value> = serde_json::from_str(r#"{"x":1,"a":"t"}"#).unwrap();
        let b: Map<String, Value> = serde_json::from_str(r#"{"a":"t","x":1}"#).unwrap();
        assert_eq!(canonical_row(&a), canonical_row(&b));
        assert_eq!(canonical_row(&a), r#"[["a","t"],["x",1]]"#);
    }

    #[test]
    fn values_json_matches_stringify() {
        let row: Map<String, Value> =
            serde_json::from_str(r#"{"s":"a,b","n":22,"b":true,"z":null}"#).unwrap();
        assert_eq!(values_json(&row), r#"["a,b",22,true,null]"#);
    }

    #[test]
    fn stringify_edge_cases() {
        assert_eq!(js_stringify(&Value::Null), "null");
        assert_eq!(js_stringify(&json!(true)), "true");
        assert_eq!(js_stringify_or_empty(None), "");
        assert_eq!(js_stringify_or_empty(Some(&Value::Null)), "");
    }

    #[test]
    fn locale_compare_ascii() {
        assert_eq!(locale_compare("apple", "Banana"), std::cmp::Ordering::Less);
        assert_eq!(locale_compare("b", "a"), std::cmp::Ordering::Greater);
        assert_eq!(locale_compare("a", "a"), std::cmp::Ordering::Equal);
    }
}
