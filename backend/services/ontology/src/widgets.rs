//! Dashboard widget validation + server-side aggregation — port of the
//! /api/dashboards/[id]/data route logic and the shared widgetSchema.
//! Aggregation is pure (hand-testable); fetching/masking happens in the route.

use mf_types::{Row, Value};
use mf_web::ApiError;
use serde_json::Map;

use crate::jsonutil::{check_max_len, enum_or_err, kind_of, opt_int};
use crate::values::{aggregate, cell_number, group_label, js_num};

pub const WIDGET_TYPES: [&str; 6] = ["bar", "line", "pie", "area", "stat", "table"];
pub const AGGS: [&str; 5] = ["count", "sum", "avg", "min", "max"];
pub const SORT_DIRS: [&str; 2] = ["asc", "desc"];
pub const SOURCE_TYPES: [&str; 2] = ["dataset", "objectType"];

/// Validated + normalized widget (the zod-output shape that gets STORED in
/// layoutJson and drives the data endpoint).
#[derive(Debug, Clone)]
pub struct Widget {
    pub raw: Value,
    pub widget_type: String,
    pub source_type: String,
    pub dataset_id: Option<String>,
    pub object_type_id: Option<String>,
    pub group_by: Option<String>,
    pub value_column: Option<String>,
    pub agg: String,
    pub top_n: i64,
    pub sort_dir: String,
}

