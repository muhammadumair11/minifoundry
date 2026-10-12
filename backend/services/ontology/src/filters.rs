//! Saved-view structured filters (R14.8) — port of `filterMatches` and the
//! ?filters= query-param parser from the legacy objects route. Pure logic.

use mf_types::{Row, Value};
use mf_web::ApiError;

use crate::values::{compare_values, loose_equal};

/// The 8 filter ops (VIEW_FILTER_OPS).
pub const VIEW_FILTER_OPS: [&str; 8] = ["eq", "neq", "contains", "gt", "lt", "gte", "lte", "in"];
/// Max structured filters accepted per request (MAX_VIEW_FILTERS).
pub const MAX_VIEW_FILTERS: usize = 12;

/// One structured filter of a saved object view.
#[derive(Debug, Clone, PartialEq)]
pub struct ObjectViewFilter {
    pub property: String,
    pub op: String,
    /// Filter values are always strings (legacy contract).
    pub value: String,
}

/// Does `row` satisfy one saved-view filter? (port of `filterMatches`)
pub fn filter_matches(row: &Row, f: &ObjectViewFilter) -> bool {
    let cell = row.get(&f.property).cloned().unwrap_or(Value::Null);
    match f.op.as_str() {
        "eq" => loose_equal(&cell, &Value::String(f.value.clone())),
        "neq" => !loose_equal(&cell, &Value::String(f.value.clone())),
        "contains" => {
            let s = match &cell {
                Value::Null => String::new(),
                other => crate::values::js_string(other),
            };
            s.to_lowercase().contains(&f.value.to_lowercase())
        }
        "in" => f
            .value
            .split(',')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .any(|v| loose_equal(&cell, &Value::String(v.to_string()))),
        "gt" | "gte" | "lt" | "lte" => {
            // null/undefined/'' never satisfy an ordering filter
            let empty = match &cell {
                Value::Null => true,
                Value::String(s) => s.is_empty(),
                _ => false,
            };
            if empty {
                return false;
            }
            let c = compare_values(&cell, &Value::String(f.value.clone()));
            use std::cmp::Ordering::*;
            match f.op.as_str() {
                "gt" => c == Greater,
                "gte" => c != Less,
                "lt" => c == Less,
                _ => c != Greater, // lte
            }
        }
        // Unknown ops pass (legacy default branch)
        _ => true,
    }
}

/// Keep rows satisfying EVERY filter (legacy applies them sequentially).
pub fn apply_filters(rows: Vec<Row>, filters: &[ObjectViewFilter]) -> Vec<Row> {
    let mut out = rows;
    for f in filters {
        out.retain(|row| filter_matches(row, f));
    }
    out
}

