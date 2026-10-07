//! Value helpers ported 1:1 from `src/lib/dataset-service.ts`
//! (`toNumber`, `compareValues`) plus the engine's canonical key helpers
//! (`keyOf`, `numericEquals`, `roundSmart`) and JS-faithful number/string
//! formatting. Every node executor is written against these so filter/sort/
//! join/aggregate/dedupe behave exactly like the legacy engine.

use serde_json::Value;

/// Port of `toNumber()`: coerce to number; NaN when not numeric.
/// - numbers pass through; booleans → 1/0; non-blank strings → Number(s) when
///   finite (JS accepts decimal, exponent and 0x-hex forms); everything else NaN.
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
                js_number_from_str(t)
            }
        }
        _ => f64::NAN,
    }
}

/// `Number(string)` for the forms that matter at learning scale (decimal,
/// exponent, hex, Infinity). Non-finite results are mapped to NaN because the
/// legacy `toNumber` only returns the value when `Number.isFinite(n)`.
fn js_number_from_str(s: &str) -> f64 {
    if let Some(hex) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        return match u64::from_str_radix(hex, 16) {
            Ok(n) => {
                let f = n as f64;
                if f.is_finite() {
                    f
                } else {
                    f64::NAN
                }
            }
            Err(_) => f64::NAN,
        };
    }
    match s.parse::<f64>() {
        Ok(n) if n.is_finite() => n,
        // Rust also parses "inf"/"NaN" (JS Number() would give Infinity/NaN,
        // both non-finite for toNumber purposes) → NaN either way.
        _ => f64::NAN,
    }
}

/// JS `String(v)` for the scalar cell domain (null/undefined → "", whole
/// floats print without decimals like JS does: 3.0 → "3").
pub fn js_string_of(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => s.clone(),
        // Rows never hold nested values; match "[object Object]"-ish fallback.
        Value::Array(_) | Value::Object(_) => "[object Object]".to_string(),
    }
}

fn js_number_to_string(f: f64) -> String {
    if f.is_nan() {
        return "NaN".into();
    }
    if f.is_infinite() {
        return if f > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if f == f.trunc() && f.abs() < 1e21 {
        return format!("{}", f as i64);
    }
    format!("{f}")
}

/// Port of `compareValues()`: numeric compare when both sides are numeric,
/// otherwise string compare of `String(a ?? '')`. (The engine uses the
/// Option-aware `compare_values_opt` in nodes.rs; this is the direct port used
/// by the unit tests and any future single-value call sites.)
#[allow(dead_code)]
pub fn compare_values(a: &Value, b: &Value) -> i32 {
    let x = to_number(a);
    let y = to_number(b);
    if !x.is_nan() && !y.is_nan() {
        return if x < y {
            -1
        } else if x > y {
            1
        } else {
            0
        };
    }
    let sa = js_string_of(a);
    let sb = js_string_of(b);
    if sa < sb {
        -1
    } else if sa > sb {
        1
    } else {
        0
    }
}

/// Port of the engine's `keyOf()`: canonical join/group key so that
/// 10, "10" and 10.0 all match (String(Number(v)) when numeric).
pub fn key_of(v: &Value) -> String {
    let n = to_number(v);
    if n.is_nan() {
        js_string_of(v)
    } else {
        js_number_to_string(n)
    }
}

/// Port of the engine's `numericEquals()`.
pub fn numeric_equals(a: &Value, b: &Value) -> bool {
    if a == b {
        return true;
    }
    if let Value::Bool(ab) = a {
        if matches!(b, Value::String(s) if s == "true" || s == "false") {
            return *ab == (b.as_str() == Some("true"));
        }
    }
    let x = to_number(a);
    let y = to_number(b);
    !x.is_nan() && !y.is_nan() && x == y
}

/// JS `Math.round` (halves round toward +∞), used by roundSmart + health math.
pub fn js_math_round(x: f64) -> f64 {
    if x.is_nan() || x.is_infinite() {
        return x;
    }
    (x + 0.5).floor()
}

/// Port of the engine's `roundSmart()`: keep float noise out of aggregates.
pub fn round_smart(n: f64) -> f64 {
    if !n.is_finite() {
        return n;
    }
    js_math_round(n * 1e9) / 1e9
}

/// Serialize an f64 the way JS `JSON.stringify` would: whole numbers become
/// integer JSON numbers (3.0 → 3), NaN/Infinity become null.
pub fn json_number(f: f64) -> Value {
    if !f.is_finite() {
        return Value::Null;
    }
    if f == f.trunc() && f.abs() < 2.0f64.powi(53) {
        return Value::from(f as i64);
    }
    serde_json::Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null)
}

/// Port of the engine's `stableRowKey()`: JSON.stringify of the row with keys
/// sorted, numbers normalized to their JS form so 3 and 3.0 produce the same
/// key (JS has one number type; serde_json keeps int/float apart).
pub fn stable_row_key(row: &serde_json::Map<String, Value>) -> String {
    let mut keys: Vec<&String> = row.keys().collect();
    keys.sort();
    let mut normalized = serde_json::Map::new();
    for k in keys {
        normalized.insert(k.clone(), normalize_number_value(&row[k]));
    }
    serde_json::to_string(&Value::Object(normalized)).unwrap_or_default()
}