/// Validate one widget object (zod widgetSchema + superRefine). `path` is the
/// issue path prefix (e.g. "widget" or "widgets.0"). Returns the normalized
/// widget value (zod output shape, insertion-ordered) plus the parsed config.
pub fn validate_widget(path: &str, w: &Value) -> Result<Widget, ApiError> {
    let Value::Object(m) = w else {
        return Err(ApiError::bad_request(format!(
            "{path}: Invalid input: expected object, received {}",
            kind_of(w)
        )));
    };
    let p = |field: &str| format!("{path}.{field}");

    // id: z.string().min(1)
    let id = match m.get("id") {
        Some(Value::String(s)) if !s.is_empty() => s.clone(),
        Some(Value::String(_)) => {
            return Err(ApiError::bad_request(format!(
                "{}: Too small: expected string to have >=1 chars",
                p("id")
            )))
        }
        Some(other) => {
            return Err(ApiError::bad_request(format!(
                "{}: Invalid input: expected string, received {}",
                p("id"),
                kind_of(other)
            )))
        }
        None => {
            return Err(ApiError::bad_request(format!(
                "{}: Invalid input: expected string, received undefined",
                p("id")
            )))
        }
    };
    // type: enum
    let widget_type = match m.get("type").and_then(|t| t.as_str()) {
        Some(t) if WIDGET_TYPES.contains(&t) => t.to_string(),
        Some(t) => return Err(enum_or_err(t, &p("type"), &WIDGET_TYPES).unwrap_err()),
        None => {
            return Err(ApiError::bad_request(format!(
                "{}: Invalid input: expected string, received undefined",
                p("type")
            )))
        }
    };
    // title: min 1 max 200
    let title = match m.get("title").and_then(|t| t.as_str()) {
        Some(t) if !t.is_empty() => {
            check_max_len(&p("title"), t, 200)?;
            t.to_string()
        }
        Some(_) => {
            return Err(ApiError::bad_request(format!(
                "{}: Too small: expected string to have >=1 chars",
                p("title")
            )))
        }
        None => {
            return Err(ApiError::bad_request(format!(
                "{}: Invalid input: expected string, received undefined",
                p("title")
            )))
        }
    };
    // sourceType optional enum (default 'dataset')
    let source_type = match m.get("sourceType") {
        None | Some(Value::Null) => "dataset".to_string(),
        Some(Value::String(s)) => {
            enum_or_err(s, &p("sourceType"), &SOURCE_TYPES)?;
            s.clone()
        }
        Some(other) => {
            return Err(ApiError::bad_request(format!(
                "{}: Invalid input: expected string, received {}",
                p("sourceType"),
                kind_of(other)
            )))
        }
    };
    // optional string fields with min/max rules
    let opt_min1 = |field: &str| -> Result<Option<String>, ApiError> {
        match m.get(field) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(s)) => {
                if s.is_empty() {
                    return Err(ApiError::bad_request(format!(
                        "{}: Too small: expected string to have >=1 chars",
                        p(field)
                    )));
                }
                Ok(Some(s.clone()))
            }
            Some(other) => Err(ApiError::bad_request(format!(
                "{}: Invalid input: expected string, received {}",
                p(field),
                kind_of(other)
            ))),
        }
    };
    let opt_max = |field: &str, max: usize| -> Result<Option<String>, ApiError> {
        match m.get(field) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(s)) => {
                check_max_len(&p(field), s, max)?;
                Ok(Some(s.clone()))
            }
            Some(other) => Err(ApiError::bad_request(format!(
                "{}: Invalid input: expected string, received {}",
                p(field),
                kind_of(other)
            ))),
        }
    };
    let dataset_id = opt_min1("datasetId")?;
    let dataset_name = opt_max("datasetName", 200)?;
    let object_type_id = opt_min1("objectTypeId")?;
    let object_type_name = opt_max("objectTypeName", 200)?;

    // superRefine: source presence
    if source_type == "dataset" && dataset_id.is_none() {
        return Err(ApiError::bad_request(format!(
            "{}: datasetId is required for a dataset widget",
            p("datasetId")
        )));
    }
    if source_type == "objectType" && object_type_id.is_none() {
        return Err(ApiError::bad_request(format!(
            "{}: objectTypeId is required for an Ontology widget",
            p("objectTypeId")
        )));
    }

    // config: object with optional constrained fields, default {}
    let cfg_map: Map<String, Value> = match m.get("config") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(o)) => o.clone(),
        Some(other) => {
            return Err(ApiError::bad_request(format!(
                "{}: Invalid input: expected object, received {}",
                p("config"),
                kind_of(other)
            )))
        }
    };
    let group_by = match cfg_map.get("groupBy") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => {
            check_max_len(&p("config.groupBy"), s, 200)?;
            Some(s.clone())
        }
        Some(other) => {
            return Err(ApiError::bad_request(format!(
                "{}: Invalid input: expected string, received {}",
                p("config.groupBy"),
                kind_of(other)
            )))
        }
    };
    let value_column = match cfg_map.get("valueColumn") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => {
            check_max_len(&p("config.valueColumn"), s, 200)?;
            Some(s.clone())
        }
        Some(other) => {
            return Err(ApiError::bad_request(format!(
                "{}: Invalid input: expected string, received {}",
                p("config.valueColumn"),
                kind_of(other)
            )))
        }
    };
    let agg = match cfg_map.get("agg") {
        None | Some(Value::Null) => "count".to_string(),
        Some(Value::String(s)) => {
            enum_or_err(s, &p("config.agg"), &AGGS)?;
            s.clone()
        }
        Some(other) => {
            return Err(ApiError::bad_request(format!(
                "{}: Invalid input: expected string, received {}",
                p("config.agg"),
                kind_of(other)
            )))
        }
    };
    let top_n = match opt_int(&cfg_map, "topN") {
        Ok(Some(n)) => {
            if !(1..=100).contains(&n) {
                return Err(ApiError::bad_request(format!(
                    "{}: Invalid input: expected int between 1 and 100",
                    p("config.topN")
                )));
            }
            n
        }
        Ok(None) => 10,
        Err(e) => {
            return Err(ApiError {
                message: e.message.replace("topN:", &p("config.topN")),
                ..e
            })
        }
    };
    let sort_dir = match cfg_map.get("sortDir") {
        None | Some(Value::Null) => "desc".to_string(),
        Some(Value::String(s)) => {
            enum_or_err(s, &p("config.sortDir"), &SORT_DIRS)?;
            s.clone()
        }
        Some(other) => {
            return Err(ApiError::bad_request(format!(
                "{}: Invalid input: expected string, received {}",
                p("config.sortDir"),
                kind_of(other)
            )))
        }
    };

    // span: literal 1|2 optional
    let span = match m.get("span") {
        None | Some(Value::Null) => None,
        Some(Value::Number(n)) => match n.as_i64() {
            Some(1) | Some(2) => Some(n.as_i64().unwrap()),
            _ => {
                return Err(ApiError::bad_request(format!(
                    "{}: Invalid input: expected 1 or 2",
                    p("span")
                )))
            }
        },
        Some(other) => {
            return Err(ApiError::bad_request(format!(
                "{}: Invalid input: expected number, received {}",
                p("span"),
                kind_of(other)
            )))
        }
    };

    // Rebuild in zod-output order (this is what gets stored in layoutJson).
    let mut config_out = Map::new();
    if let Some(g) = &group_by {
        config_out.insert("groupBy".into(), Value::String(g.clone()));
    }
    if let Some(v) = &value_column {
        config_out.insert("valueColumn".into(), Value::String(v.clone()));
    }
    if cfg_map.get("agg").is_some() && !cfg_map.get("agg").unwrap().is_null() {
        config_out.insert("agg".into(), Value::String(agg.clone()));
    }
    if let Some(n) = cfg_map.get("topN") {
        if !n.is_null() {
            config_out.insert("topN".into(), js_num(top_n as f64));
        }
    }
    if let Some(s) = cfg_map.get("sortDir") {
        if !s.is_null() {
            config_out.insert("sortDir".into(), Value::String(sort_dir.clone()));
        }
    }
    let mut out = Map::new();
    out.insert("id".into(), Value::String(id));
    out.insert("type".into(), Value::String(widget_type.clone()));
    out.insert("title".into(), Value::String(title));
    if let Some(s) = m.get("sourceType").filter(|v| !v.is_null()) {
        out.insert("sourceType".into(), s.clone());
    }
    if let Some(s) = &dataset_id {
        out.insert("datasetId".into(), Value::String(s.clone()));
    }
    if let Some(s) = &dataset_name {
        out.insert("datasetName".into(), Value::String(s.clone()));
    }
    if let Some(s) = &object_type_id {
        out.insert("objectTypeId".into(), Value::String(s.clone()));
    }
    if let Some(s) = &object_type_name {
        out.insert("objectTypeName".into(), Value::String(s.clone()));
    }
    out.insert("config".into(), Value::Object(config_out));
    if let Some(n) = span {
        out.insert("span".into(), js_num(n as f64));
    }

    Ok(Widget {
        raw: Value::Object(out),
        widget_type,
        source_type,
        dataset_id,
        object_type_id,
        group_by,
        value_column,
        agg,
        top_n,
        sort_dir,
    })
}