/// Parse + validate the ?filters= JSON payload (400 with the exact legacy
/// messages — port of parseFilters in the objects route).
pub fn parse_filters_param(raw: Option<&str>) -> Result<Vec<ObjectViewFilter>, ApiError> {
    let Some(raw) = raw else { return Ok(vec![]) };
    if raw.trim().is_empty() || raw == "[]" {
        return Ok(vec![]);
    }
    let parsed: Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => {
            return Err(ApiError::bad_request(
                "'filters' must be a JSON array of {property, op, value}",
            ))
        }
    };
    let Value::Array(items) = parsed else {
        return Err(ApiError::bad_request(
            "'filters' must be a JSON array of {property, op, value}",
        ));
    };
    if items.len() > MAX_VIEW_FILTERS {
        return Err(ApiError::bad_request(format!(
            "'filters' accepts at most {MAX_VIEW_FILTERS} entries"
        )));
    }
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let property = item
            .get("property")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let Some(property) = property else {
            return Err(ApiError::bad_request(
                "every filter needs a 'property' column name",
            ));
        };
        let op = item.get("op").and_then(|v| v.as_str()).unwrap_or("");
        if !VIEW_FILTER_OPS.contains(&op) {
            return Err(ApiError::bad_request(format!(
                "filter op must be one of: {}",
                VIEW_FILTER_OPS.join(", ")
            )));
        }
        let value = match item.get("value") {
            None | Some(Value::Null) => String::new(),
            Some(v) => crate::values::js_string(v),
        };
        out.push(ObjectViewFilter {
            property,
            op: op.to_string(),
            value,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn f(property: &str, op: &str, value: &str) -> ObjectViewFilter {
        ObjectViewFilter {
            property: property.into(),
            op: op.into(),
            value: value.into(),
        }
    }

    fn row() -> Row {
        serde_json::from_value(json!({
            "name": "Amina Khan",
            "qty": 12,
            "empty": "",
            "nil": null,
            "flag": true
        }))
        .unwrap()
    }

    #[test]
    fn eq_neq_loose() {
        assert!(filter_matches(&row(), &f("qty", "eq", "12")));
        assert!(!filter_matches(&row(), &f("qty", "eq", "13")));
        assert!(filter_matches(&row(), &f("qty", "neq", "13")));
        assert!(filter_matches(&row(), &f("name", "eq", "Amina Khan")));
        // missing column vs value: null !== 'x'
        assert!(filter_matches(&row(), &f("missing", "neq", "x")));
        assert!(!filter_matches(&row(), &f("missing", "eq", "x")));
    }

    #[test]
    fn contains_case_insensitive() {
        assert!(filter_matches(&row(), &f("name", "contains", "khan")));
        assert!(!filter_matches(&row(), &f("name", "contains", "ali")));
        // null cell → '' contains only ''
        assert!(filter_matches(&row(), &f("nil", "contains", "")));
        assert!(!filter_matches(&row(), &f("nil", "contains", "x")));
    }

    #[test]
    fn ordering_ops() {
        assert!(filter_matches(&row(), &f("qty", "gt", "5")));
        assert!(!filter_matches(&row(), &f("qty", "gt", "12")));
        assert!(filter_matches(&row(), &f("qty", "gte", "12")));
        assert!(filter_matches(&row(), &f("qty", "lt", "13")));
        assert!(filter_matches(&row(), &f("qty", "lte", "12")));
        // string compare when either side is non-numeric
        assert!(filter_matches(&row(), &f("name", "gt", "A")));
        // null/'' cells NEVER satisfy ordering filters
        for op in ["gt", "gte", "lt", "lte"] {
            assert!(!filter_matches(&row(), &f("nil", op, "1")));
            assert!(!filter_matches(&row(), &f("empty", op, "1")));
        }
    }

    #[test]
    fn in_list() {
        assert!(filter_matches(
            &row(),
            &f("name", "in", "Amina Khan, Other")
        ));
        assert!(filter_matches(&row(), &f("qty", "in", " 12 , 13 ")));
        assert!(!filter_matches(&row(), &f("name", "in", "x,y")));
        assert!(!filter_matches(&row(), &f("name", "in", "")));
    }

    #[test]
    fn unknown_op_passes() {
        assert!(filter_matches(&row(), &f("name", "whatever", "x")));
    }

    #[test]
    fn parse_filters_param_cases() {
        assert_eq!(parse_filters_param(None).unwrap(), vec![]);
        assert_eq!(parse_filters_param(Some("")).unwrap(), vec![]);
        assert_eq!(parse_filters_param(Some("[]")).unwrap(), vec![]);
        let ok = parse_filters_param(Some(r#"[{"property":"a","op":"eq","value":"1"}]"#)).unwrap();
        assert_eq!(ok, vec![f("a", "eq", "1")]);
        // value coerced to string; null → ''
        let ok = parse_filters_param(Some(r#"[{"property":"a","op":"gt","value":5}]"#)).unwrap();
        assert_eq!(ok[0].value, "5");
        let ok = parse_filters_param(Some(r#"[{"property":"a","op":"gt"}]"#)).unwrap();
        assert_eq!(ok[0].value, "");

        let e = parse_filters_param(Some("not json")).unwrap_err();
        assert_eq!(
            e.message,
            "'filters' must be a JSON array of {property, op, value}"
        );
        let e = parse_filters_param(Some(r#"{"property":"a"}"#)).unwrap_err();
        assert_eq!(
            e.message,
            "'filters' must be a JSON array of {property, op, value}"
        );
        let e = parse_filters_param(Some(r#"[{"op":"eq","value":"1"}]"#)).unwrap_err();
        assert_eq!(e.message, "every filter needs a 'property' column name");
        let e =
            parse_filters_param(Some(r#"[{"property":"a","op":"nope","value":"1"}]"#)).unwrap_err();
        assert_eq!(
            e.message,
            "filter op must be one of: eq, neq, contains, gt, lt, gte, lte, in"
        );
        let many = format!(
            "[{}]",
            vec![r#"{"property":"a","op":"eq","value":"1"}"#; MAX_VIEW_FILTERS + 1].join(",")
        );
        let e = parse_filters_param(Some(&many)).unwrap_err();
        assert_eq!(e.message, "'filters' accepts at most 12 entries");
    }

    #[test]
    fn apply_filters_is_conjunctive() {
        let rows: Vec<Row> = vec![
            serde_json::from_value(json!({"city": "Lahore", "qty": 3})).unwrap(),
            serde_json::from_value(json!({"city": "Lahore", "qty": 9})).unwrap(),
            serde_json::from_value(json!({"city": "Karachi", "qty": 9})).unwrap(),
        ];
        let out = apply_filters(rows, &[f("city", "eq", "Lahore"), f("qty", "gt", "5")]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].get("qty"), Some(&json!(9)));
    }
}