fn normalize_number_value(v: &Value) -> Value {
    match v {
        Value::Number(n) => match n.as_f64() {
            Some(f) => json_number(f),
            None => v.clone(),
        },
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn to_number_matches_legacy() {
        assert_eq!(to_number(&json!(42)), 42.0);
        assert_eq!(to_number(&json!(4.5)), 4.5);
        assert_eq!(to_number(&json!(true)), 1.0);
        assert_eq!(to_number(&json!(false)), 0.0);
        assert_eq!(to_number(&json!("42")), 42.0);
        assert_eq!(to_number(&json!("-3.25")), -3.25);
        assert_eq!(to_number(&json!(" 7 ")), 7.0);
        assert_eq!(to_number(&json!("1e3")), 1000.0);
        assert!(to_number(&json!("")).is_nan());
        assert!(to_number(&json!("   ")).is_nan());
        assert!(to_number(&json!("abc")).is_nan());
        assert!(to_number(&json!(null)).is_nan());
        // JS Number("Infinity") is Infinity → not finite → NaN
        assert!(to_number(&json!("Infinity")).is_nan());
    }

    #[test]
    fn compare_values_numeric_then_string() {
        assert_eq!(compare_values(&json!(2), &json!(10)), -1);
        assert_eq!(compare_values(&json!("2"), &json!("10")), -1); // numeric coercion!
        assert_eq!(compare_values(&json!(10), &json!(10)), 0);
        // mixed non-numeric → string compare by code units ('B'=66 < 'a'=97)
        assert_eq!(compare_values(&json!("apple"), &json!("Banana")), 1);
        assert_eq!(compare_values(&json!("b"), &json!("a")), 1);
        // null → "" for the string side
        assert_eq!(compare_values(&json!(null), &json!("a")), -1);
        // numeric vs non-numeric string → string compare of "5" vs "abc"
        // ("5" (0x35) sorts before "a" (0x61))
        assert_eq!(compare_values(&json!(5), &json!("abc")), -1);
    }

    #[test]
    fn key_of_canonicalizes_numbers() {
        assert_eq!(key_of(&json!(10)), "10");
        assert_eq!(key_of(&json!("10")), "10");
        assert_eq!(key_of(&json!(10.0)), "10");
        assert_eq!(key_of(&json!("010")), "10"); // JS Number("010") === 10
        assert_eq!(key_of(&json!(null)), "");
        assert_eq!(key_of(&json!(true)), "1");
    }

    #[test]
    fn numeric_equals_matches_legacy() {
        assert!(numeric_equals(&json!(10), &json!("10")));
        assert!(numeric_equals(&json!("abc"), &json!("abc")));
        assert!(!numeric_equals(&json!("abc"), &json!("abd")));
        assert!(numeric_equals(&json!(true), &json!("true")));
        assert!(!numeric_equals(&json!(true), &json!("false")));
        assert!(numeric_equals(&json!(null), &json!(null)));
        assert!(!numeric_equals(&json!(null), &json!("")));
        assert!(numeric_equals(&json!(1.5), &json!("1.5")));
    }

    #[test]
    fn round_smart_kills_float_noise() {
        assert_eq!(round_smart(0.1 + 0.2), 0.3);
        assert_eq!(round_smart(2.0 / 3.0), 0.666666667);
        assert!(round_smart(f64::INFINITY).is_infinite());
    }

    #[test]
    fn js_math_round_halves_go_up() {
        assert_eq!(js_math_round(0.5), 1.0);
        assert_eq!(js_math_round(1.5), 2.0);
        assert_eq!(js_math_round(2.675 * 100.0), 268.0);
        assert_eq!(js_math_round(-0.5), 0.0); // JS Math.round(-0.5) === -0
    }

    #[test]
    fn json_number_uses_js_formatting() {
        assert_eq!(json_number(3.0), json!(3));
        assert_eq!(json_number(3.5), json!(3.5));
        assert_eq!(json_number(f64::NAN), json!(null));
        assert_eq!(json_number(f64::INFINITY), json!(null));
        assert_eq!(json_number(-7.0), json!(-7));
    }

    #[test]
    fn stable_row_key_is_order_insensitive_and_number_canonical() {
        let a: serde_json::Map<String, Value> =
            serde_json::from_value(json!({"b": 2, "a": "x"})).unwrap();
        let b: serde_json::Map<String, Value> =
            serde_json::from_value(json!({"a": "x", "b": 2})).unwrap();
        assert_eq!(stable_row_key(&a), stable_row_key(&b));
        // 2 and 2.0 are the same JS number → same key
        let c: serde_json::Map<String, Value> =
            serde_json::from_value(json!({"a": "x", "b": 2.0})).unwrap();
        assert_eq!(stable_row_key(&a), stable_row_key(&c));
        let d: serde_json::Map<String, Value> =
            serde_json::from_value(json!({"a": "x", "b": 3})).unwrap();
        assert_ne!(stable_row_key(&a), stable_row_key(&d));
    }
}