/// Validate the widgets array of a dashboard PATCH (max 50).
pub fn validate_widgets(path: &str, v: &Value) -> Result<Vec<Value>, ApiError> {
    let Value::Array(items) = v else {
        return Err(ApiError::bad_request(format!(
            "{path}: Invalid input: expected array, received {}",
            kind_of(v)
        )));
    };
    if items.len() > 50 {
        return Err(ApiError::bad_request(format!(
            "{path}: Too big: expected array to have <=50 items"
        )));
    }
    items
        .iter()
        .enumerate()
        .map(|(i, w)| validate_widget(&format!("{path}.{i}"), w).map(|w| w.raw))
        .collect()
}

/// Compute widget rows (bar/line/pie/area/stat/table) over ALREADY MASKED
/// rows. `row_count` is the version rowCount (stat count). Exact legacy
/// messages for missing columns/config.
#[allow(clippy::too_many_arguments)]
pub fn compute_widget_rows(
    widget_type: &str,
    agg: &str,
    group_by: Option<&str>,
    value_column: Option<&str>,
    top_n: i64,
    sort_dir: &str,
    all_rows: &[Row],
    row_count: i64,
    dataset_name: &str,
) -> Result<Vec<Value>, ApiError> {
    let top_n = top_n.max(1) as usize;

    // ── stat: one aggregate over the whole dataset ─────────────────────
    if widget_type == "stat" {
        if agg == "count" {
            return Ok(vec![stat_row(js_num(row_count as f64))]);
        }
        let Some(vc) = value_column else {
            return Err(ApiError::bad_request(format!(
                "stat widget with agg '{agg}' needs a valueColumn"
            )));
        };
        let values: Vec<f64> = all_rows
            .iter()
            .filter_map(|r| r.get(vc))
            .filter_map(cell_number)
            .collect();
        let v = aggregate(agg, all_rows.len(), &values);
        return Ok(vec![stat_row(js_num(v))]);
    }

    // ── table: first topN raw rows ─────────────────────────────────────
    if widget_type == "table" {
        return Ok(all_rows
            .iter()
            .take(top_n)
            .map(|r| Value::Object(r.clone()))
            .collect());
    }

    // ── bar/line/pie/area: groupBy + agg → [{ name, value }] ───────────
    let Some(group_by) = group_by else {
        return Err(ApiError::bad_request(format!(
            "Widget needs a groupBy column (type '{widget_type}')"
        )));
    };
    if let Some(first) = all_rows.first() {
        if !first.contains_key(group_by) {
            return Err(ApiError::bad_request(format!(
                "Column '{group_by}' not found in dataset '{dataset_name}'"
            )));
        }
    }
    let needs_value = agg != "count";
    if needs_value && value_column.is_none() {
        return Err(ApiError::bad_request(format!(
            "agg '{agg}' needs a valueColumn"
        )));
    }
    if needs_value {
        if let (Some(vc), Some(first)) = (value_column, all_rows.first()) {
            if !first.contains_key(vc) {
                return Err(ApiError::bad_request(format!(
                    "Column '{vc}' not found in dataset '{dataset_name}'"
                )));
            }
        }
    }

    // Groups keyed by label, insertion-ordered like the JS Map.
    let mut keys: Vec<String> = Vec::new();
    let mut groups: std::collections::HashMap<String, (usize, Vec<f64>)> =
        std::collections::HashMap::new();
    for row in all_rows {
        let key = group_label(row.get(group_by).unwrap_or(&Value::Null));
        let g = groups.entry(key.clone()).or_insert_with(|| {
            keys.push(key.clone());
            (0, Vec::new())
        });
        g.0 += 1;
        if needs_value {
            if let Some(vc) = value_column {
                if let Some(n) = row.get(vc).and_then(cell_number) {
                    g.1.push(n);
                }
            }
        }
    }

    let mut rows: Vec<(String, f64)> = keys
        .iter()
        .map(|k| {
            let (count, values) = groups.get(k).unwrap();
            (k.clone(), aggregate(agg, *count, values))
        })
        .collect();
    // Value sort (desc default); ties fall back to name asc for stable output
    // (localeCompare approximated by case-insensitive primary order).
    let dir: f64 = if sort_dir == "asc" { 1.0 } else { -1.0 };
    rows.sort_by(|a, b| {
        let by_value = ((a.1 - b.1) * dir)
            .partial_cmp(&0.0)
            .unwrap_or(std::cmp::Ordering::Equal);
        by_value.then_with(|| {
            a.0.to_lowercase()
                .cmp(&b.0.to_lowercase())
                .then_with(|| a.0.cmp(&b.0))
        })
    });
    rows.truncate(top_n);
    Ok(rows
        .into_iter()
        .map(|(name, value)| {
            let mut m = Map::new();
            m.insert("name".into(), Value::String(name));
            m.insert("value".into(), js_num(value));
            Value::Object(m)
        })
        .collect())
}

fn stat_row(value: Value) -> Value {
    let mut m = Map::new();
    m.insert("name".into(), Value::String("value".into()));
    m.insert("value".into(), value);
    Value::Object(m)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rows(v: Value) -> Vec<Row> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|r| r.as_object().unwrap().clone())
            .collect()
    }

    // Hand-computed fixture rows:
    // city: Rotterdam x3 (qty 10, 20, "30"), Hamburg x2 (qty 5, "abc"), null x1 (qty 7)
    fn sample() -> Vec<Row> {
        rows(json!([
            {"city": "Rotterdam", "qty": 10},
            {"city": "Rotterdam", "qty": 20},
            {"city": "Rotterdam", "qty": "30"},
            {"city": "Hamburg", "qty": 5},
            {"city": "Hamburg", "qty": "abc"},
            {"city": null, "qty": 7}
        ]))
    }

    #[test]
    fn bar_count_groups_desc_then_name() {
        let out = compute_widget_rows("bar", "count", Some("city"), None, 10, "desc", &sample(), 6, "ds")
            .unwrap();
        // counts: Rotterdam 3, Hamburg 2, (empty) 1
        assert_eq!(out, vec![
            json!({"name": "Rotterdam", "value": 3}),
            json!({"name": "Hamburg", "value": 2}),
            json!({"name": "(empty)", "value": 1}),
        ]);
    }

    #[test]
    fn sum_coerces_numeric_strings_and_skips_junk() {
        let out = compute_widget_rows("bar", "sum", Some("city"), Some("qty"), 10, "desc", &sample(), 6, "ds")
            .unwrap();
        // Rotterdam 10+20+30=60, (empty) 7, Hamburg 5 ('abc' skipped)
        assert_eq!(out, vec![
            json!({"name": "Rotterdam", "value": 60}),
            json!({"name": "(empty)", "value": 7}),
            json!({"name": "Hamburg", "value": 5}),
        ]);
    }

    #[test]
    fn avg_min_max_and_empty_group_zero() {
        let out = compute_widget_rows("line", "avg", Some("city"), Some("qty"), 10, "desc", &sample(), 6, "ds")
            .unwrap();
        assert_eq!(out[0], json!({"name": "Rotterdam", "value": 20})); // 60/3
        assert_eq!(out[1], json!({"name": "(empty)", "value": 7}));
        assert_eq!(out[2], json!({"name": "Hamburg", "value": 5})); // only numeric value

        let out = compute_widget_rows("pie", "max", Some("city"), Some("qty"), 10, "desc", &sample(), 6, "ds")
            .unwrap();
        assert_eq!(out[0], json!({"name": "Rotterdam", "value": 30}));
        let out = compute_widget_rows("area", "min", Some("city"), Some("qty"), 10, "asc", &sample(), 6, "ds")
            .unwrap();
        // asc by value: Hamburg 5, (empty) 7, Rotterdam 10
        assert_eq!(out[0], json!({"name": "Hamburg", "value": 5}));
        assert_eq!(out[1], json!({"name": "(empty)", "value": 7}));
        assert_eq!(out[2], json!({"name": "Rotterdam", "value": 10}));
    }

    #[test]
    fn all_numeric_missing_falls_to_zero() {
        // Hamburg has no numeric qty beyond 5; use a group with none:
        let data = rows(json!([
            {"city": "X", "qty": "abc"},
            {"city": "X", "qty": null}
        ]));
        let out = compute_widget_rows("bar", "sum", Some("city"), Some("qty"), 10, "desc", &data, 2, "ds")
            .unwrap();
        assert_eq!(out, vec![json!({"name": "X", "value": 0})]);
    }

    #[test]
    fn topn_and_sort_dir() {
        let out = compute_widget_rows("bar", "count", Some("city"), None, 2, "asc", &sample(), 6, "ds")
            .unwrap();
        // asc: (empty) 1, Hamburg 2 — Rotterdam cut by topN
        assert_eq!(out, vec![
            json!({"name": "(empty)", "value": 1}),
            json!({"name": "Hamburg", "value": 2}),
        ]);
    }

    #[test]
    fn tie_break_by_name_asc() {
        let data = rows(json!([
            {"city": "b"}, {"city": "a"}, {"city": "c"}
        ]));
        let out = compute_widget_rows("bar", "count", Some("city"), None, 10, "desc", &data, 3, "ds")
            .unwrap();
        assert_eq!(
            out.iter().map(|r| r["name"].as_str().unwrap()).collect::<Vec<_>>(),
            vec!["a", "b", "c"]
        );
    }

    #[test]
    fn stat_widget_semantics() {
        let out = compute_widget_rows("stat", "count", None, None, 10, "desc", &sample(), 42, "ds")
            .unwrap();
        assert_eq!(out, vec![json!({"name": "value", "value": 42})]);

        let out = compute_widget_rows("stat", "sum", None, Some("qty"), 10, "desc", &sample(), 6, "ds")
            .unwrap();
        assert_eq!(out, vec![json!({"name": "value", "value": 72})]); // 10+20+30+5+7

        let e = compute_widget_rows("stat", "sum", None, None, 10, "desc", &sample(), 6, "ds")
            .unwrap_err();
        assert_eq!(e.message, "stat widget with agg 'sum' needs a valueColumn");
    }

    #[test]
    fn table_widget_first_topn_raw_rows() {
        let out = compute_widget_rows("table", "count", None, None, 2, "desc", &sample(), 6, "ds")
            .unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0], json!({"city": "Rotterdam", "qty": 10}));
        assert_eq!(out[1], json!({"city": "Rotterdam", "qty": 20}));
    }

    #[test]
    fn error_messages_match_legacy() {
        let e = compute_widget_rows("bar", "count", None, None, 10, "desc", &sample(), 6, "ds")
            .unwrap_err();
        assert_eq!(e.message, "Widget needs a groupBy column (type 'bar')");

        let e = compute_widget_rows("pie", "count", Some("nope"), None, 10, "desc", &sample(), 6, "Ships")
            .unwrap_err();
        assert_eq!(e.message, "Column 'nope' not found in dataset 'Ships'");

        let e = compute_widget_rows("pie", "sum", Some("city"), None, 10, "desc", &sample(), 6, "ds")
            .unwrap_err();
        assert_eq!(e.message, "agg 'sum' needs a valueColumn");

        let e = compute_widget_rows("pie", "sum", Some("city"), Some("nope"), 10, "desc", &sample(), 6, "Ships")
            .unwrap_err();
        assert_eq!(e.message, "Column 'nope' not found in dataset 'Ships'");

        // empty dataset: column checks skipped (legacy `allRows.length > 0` guard)
        let out = compute_widget_rows("bar", "count", Some("anything"), None, 10, "desc", &[], 0, "ds")
            .unwrap();
        assert!(out.is_empty());
    }

    #[test]
    fn boolean_group_labels() {
        let data = rows(json!([{"flag": true}, {"flag": false}, {"flag": true}]));
        let out = compute_widget_rows("bar", "count", Some("flag"), None, 10, "desc", &data, 3, "ds")
            .unwrap();
        assert_eq!(out, vec![
            json!({"name": "true", "value": 2}),
            json!({"name": "false", "value": 1}),
        ]);
    }

    // ─── widget validation ───────────────────────────────────────────────

    #[test]
    fn widget_validation_and_normalization() {
        let w = validate_widget(
            "widget",
            &json!({
                "id": "w1", "type": "bar", "title": "By city",
                "datasetId": "d1", "config": {"groupBy": "city", "agg": "sum", "valueColumn": "qty"},
                "span": 2
            }),
        )
        .unwrap();
        assert_eq!(w.agg, "sum");
        assert_eq!(w.top_n, 10);
        assert_eq!(w.sort_dir, "desc");
        // stored shape keeps zod-output key order + only provided config keys
        assert_eq!(
            w.raw,
            json!({
                "id": "w1", "type": "bar", "title": "By city", "datasetId": "d1",
                "config": {"groupBy": "city", "valueColumn": "qty", "agg": "sum"},
                "span": 2
            })
        );

        // config defaults to {} and is always present
        let w2 = validate_widget("widget", &json!({"id": "w", "type": "stat", "title": "t", "datasetId": "d"})).unwrap();
        assert_eq!(w2.raw["config"], json!({}));
        assert!(w2.raw.get("span").is_none());
    }

    #[test]
    fn widget_validation_errors() {
        let e = validate_widget("widget", &json!({"id": "w1", "type": "bar", "title": "t"})).unwrap_err();
        assert_eq!(e.message, "widget.datasetId: datasetId is required for a dataset widget");

        let e = validate_widget(
            "widgets.0",
            &json!({"id": "w1", "type": "bar", "title": "t", "sourceType": "objectType"}),
        )
        .unwrap_err();
        assert_eq!(e.message, "widgets.0.objectTypeId: objectTypeId is required for an Ontology widget");

        let e = validate_widget("widget", &json!({"id": "", "type": "bar", "title": "t", "datasetId": "d"})).unwrap_err();
        assert_eq!(e.message, "widget.id: Too small: expected string to have >=1 chars");

        let e = validate_widget("widget", &json!({"id": "w", "type": "nope", "title": "t", "datasetId": "d"})).unwrap_err();
        assert_eq!(
            e.message,
            "widget.type: Invalid option: expected one of \"bar\"|\"line\"|\"pie\"|\"area\"|\"stat\"|\"table\""
        );

        let e = validate_widget(
            "widget",
            &json!({"id": "w", "type": "bar", "title": "t", "datasetId": "d", "config": {"topN": 0}}),
        )
        .unwrap_err();
        assert_eq!(e.message, "widget.config.topN: Invalid input: expected int between 1 and 100");

        let e = validate_widget(
            "widget",
            &json!({"id": "w", "type": "bar", "title": "t", "datasetId": "d", "span": 3}),
        )
        .unwrap_err();
        assert_eq!(e.message, "widget.span: Invalid input: expected 1 or 2");
    }

    #[test]
    fn widgets_array_limits() {
        let e = validate_widgets("widgets", &json!({"a": 1})).unwrap_err();
        assert_eq!(e.message, "widgets: Invalid input: expected array, received object");
        let many: Vec<Value> = (0..51)
            .map(|i| json!({"id": format!("w{i}"), "type": "stat", "title": "t", "datasetId": "d"}))
            .collect();
        let e = validate_widgets("widgets", &Value::Array(many)).unwrap_err();
        assert_eq!(e.message, "widgets: Too big: expected array to have <=50 items");
    }
}
