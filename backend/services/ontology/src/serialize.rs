//! Contract serializers — exact legacy JSON shapes (field names, order,
//! casing) for object types, actions, views, dashboards and applications,
//! plus the AppConfig validation/normalization port (applications/shared.ts).

use chrono::{DateTime, Utc};
use mf_types::{SchemaColumn, Value};
use mf_web::ApiError;
use serde_json::Map;
use std::collections::{HashMap, HashSet};

use crate::jsonutil::{check_max_len, enum_or_err, kind_of};
use crate::state::*;

// ─── Text helpers (ontology-service.ts) ───────────────────────────────────

/// Humanize an apiName: split camelCase/underscores, capitalize each word.
pub fn humanize_api_name(api_name: &str) -> String {
    let re_sep = regex::Regex::new(r"[_-]+").unwrap();
    let re_camel = regex::Regex::new(r"([a-z0-9])([A-Z])").unwrap();
    let re_ws = regex::Regex::new(r"\s+").unwrap();
    let s = re_sep.replace_all(api_name, " ");
    let s = re_camel.replace_all(&s, "$1 $2");
    let s = re_ws.replace_all(&s, " ");
    s.trim()
        .split(' ')
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                None => String::new(),
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Slugify a display name into an apiName candidate (legacy slugify).
pub fn slugify(name: &str) -> String {
    let re = regex::Regex::new(r"[^a-z0-9]+").unwrap();
    let s = name.trim().to_lowercase();
    let s = re.replace_all(&s, "-");
    let s = s.trim_matches('-');
    s.chars().take(64).collect()
}

/// The legacy apiName slug pattern (create routes + link config).
pub fn slug_re() -> &'static regex::Regex {
    use once_cell::sync::Lazy;
    static RE: Lazy<regex::Regex> =
        Lazy::new(|| regex::Regex::new(r"^[a-z][a-z0-9_-]{1,63}$").unwrap());
    &RE
}

pub const SLUG_MSG: &str =
    "apiName must be a lowercase slug (letters, numbers, \"-\" or \"_\"), starting with a letter";

/// Derived property create-data (port of deriveProperties): displayName =
/// humanized apiName; isTitle marks the title property (defaults to the pk).
pub struct DerivedProperty {
    pub api_name: String,
    pub display_name: String,
    pub data_type: String,
    pub is_title: bool,
    pub hide_in_table: bool,
}

pub fn derive_properties(
    schema: &[SchemaColumn],
    primary_key: &str,
    title_property: Option<&str>,
) -> Vec<DerivedProperty> {
    let title = title_property.unwrap_or(primary_key);
    schema
        .iter()
        .map(|col| DerivedProperty {
            api_name: col.name.clone(),
            display_name: humanize_api_name(&col.name),
            data_type: match col.column_type {
                mf_types::ColumnType::Number => "number",
                mf_types::ColumnType::Boolean => "boolean",
                mf_types::ColumnType::String => "string",
            }
            .to_string(),
            is_title: col.name == title,
            hide_in_table: false,
        })
        .collect()
}

fn ts(dt: &DateTime<Utc>) -> String {
    mf_types::ts::format(dt)
}

// ─── Object type serializer (serializeObjectType) ─────────────────────────

/// Endpoint type meta for link serialization.
pub struct TypeMeta {
    pub id: String,
    pub api_name: String,
    pub display_name: String,
}

/// Everything serializeObjectType needs (assembled by the routes from the
/// part tables + catalog dataset metadata).
pub struct ObjectTypeFull {
    pub row: ObjectTypeRow,
    /// properties ordered by id asc
    pub properties: Vec<PropertyRow>,
    /// outgoing links ordered by apiName asc, with toType meta
    pub links_out: Vec<(LinkTypeRow, TypeMeta)>,
    /// incoming links ordered by apiName asc, with fromType meta
    pub links_in: Vec<(LinkTypeRow, TypeMeta)>,
    /// actions ordered by (createdAt asc, apiName asc)
    pub actions: Vec<ActionTypeRow>,
    pub source_dataset_name: Option<String>,
    /// Head-version rowCount of the backing dataset (null when unavailable).
    pub object_count: Option<i64>,
    /// link dataset id → name (for linkDatasetName).
    pub link_dataset_names: HashMap<String, String>,
}

pub fn serialize_object_type(ot: &ObjectTypeFull) -> Value {
    let properties: Vec<Value> = ot
        .properties
        .iter()
        .map(|p| {
            serde_json::json!({
                "apiName": p.api_name,
                "displayName": p.display_name,
                "dataType": p.data_type,
                "isTitle": p.is_title,
                "hideInTable": p.hide_in_table,
            })
        })
        .collect();
    let links_out: Vec<Value> = ot
        .links_out
        .iter()
        .map(|(l, to)| {
            let link_dataset_name = l
                .link_dataset_id
                .as_ref()
                .and_then(|id| ot.link_dataset_names.get(id))
                .cloned();
            serde_json::json!({
                "id": l.id,
                "apiName": l.api_name,
                "displayName": l.display_name,
                "toTypeId": l.to_type_id,
                "toTypeApiName": to.api_name,
                "toTypeDisplayName": to.display_name,
                "cardinality": l.cardinality,
                "fkProperty": l.fk_property,
                "fkSide": l.fk_side,
                "linkDatasetId": l.link_dataset_id,
                "linkDatasetName": link_dataset_name,
                "fromKeyColumn": l.from_key_column,
                "toKeyColumn": l.to_key_column,
            })
        })
        .collect();
    let links_in: Vec<Value> = ot
        .links_in
        .iter()
        .map(|(l, from)| {
            serde_json::json!({
                "id": l.id,
                "apiName": l.api_name,
                "displayName": l.display_name,
                "fromTypeId": l.from_type_id,
                "fromTypeApiName": from.api_name,
                "fromTypeDisplayName": from.display_name,
                "cardinality": l.cardinality,
            })
        })
        .collect();
    let actions: Vec<Value> = ot
        .actions
        .iter()
        .map(|a| {
            serde_json::json!({
                "id": a.id,
                "apiName": a.api_name,
                "displayName": a.display_name,
                "operation": a.operation,
                "enabled": a.enabled,
            })
        })
        .collect();
    serde_json::json!({
        "id": ot.row.id,
        "apiName": ot.row.api_name,
        "displayName": ot.row.display_name,
        "description": ot.row.description,
        "primaryKey": ot.row.primary_key,
        "icon": ot.row.icon,
        "color": ot.row.color,
        "sourceDatasetId": ot.row.source_dataset_id,
        "sourceDatasetName": ot.source_dataset_name,
        "objectCount": ot.object_count,
        "properties": properties,
        "linksOut": links_out,
        "linksIn": links_in,
        "actions": actions,
        "createdAt": ts(&ot.row.created_at),
    })
}

// ─── Action serializers ───────────────────────────────────────────────────

/// Full action-type serializer for the /api/ontology/actions admin routes
/// (port of serializeActionFull).
pub fn serialize_action_full(
    a: &ActionTypeRow,
    object_type: &ObjectTypeRow,
    target_dataset_name: Option<&str>,
) -> Value {
    let writeback = match (&a.target_dataset_id, &a.write_mode) {
        (Some(id), Some(mode)) => serde_json::json!({
            "targetDatasetId": id,
            "targetDatasetName": target_dataset_name,
            "writeMode": mode,
            "keyProperty": a.key_property,
        }),
        _ => Value::Null,
    };
    serde_json::json!({
        "id": a.id,
        "apiName": a.api_name,
        "displayName": a.display_name,
        "description": a.description,
        "operation": a.operation,
        "enabled": a.enabled,
        "objectTypeId": a.object_type_id,
        "objectType": {
            "id": object_type.id,
            "apiName": object_type.api_name,
            "displayName": object_type.display_name,
            "primaryKey": object_type.primary_key,
            "icon": object_type.icon,
            "color": object_type.color,
            "sourceDatasetId": object_type.source_dataset_id,
        },
        "parameters": a.parameters_json.0.clone(),
        "writeback": writeback,
        "createdAt": ts(&a.created_at),
        "updatedAt": ts(&a.updated_at),
    })
}

/// Public /api/actions list entry (id..paramCount).
pub fn serialize_action_summary(a: &ActionTypeRow, object_type: &ObjectTypeRow) -> Value {
    let param_count = a.parameters_json.0.as_array().map(|v| v.len()).unwrap_or(0);
    serde_json::json!({
        "id": a.id,
        "apiName": a.api_name,
        "displayName": a.display_name,
        "description": a.description,
        "operation": a.operation,
        "enabled": a.enabled,
        "objectTypeId": a.object_type_id,
        "objectTypeApiName": object_type.api_name,
        "objectTypeDisplayName": object_type.display_name,
        "paramCount": param_count,
    })
}

/// GET /api/actions/{apiName} detail shape.
pub fn serialize_action_public(a: &ActionTypeRow, object_type: &ObjectTypeRow) -> Value {
    serde_json::json!({
        "id": a.id,
        "apiName": a.api_name,
        "displayName": a.display_name,
        "description": a.description,
        "operation": a.operation,
        "enabled": a.enabled,
        "parameters": a.parameters_json.0.clone(),
        "objectType": {
            "id": object_type.id,
            "apiName": object_type.api_name,
            "displayName": object_type.display_name,
            "primaryKey": object_type.primary_key,
            "icon": object_type.icon,
            "color": object_type.color,
        },
    })
}

// ─── Action parameter validation (paramSchema + normalizeParameters) ──────

/// Validate + normalize one parameter definition object; returns the stored
/// JSON (zod-output key order; an empty oneOf list is dropped).
pub fn normalize_parameter(path: &str, p: &Value) -> Result<Value, ApiError> {
    let Value::Object(m) = p else {
        return Err(ApiError::bad_request(format!(
            "{path}: Invalid input: expected object, received {}",
            kind_of(p)
        )));
    };
    let pth = |f: &str| format!("{path}.{f}");
    // apiName: regex ^[a-zA-Z][a-zA-Z0-9_]{0,63}$
    let api_name = match m.get("apiName").and_then(|v| v.as_str()) {
        Some(s) => s,
        None => {
            return Err(ApiError::bad_request(format!(
                "{}: Invalid input: expected string, received {}",
                pth("apiName"),
                m.get("apiName").map(kind_of).unwrap_or("undefined")
            )))
        }
    };
    let re = regex::Regex::new(r"^[a-zA-Z][a-zA-Z0-9_]{0,63}$").unwrap();
    if !re.is_match(api_name) {
        return Err(ApiError::bad_request(format!(
            "{}: parameter apiName must match [a-zA-Z][a-zA-Z0-9_]*",
            pth("apiName")
        )));
    }
    // displayName optional min1 max120
    let display_name = match m.get("displayName") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => {
            if s.is_empty() {
                return Err(ApiError::bad_request(format!(
                    "{}: Too small: expected string to have >=1 chars",
                    pth("displayName")
                )));
            }
            check_max_len(&pth("displayName"), s, 120)?;
            Some(s.clone())
        }
        Some(other) => {
            return Err(ApiError::bad_request(format!(
                "{}: Invalid input: expected string, received {}",
                pth("displayName"),
                kind_of(other)
            )))
        }
    };
    // dataType enum
    let data_type = match m.get("dataType").and_then(|v| v.as_str()) {
        Some(s) => enum_or_err(s, &pth("dataType"), &["string", "number", "boolean"])?.to_string(),
        None => {
            return Err(ApiError::bad_request(format!(
                "{}: Invalid input: expected string, received undefined",
                pth("dataType")
            )))
        }
    };
    // required optional bool
    let required = match m.get("required") {
        None | Some(Value::Null) => None,
        Some(Value::Bool(b)) => Some(*b),
        Some(other) => {
            return Err(ApiError::bad_request(format!(
                "{}: Invalid input: expected boolean, received {}",
                pth("required"),
                kind_of(other)
            )))
        }
    };
    // mapsTo required min1 max120 (custom message)
    let maps_to = match m.get("mapsTo").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => {
            check_max_len(&pth("mapsTo"), s, 120)?;
            s.to_string()
        }
        Some(_) => {
            return Err(ApiError::bad_request(format!(
                "{}: mapsTo (dataset column) is required",
                pth("mapsTo")
            )))
        }
        None => {
            return Err(ApiError::bad_request(format!(
                "{}: mapsTo (dataset column) is required",
                pth("mapsTo")
            )))
        }
    };
    // isPk optional bool
    let is_pk = match m.get("isPk") {
        None | Some(Value::Null) => None,
        Some(Value::Bool(b)) => Some(*b),
        Some(other) => {
            return Err(ApiError::bad_request(format!(
                "{}: Invalid input: expected boolean, received {}",
                pth("isPk"),
                kind_of(other)
            )))
        }
    };
    // defaultValue any (undefined dropped)
    let default_value = m.get("defaultValue").filter(|v| !v.is_null());
    // oneOf optional array of strings max50; blanks filtered; empty dropped
    let one_of: Option<Vec<String>> = match m.get("oneOf") {
        None | Some(Value::Null) => None,
        Some(Value::Array(items)) => {
            if items.len() > 50 {
                return Err(ApiError::bad_request(format!(
                    "{}: Too big: expected array to have <=50 items",
                    pth("oneOf")
                )));
            }
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                let s = crate::values::js_string(item);
                if !s.trim().is_empty() {
                    out.push(s);
                }
            }
            if out.is_empty() {
                None
            } else {
                Some(out)
            }
        }
        Some(other) => {
            return Err(ApiError::bad_request(format!(
                "{}: Invalid input: expected array, received {}",
                pth("oneOf"),
                kind_of(other)
            )))
        }
    };

    // zod-output key order
    let mut out = Map::new();
    out.insert("apiName".into(), Value::String(api_name.to_string()));
    if let Some(d) = display_name {
        out.insert("displayName".into(), Value::String(d));
    }
    out.insert("dataType".into(), Value::String(data_type));
    if let Some(r) = required {
        out.insert("required".into(), Value::Bool(r));
    }
    out.insert("mapsTo".into(), Value::String(maps_to));
    if let Some(k) = is_pk {
        out.insert("isPk".into(), Value::Bool(k));
    }
    if let Some(d) = default_value {
        out.insert("defaultValue".into(), d.clone());
    }
    if let Some(o) = one_of {
        out.insert(
            "oneOf".into(),
            Value::Array(o.into_iter().map(Value::String).collect()),
        );
    }
    Ok(Value::Object(out))
}

/// Validate the parameters array (max 20) → normalized stored JSON array.
pub fn normalize_parameters(path: &str, v: &Value) -> Result<Vec<Value>, ApiError> {
    let Value::Array(items) = v else {
        return Err(ApiError::bad_request(format!(
            "{path}: Invalid input: expected array, received {}",
            kind_of(v)
        )));
    };
    if items.len() > 20 {
        return Err(ApiError::bad_request(format!(
            "{path}: Too big: expected array to have <=20 items"
        )));
    }
    items
        .iter()
        .enumerate()
        .map(|(i, p)| normalize_parameter(&format!("{path}.{i}"), p))
        .collect()
}

// ─── Object views (ObjectViewInfo) ────────────────────────────────────────

pub fn serialize_view(v: &ObjectViewRow) -> Value {
    let sort_dir = if v.sort_dir == "desc" { "desc" } else { "asc" };
    serde_json::json!({
        "id": v.id,
        "objectTypeId": v.object_type_id,
        "name": v.name,
        "filters": v.filters_json.0.clone(),
        "sortBy": v.sort_by,
        "sortDir": sort_dir,
        "createdBy": v.created_by,
        "createdAt": ts(&v.created_at),
    })
}

// ─── Dashboards (DashboardInfo) ───────────────────────────────────────────

pub fn serialize_dashboard(d: &DashboardRow) -> Value {
    let widgets = match &d.layout_json.0 {
        Value::Array(a) => a.clone(),
        _ => vec![],
    };
    serde_json::json!({
        "id": d.id,
        "title": d.title,
        "description": d.description,
        "widgets": widgets,
        "createdBy": d.created_by,
        "createdAt": ts(&d.created_at),
        "updatedAt": ts(&d.updated_at),
    })
}

pub fn dashboard_widget_count(d: &DashboardRow) -> usize {
    d.layout_json.0.as_array().map(|a| a.len()).unwrap_or(0)
}

// ─── Applications (AppConfig + ApplicationInfo) ───────────────────────────

pub fn default_app_pages() -> Value {
    serde_json::json!([
        { "id": "overview", "title": "Overview", "sections": [{ "id": "main", "title": "Main" }] }
    ])
}

fn default_app_config() -> Value {
    serde_json::json!({
        "pages": default_app_pages(),
        "widgets": [],
        "filters": [],
    })
}

/// Application row → ApplicationInfo (configJson string → AppConfig, with the
/// legacy fallbacks; NO re-validation, exactly like serializeApplication).
pub fn serialize_application(a: &ApplicationRow) -> Value {
    let parsed: Value = serde_json::from_value(a.config_json.0.clone()).unwrap_or(Value::Null);
    let config = if parsed.is_object() {
        parsed
    } else {
        default_app_config()
    };
    let pages = match config.get("pages").and_then(|p| p.as_array()) {
        Some(p) if !p.is_empty() => Value::Array(p.clone()),
        _ => default_app_pages(),
    };
    // `config.widgets ?? []` — null coalesces to the empty array too
    let widgets = config
        .get("widgets")
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or_else(|| Value::Array(vec![]));
    let filters = config
        .get("filters")
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or_else(|| Value::Array(vec![]));
    serde_json::json!({
        "id": a.id,
        "name": a.name,
        "description": a.description,
        "config": {
            "pages": pages,
            "widgets": widgets,
            "filters": filters,
        },
        "createdBy": a.created_by,
        "createdAt": ts(&a.created_at),
        "updatedAt": ts(&a.updated_at),
    })
}

/// Distinct object type apiNames an app references (summary cards / search).
pub fn referenced_object_types(config: &Value) -> Vec<String> {
    let mut names: HashSet<String> = HashSet::new();
    if let Some(widgets) = config.get("widgets").and_then(|w| w.as_array()) {
        for w in widgets {
            let wtype = w.get("type").and_then(|t| t.as_str()).unwrap_or("");
            if wtype == "map" {
                if let Some(layers) = w.get("layers").and_then(|l| l.as_array()) {
                    for l in layers {
                        if let Some(n) = l.get("objectTypeApiName").and_then(|n| n.as_str()) {
                            names.insert(n.to_string());
                        }
                    }
                }
            } else if wtype != "actionButton" {
                if let Some(n) = w.get("objectTypeApiName").and_then(|n| n.as_str()) {
                    names.insert(n.to_string());
                }
            }
        }
    }
    if let Some(filters) = config.get("filters").and_then(|f| f.as_array()) {
        for f in filters {
            if let Some(n) = f.get("objectTypeApiName").and_then(|n| n.as_str()) {
                if n != "*" {
                    names.insert(n.to_string());
                }
            }
        }
    }
    let mut out: Vec<String> = names.into_iter().collect();
    out.sort();
    out
}

/// Ready-made "Supply chain operations" app config (exact legacy literal,
/// key order preserved by serde_json preserve_order).
pub fn supply_chain_config() -> Value {
    serde_json::json!({
        "pages": [
            { "id": "overview", "title": "Overview", "sections": [{ "id": "network", "title": "Network at a glance" }] },
            { "id": "shipments", "title": "Shipments", "sections": [{ "id": "workflow", "title": "Shipment workflow" }] },
        ],
        "widgets": [
            {
                "id": "map-network",
                "type": "map",
                "title": "Global network",
                "span": 2,
                "pageId": "overview",
                "sectionId": "network",
                "mapMode": "markers",
                "layers": [
                    {
                        "id": "layer-warehouse",
                        "objectTypeApiName": "warehouse",
                        "visible": true,
                        "fallbackProperty": "city",
                        "sizeBy": "capacity",
                    },
                    {
                        "id": "layer-supplier",
                        "objectTypeApiName": "supplier",
                        "visible": true,
                        "fallbackProperty": "country",
                        "colorBy": "region",
                        "sizeBy": "rating",
                    },
                ],
            },
            {
                "id": "stat-shipments",
                "type": "stat",
                "title": "Shipments in scope",
                "span": 1,
                "pageId": "overview",
                "sectionId": "network",
                "objectTypeApiName": "shipment",
                "agg": "count",
            },
            {
                "id": "table-shipments",
                "type": "objectTable",
                "title": "Shipments",
                "span": 2,
                "pageId": "shipments",
                "sectionId": "workflow",
                "objectTypeApiName": "shipment",
                "columns": ["status", "productName", "supplierId", "warehouseId", "quantity", "shipDate", "etaDays"],
            },
            {
                "id": "chart-shipment-status",
                "type": "chart",
                "title": "Shipments by status",
                "span": 2,
                "pageId": "shipments",
                "sectionId": "workflow",
                "objectTypeApiName": "shipment",
                "chartType": "bar",
                "groupBy": "status",
                "agg": "count",
                "topN": 10,
            },
            {
                "id": "action-update-status",
                "type": "actionButton",
                "title": "Update shipment status",
                "span": 1,
                "pageId": "shipments",
                "sectionId": "workflow",
                "actionApiName": "update-shipment-status",
                "useSelection": true,
            },
        ],
        "filters": [
            {
                "id": "filter-shipment-status",
                "objectTypeApiName": "shipment",
                "property": "status",
                "op": "eq",
                "kind": "select",
                "options": ["in_transit", "delivered", "delayed", "customs"],
                "label": "Shipment status",
            },
            {
                "id": "filter-supplier-region",
                "objectTypeApiName": "supplier",
                "property": "region",
                "op": "eq",
                "kind": "select",
                "options": ["EMEA", "APAC", "NA", "LATAM"],
                "label": "Supplier region",
            },
        ],
    })
}

/// Template defaults for POST /api/applications.
pub fn template_defaults(template: &str) -> (&'static str, &'static str, Value) {
    match template {
        "supply-chain" => (
            "Supply chain operations",
            "Operational map of warehouses and suppliers with live shipment flow — filter, inspect and update shipment status without leaving the app.",
            supply_chain_config(),
        ),
        _ => ("Untitled application", "", default_app_config()),
    }
}

// ─── AppConfig validation (appConfigSchema port) ──────────────────────────

const APP_WIDGET_TYPES: [&str; 5] = ["map", "objectTable", "stat", "actionButton", "chart"];
const MAP_MODES: [&str; 3] = ["markers", "cluster", "heatmap"];
const CHART_TYPES: [&str; 4] = ["bar", "line", "area", "pie"];
const APP_AGGS: [&str; 5] = ["count", "sum", "avg", "min", "max"];
const FILTER_OPS: [&str; 7] = ["eq", "neq", "contains", "gt", "lt", "gte", "lte"];
const FILTER_KINDS: [&str; 3] = ["text", "number", "select"];

fn str_field<'a>(
    m: &'a Map<String, Value>,
    path: &str,
    field: &str,
    min1: bool,
    max: usize,
) -> Result<&'a str, ApiError> {
    let p = format!("{path}.{field}");
    match m.get(field) {
        Some(Value::String(s)) => {
            if min1 && s.is_empty() {
                return Err(ApiError::bad_request(format!(
                    "{p}: Too small: expected string to have >=1 chars"
                )));
            }
            check_max_len(&p, s, max)?;
            Ok(s)
        }
        Some(other) => Err(ApiError::bad_request(format!(
            "{p}: Invalid input: expected string, received {}",
            kind_of(other)
        ))),
        None => Err(ApiError::bad_request(format!(
            "{p}: Invalid input: expected string, received undefined"
        ))),
    }
}

fn opt_str_field(
    m: &Map<String, Value>,
    path: &str,
    field: &str,
    max: usize,
) -> Result<Option<Value>, ApiError> {
    // nullish string: absent → None (key dropped), null → Some(Null), str → checked
    let p = format!("{path}.{field}");
    match m.get(field) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(Value::Null)),
        Some(Value::String(s)) => {
            check_max_len(&p, s, max)?;
            Ok(Some(Value::String(s.clone())))
        }
        Some(other) => Err(ApiError::bad_request(format!(
            "{p}: Invalid input: expected string, received {}",
            kind_of(other)
        ))),
    }
}

fn bool_field(
    m: &Map<String, Value>,
    path: &str,
    field: &str,
    default: bool,
) -> Result<bool, ApiError> {
    let p = format!("{path}.{field}");
    match m.get(field) {
        None | Some(Value::Null) => Ok(default),
        Some(Value::Bool(b)) => Ok(*b),
        Some(other) => Err(ApiError::bad_request(format!(
            "{p}: Invalid input: expected boolean, received {}",
            kind_of(other)
        ))),
    }
}

fn span_field(m: &Map<String, Value>, path: &str, default: i64) -> Result<i64, ApiError> {
    let p = format!("{path}.span");
    match m.get("span") {
        None | Some(Value::Null) => Ok(default),
        Some(Value::Number(n)) => match n.as_i64() {
            Some(1) | Some(2) | Some(3) => Ok(n.as_i64().unwrap()),
            _ => Err(ApiError::bad_request(format!(
                "{p}: Invalid input: expected 1, 2 or 3"
            ))),
        },
        Some(other) => Err(ApiError::bad_request(format!(
            "{p}: Invalid input: expected number, received {}",
            kind_of(other)
        ))),
    }
}

fn placement(
    m: &Map<String, Value>,
    path: &str,
    out: &mut Map<String, Value>,
) -> Result<(), ApiError> {
    for field in ["pageId", "sectionId"] {
        let p = format!("{path}.{field}");
        match m.get(field) {
            None => {}
            Some(Value::String(s)) => {
                if s.is_empty() || s.chars().count() > 100 {
                    return Err(ApiError::bad_request(format!(
                        "{p}: Invalid input: expected string with 1-100 chars"
                    )));
                }
                out.insert(field.into(), Value::String(s.clone()));
            }
            Some(other) => {
                return Err(ApiError::bad_request(format!(
                    "{p}: Invalid input: expected string, received {}",
                    kind_of(other)
                )))
            }
        }
    }
    Ok(())
}

/// Validate + normalize one app widget (discriminated union on `type`).
fn validate_app_widget(path: &str, w: &Value) -> Result<Value, ApiError> {
    let Value::Object(m) = w else {
        return Err(ApiError::bad_request(format!(
            "{path}: Invalid input: expected object, received {}",
            kind_of(w)
        )));
    };
    let wtype = match m.get("type").and_then(|t| t.as_str()) {
        Some(t) if APP_WIDGET_TYPES.contains(&t) => t,
        Some(t) => {
            return Err(enum_or_err(t, &format!("{path}.type"), &APP_WIDGET_TYPES).unwrap_err())
        }
        None => {
            return Err(ApiError::bad_request(format!(
                "{path}.type: Invalid input: expected string, received undefined"
            )))
        }
    };
    let mut out = Map::new();
    placement(m, path, &mut out)?;
    let id = str_field(m, path, "id", true, usize::MAX)?.to_string();
    let title = str_field(m, path, "title", true, 200)?.to_string();
    out.insert("id".into(), Value::String(id));
    out.insert("type".into(), Value::String(wtype.to_string()));
    out.insert("title".into(), Value::String(title));

    match wtype {
        "map" => {
            // layers: array max8
            let layers = match m.get("layers") {
                Some(Value::Array(a)) => a,
                Some(other) => {
                    return Err(ApiError::bad_request(format!(
                        "{path}.layers: Invalid input: expected array, received {}",
                        kind_of(other)
                    )))
                }
                None => {
                    return Err(ApiError::bad_request(format!(
                        "{path}.layers: Invalid input: expected array, received undefined"
                    )))
                }
            };
            if layers.len() > 8 {
                return Err(ApiError::bad_request(format!(
                    "{path}.layers: Too big: expected array to have <=8 items"
                )));
            }
            let mut norm_layers = Vec::with_capacity(layers.len());
            for (i, l) in layers.iter().enumerate() {
                let lpath = format!("{path}.layers.{i}");
                let Value::Object(lm) = l else {
                    return Err(ApiError::bad_request(format!(
                        "{lpath}: Invalid input: expected object, received {}",
                        kind_of(l)
                    )));
                };
                let mut lo = Map::new();
                lo.insert(
                    "id".into(),
                    Value::String(str_field(lm, &lpath, "id", true, usize::MAX)?.to_string()),
                );
                lo.insert(
                    "objectTypeApiName".into(),
                    Value::String(
                        str_field(lm, &lpath, "objectTypeApiName", true, 200)?.to_string(),
                    ),
                );
                lo.insert(
                    "visible".into(),
                    Value::Bool(bool_field(lm, &lpath, "visible", true)?),
                );
                for f in [
                    "latProperty",
                    "lngProperty",
                    "fallbackProperty",
                    "colorBy",
                    "sizeBy",
                ] {
                    if let Some(v) = opt_str_field(lm, &lpath, f, 200)? {
                        lo.insert(f.into(), v);
                    }
                }
                norm_layers.push(Value::Object(lo));
            }
            out.insert("layers".into(), Value::Array(norm_layers));
            // mapMode default markers
            let map_mode = match m.get("mapMode") {
                None | Some(Value::Null) => "markers".to_string(),
                Some(Value::String(s)) => {
                    enum_or_err(s, &format!("{path}.mapMode"), &MAP_MODES)?.to_string()
                }
                Some(other) => {
                    return Err(ApiError::bad_request(format!(
                        "{path}.mapMode: Invalid input: expected string, received {}",
                        kind_of(other)
                    )))
                }
            };
            out.insert("mapMode".into(), Value::String(map_mode));
            out.insert(
                "span".into(),
                crate::values::js_num(span_field(m, path, 2)? as f64),
            );
        }
        "objectTable" => {
            out.insert(
                "objectTypeApiName".into(),
                Value::String(str_field(m, path, "objectTypeApiName", true, 200)?.to_string()),
            );
            // columns: array of string max200, max30, nullish
            match m.get("columns") {
                None => {}
                Some(Value::Null) => {
                    out.insert("columns".into(), Value::Null);
                }
                Some(Value::Array(items)) => {
                    if items.len() > 30 {
                        return Err(ApiError::bad_request(format!(
                            "{path}.columns: Too big: expected array to have <=30 items"
                        )));
                    }
                    let mut cols = Vec::with_capacity(items.len());
                    for (i, c) in items.iter().enumerate() {
                        match c {
                            Value::String(s) => {
                                check_max_len(&format!("{path}.columns.{i}"), s, 200)?;
                                cols.push(Value::String(s.clone()));
                            }
                            other => {
                                return Err(ApiError::bad_request(format!(
                                "{path}.columns.{i}: Invalid input: expected string, received {}",
                                kind_of(other)
                            )))
                            }
                        }
                    }
                    out.insert("columns".into(), Value::Array(cols));
                }
                Some(other) => {
                    return Err(ApiError::bad_request(format!(
                        "{path}.columns: Invalid input: expected array, received {}",
                        kind_of(other)
                    )))
                }
            }
            out.insert(
                "span".into(),
                crate::values::js_num(span_field(m, path, 2)? as f64),
            );
        }
        "stat" => {
            out.insert(
                "objectTypeApiName".into(),
                Value::String(str_field(m, path, "objectTypeApiName", true, 200)?.to_string()),
            );
            let agg = match m.get("agg") {
                None | Some(Value::Null) => "count".to_string(),
                Some(Value::String(s)) => {
                    enum_or_err(s, &format!("{path}.agg"), &APP_AGGS)?.to_string()
                }
                Some(other) => {
                    return Err(ApiError::bad_request(format!(
                        "{path}.agg: Invalid input: expected string, received {}",
                        kind_of(other)
                    )))
                }
            };
            out.insert("agg".into(), Value::String(agg));
            if let Some(v) = opt_str_field(m, path, "valueProperty", 200)? {
                out.insert("valueProperty".into(), v);
            }
            out.insert(
                "span".into(),
                crate::values::js_num(span_field(m, path, 1)? as f64),
            );
        }
        "actionButton" => {
            out.insert(
                "actionApiName".into(),
                Value::String(str_field(m, path, "actionApiName", true, 200)?.to_string()),
            );
            out.insert(
                "useSelection".into(),
                Value::Bool(bool_field(m, path, "useSelection", false)?),
            );
            out.insert(
                "span".into(),
                crate::values::js_num(span_field(m, path, 1)? as f64),
            );
        }
        _ => {
            // chart
            out.insert(
                "objectTypeApiName".into(),
                Value::String(str_field(m, path, "objectTypeApiName", true, 200)?.to_string()),
            );
            let chart_type = match m.get("chartType").and_then(|t| t.as_str()) {
                Some(s) => enum_or_err(s, &format!("{path}.chartType"), &CHART_TYPES)?.to_string(),
                None => {
                    return Err(ApiError::bad_request(format!(
                        "{path}.chartType: Invalid input: expected string, received undefined"
                    )))
                }
            };
            out.insert("chartType".into(), Value::String(chart_type));
            out.insert(
                "groupBy".into(),
                Value::String(str_field(m, path, "groupBy", true, 200)?.to_string()),
            );
            let agg = match m.get("agg") {
                None | Some(Value::Null) => "count".to_string(),
                Some(Value::String(s)) => {
                    enum_or_err(s, &format!("{path}.agg"), &APP_AGGS)?.to_string()
                }
                Some(other) => {
                    return Err(ApiError::bad_request(format!(
                        "{path}.agg: Invalid input: expected string, received {}",
                        kind_of(other)
                    )))
                }
            };
            out.insert("agg".into(), Value::String(agg));
            if let Some(v) = opt_str_field(m, path, "valueProperty", 200)? {
                out.insert("valueProperty".into(), v);
            }
            // topN int 1..100 default 10
            let top_n = match m.get("topN") {
                None | Some(Value::Null) => 10i64,
                Some(Value::Number(n)) => match n.as_i64() {
                    Some(i) if (1..=100).contains(&i) => i,
                    _ => {
                        return Err(ApiError::bad_request(format!(
                            "{path}.topN: Invalid input: expected int between 1 and 100"
                        )))
                    }
                },
                Some(other) => {
                    return Err(ApiError::bad_request(format!(
                        "{path}.topN: Invalid input: expected number, received {}",
                        kind_of(other)
                    )))
                }
            };
            out.insert("topN".into(), crate::values::js_num(top_n as f64));
            out.insert(
                "span".into(),
                crate::values::js_num(span_field(m, path, 2)? as f64),
            );
        }
    }
    Ok(Value::Object(out))
}

fn validate_app_filter(path: &str, f: &Value) -> Result<Value, ApiError> {
    let Value::Object(m) = f else {
        return Err(ApiError::bad_request(format!(
            "{path}: Invalid input: expected object, received {}",
            kind_of(f)
        )));
    };
    let mut out = Map::new();
    out.insert(
        "id".into(),
        Value::String(str_field(m, path, "id", true, usize::MAX)?.to_string()),
    );
    out.insert(
        "objectTypeApiName".into(),
        Value::String(str_field(m, path, "objectTypeApiName", true, 200)?.to_string()),
    );
    out.insert(
        "property".into(),
        Value::String(str_field(m, path, "property", true, 200)?.to_string()),
    );
    let op = match m.get("op").and_then(|v| v.as_str()) {
        Some(s) => enum_or_err(s, &format!("{path}.op"), &FILTER_OPS)?.to_string(),
        None => {
            return Err(ApiError::bad_request(format!(
                "{path}.op: Invalid input: expected string, received undefined"
            )))
        }
    };
    out.insert("op".into(), Value::String(op));
    let kind = match m.get("kind") {
        None | Some(Value::Null) => "text".to_string(),
        Some(Value::String(s)) => {
            enum_or_err(s, &format!("{path}.kind"), &FILTER_KINDS)?.to_string()
        }
        Some(other) => {
            return Err(ApiError::bad_request(format!(
                "{path}.kind: Invalid input: expected string, received {}",
                kind_of(other)
            )))
        }
    };
    out.insert("kind".into(), Value::String(kind));
    let options = match m.get("options") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => {
            if items.len() > 50 {
                return Err(ApiError::bad_request(format!(
                    "{path}.options: Too big: expected array to have <=50 items"
                )));
            }
            let mut opts = Vec::with_capacity(items.len());
            for (i, o) in items.iter().enumerate() {
                match o {
                    Value::String(s) => {
                        check_max_len(&format!("{path}.options.{i}"), s, 200)?;
                        opts.push(Value::String(s.clone()));
                    }
                    other => {
                        return Err(ApiError::bad_request(format!(
                            "{path}.options.{i}: Invalid input: expected string, received {}",
                            kind_of(other)
                        )))
                    }
                }
            }
            opts
        }
        Some(other) => {
            return Err(ApiError::bad_request(format!(
                "{path}.options: Invalid input: expected array, received {}",
                kind_of(other)
            )))
        }
    };
    out.insert("options".into(), Value::Array(options));
    // label: nullish max200, transform → always present (null default)
    let label = match m.get("label") {
        None | Some(Value::Null) => Value::Null,
        Some(Value::String(s)) => {
            check_max_len(&format!("{path}.label"), s, 200)?;
            Value::String(s.clone())
        }
        Some(other) => {
            return Err(ApiError::bad_request(format!(
                "{path}.label: Invalid input: expected string, received {}",
                kind_of(other)
            )))
        }
    };
    out.insert("label".into(), label);
    Ok(Value::Object(out))
}

fn validate_app_page(path: &str, p: &Value) -> Result<Value, ApiError> {
    let Value::Object(m) = p else {
        return Err(ApiError::bad_request(format!(
            "{path}: Invalid input: expected object, received {}",
            kind_of(p)
        )));
    };
    let id = str_field(m, path, "id", true, 100)?.to_string();
    let title = str_field(m, path, "title", true, 100)?.to_string();
    let sections = match m.get("sections") {
        Some(Value::Array(a)) => a,
        Some(other) => {
            return Err(ApiError::bad_request(format!(
                "{path}.sections: Invalid input: expected array, received {}",
                kind_of(other)
            )))
        }
        None => {
            return Err(ApiError::bad_request(format!(
                "{path}.sections: Invalid input: expected array, received undefined"
            )))
        }
    };
    if sections.is_empty() || sections.len() > 20 {
        return Err(ApiError::bad_request(format!(
            "{path}.sections: Invalid input: expected array with 1-20 items"
        )));
    }
    let mut norm_sections = Vec::with_capacity(sections.len());
    for (i, s) in sections.iter().enumerate() {
        let spath = format!("{path}.sections.{i}");
        let Value::Object(sm) = s else {
            return Err(ApiError::bad_request(format!(
                "{spath}: Invalid input: expected object, received {}",
                kind_of(s)
            )));
        };
        let sid = str_field(sm, &spath, "id", true, 100)?.to_string();
        let stitle = str_field(sm, &spath, "title", true, 100)?.to_string();
        let mut so = Map::new();
        so.insert("id".into(), Value::String(sid));
        so.insert("title".into(), Value::String(stitle));
        norm_sections.push(Value::Object(so));
    }
    let mut out = Map::new();
    out.insert("id".into(), Value::String(id));
    out.insert("title".into(), Value::String(title));
    out.insert("sections".into(), Value::Array(norm_sections));
    Ok(Value::Object(out))
}

/// Validate + normalize a full AppConfig (appConfigSchema + superRefine).
/// `path` is the body-relative prefix ("config" for PATCH).
pub fn validate_app_config(path: &str, v: &Value) -> Result<Value, ApiError> {
    let Value::Object(m) = v else {
        return Err(ApiError::bad_request(format!(
            "{path}: Invalid input: expected object, received {}",
            kind_of(v)
        )));
    };
    // pages: min1 max12, default DEFAULT_APP_PAGES
    let pages_in = match m.get("pages") {
        None | Some(Value::Null) => default_app_pages().as_array().cloned().unwrap_or_default(),
        Some(Value::Array(a)) => a.clone(),
        Some(other) => {
            return Err(ApiError::bad_request(format!(
                "{path}.pages: Invalid input: expected array, received {}",
                kind_of(other)
            )))
        }
    };
    if pages_in.is_empty() || pages_in.len() > 12 {
        return Err(ApiError::bad_request(format!(
            "{path}.pages: Invalid input: expected array with 1-12 items"
        )));
    }
    let mut pages = Vec::with_capacity(pages_in.len());
    for (i, p) in pages_in.iter().enumerate() {
        pages.push(validate_app_page(&format!("{path}.pages.{i}"), p)?);
    }
    // widgets max24 default []
    let widgets_in = match m.get("widgets") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(a)) => a.clone(),
        Some(other) => {
            return Err(ApiError::bad_request(format!(
                "{path}.widgets: Invalid input: expected array, received {}",
                kind_of(other)
            )))
        }
    };
    if widgets_in.len() > 24 {
        return Err(ApiError::bad_request(format!(
            "{path}.widgets: Too big: expected array to have <=24 items"
        )));
    }
    let mut widgets = Vec::with_capacity(widgets_in.len());
    for (i, w) in widgets_in.iter().enumerate() {
        widgets.push(validate_app_widget(&format!("{path}.widgets.{i}"), w)?);
    }
    // filters max8 default []
    let filters_in = match m.get("filters") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(a)) => a.clone(),
        Some(other) => {
            return Err(ApiError::bad_request(format!(
                "{path}.filters: Invalid input: expected array, received {}",
                kind_of(other)
            )))
        }
    };
    if filters_in.len() > 8 {
        return Err(ApiError::bad_request(format!(
            "{path}.filters: Too big: expected array to have <=8 items"
        )));
    }
    let mut filters = Vec::with_capacity(filters_in.len());
    for (i, f) in filters_in.iter().enumerate() {
        filters.push(validate_app_filter(&format!("{path}.filters.{i}"), f)?);
    }

    // superRefine: duplicate page/section ids + widget placement
    let mut page_ids: HashSet<String> = HashSet::new();
    for p in &pages {
        let pid = p["id"].as_str().unwrap_or("").to_string();
        if page_ids.contains(&pid) {
            return Err(ApiError::bad_request(format!(
                "{path}.pages: Duplicate page id '{pid}'"
            )));
        }
        page_ids.insert(pid);
        let mut section_ids: HashSet<String> = HashSet::new();
        for s in p["sections"]
            .as_array()
            .map(|a| a.as_slice())
            .unwrap_or(&[])
        {
            let sid = s["id"].as_str().unwrap_or("").to_string();
            if section_ids.contains(&sid) {
                return Err(ApiError::bad_request(format!(
                    "{path}.pages: Duplicate section id '{sid}'"
                )));
            }
            section_ids.insert(sid);
        }
    }
    for (index, w) in widgets.iter().enumerate() {
        let Some(page_id) = w.get("pageId").and_then(|p| p.as_str()) else {
            continue; // pre-pages widgets belong to the first page
        };
        let page = pages.iter().find(|p| p["id"].as_str() == Some(page_id));
        let section_ok = match (page, w.get("sectionId").and_then(|s| s.as_str())) {
            (Some(p), Some(sid)) => p["sections"]
                .as_array()
                .map(|arr| arr.iter().any(|s| s["id"].as_str() == Some(sid)))
                .unwrap_or(false),
            (Some(_), None) => true,
            (None, _) => false,
        };
        if !section_ok {
            return Err(ApiError::bad_request(format!(
                "{path}.widgets.{index}: Widget placement refers to a missing page or section"
            )));
        }
    }

    let mut out = Map::new();
    out.insert("pages".into(), Value::Array(pages));
    out.insert("widgets".into(), Value::Array(widgets));
    out.insert("filters".into(), Value::Array(filters));
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn humanize_matches_legacy() {
        assert_eq!(humanize_api_name("customer_id"), "Customer Id");
        assert_eq!(
            humanize_api_name("productName"),
            "ProductName".replace("Name", " Name")
        );
        assert_eq!(
            humanize_api_name("unit_price_at_sale"),
            "Unit Price At Sale"
        );
        assert_eq!(humanize_api_name("etaDays"), "Eta Days");
        assert_eq!(humanize_api_name("leadTimeDays"), "Lead Time Days");
        assert_eq!(humanize_api_name("onTimePct"), "On Time Pct");
        assert_eq!(humanize_api_name("geoLat"), "Geo Lat");
        assert_eq!(humanize_api_name("id"), "Id");
        assert_eq!(humanize_api_name("HTTP2"), "HTTP2");
        assert_eq!(humanize_api_name("shipDate"), "Ship Date");
    }

    #[test]
    fn slugify_rules() {
        assert_eq!(slugify("Order App"), "order-app");
        assert_eq!(slugify("  Héllo--Wörld  "), "h-llo-w-rld");
        // digits survive slugify but fail the slug regex (starts-with-letter)
        assert_eq!(slugify("123"), "123");
        assert!(!slug_re().is_match("123"));
        assert!(slug_re().is_match(&slugify("Supply Chain Ops")));
        assert!(!slug_re().is_match("1abc"));
        assert!(!slug_re().is_match("Abc"));
    }

    #[test]
    fn derive_properties_marks_title() {
        let schema = vec![
            SchemaColumn {
                name: "id".into(),
                column_type: mf_types::ColumnType::String,
            },
            SchemaColumn {
                name: "productName".into(),
                column_type: mf_types::ColumnType::String,
            },
            SchemaColumn {
                name: "qty".into(),
                column_type: mf_types::ColumnType::Number,
            },
        ];
        let props = derive_properties(&schema, "id", Some("productName"));
        assert_eq!(props.len(), 3);
        assert!(!props[0].is_title);
        assert!(props[1].is_title);
        assert_eq!(props[1].display_name, "Product Name");
        assert_eq!(props[2].data_type, "number");
        // default title = primary key
        let props2 = derive_properties(&schema, "id", None);
        assert!(props2[0].is_title);
    }

    #[test]
    fn parameter_normalization() {
        let p = normalize_parameter(
            "parameters.0",
            &json!({
                "apiName": "newStatus", "displayName": "New Status", "dataType": "string",
                "required": true, "mapsTo": "status",
                "oneOf": ["in_transit", "", "delivered"]
            }),
        )
        .unwrap();
        assert_eq!(
            p,
            json!({
                "apiName": "newStatus", "displayName": "New Status", "dataType": "string",
                "required": true, "mapsTo": "status", "oneOf": ["in_transit", "delivered"]
            })
        );
        // empty oneOf dropped
        let p2 = normalize_parameter(
            "parameters.0",
            &json!({"apiName": "a", "dataType": "number", "mapsTo": "n", "oneOf": ["  "]}),
        )
        .unwrap();
        assert!(p2.get("oneOf").is_none());

        let e = normalize_parameter(
            "parameters.1",
            &json!({"apiName": "9bad", "dataType": "string", "mapsTo": "x"}),
        )
        .unwrap_err();
        assert_eq!(
            e.message,
            "parameters.1.apiName: parameter apiName must match [a-zA-Z][a-zA-Z0-9_]*"
        );
        let e = normalize_parameter(
            "parameters.0",
            &json!({"apiName": "a", "dataType": "string"}),
        )
        .unwrap_err();
        assert_eq!(
            e.message,
            "parameters.0.mapsTo: mapsTo (dataset column) is required"
        );
    }

    #[test]
    fn app_config_roundtrip_and_defaults() {
        // supply-chain template validates cleanly
        let cfg = supply_chain_config();
        let norm = validate_app_config("config", &cfg).unwrap();
        assert_eq!(
            referenced_object_types(&norm),
            vec!["shipment", "supplier", "warehouse"]
        );
        // widget defaults filled
        let w = &norm["widgets"][1];
        assert_eq!(w["span"], json!(1));
        assert_eq!(w["agg"], "count");

        // minimal config gets page defaults
        let min = validate_app_config("config", &json!({})).unwrap();
        assert_eq!(min["pages"], default_app_pages());
        assert_eq!(min["widgets"], json!([]));
        assert_eq!(min["filters"], json!([]));

        // filter label transform → null present
        let f = validate_app_config(
            "config",
            &json!({"filters": [{"id": "f1", "objectTypeApiName": "order", "property": "status", "op": "eq"}]}),
        )
        .unwrap();
        assert_eq!(f["filters"][0]["label"], Value::Null);
        assert_eq!(f["filters"][0]["kind"], "text");
        assert_eq!(f["filters"][0]["options"], json!([]));
    }

    #[test]
    fn app_config_errors() {
        let e = validate_app_config(
            "config",
            &json!({"pages": [{"id": "a", "title": "A", "sections": [{"id": "s", "title": "S"}]},
                              {"id": "a", "title": "A2", "sections": [{"id": "s", "title": "S"}]}]}),
        )
        .unwrap_err();
        assert_eq!(e.message, "config.pages: Duplicate page id 'a'");

        let e = validate_app_config(
            "config",
            &json!({"widgets": [{"id": "w", "type": "stat", "title": "t", "objectTypeApiName": "o", "pageId": "nope"}]}),
        )
        .unwrap_err();
        assert_eq!(
            e.message,
            "config.widgets.0: Widget placement refers to a missing page or section"
        );

        let e = validate_app_config(
            "config",
            &json!({"widgets": [{"id": "w", "type": "chart", "title": "t", "objectTypeApiName": "o", "chartType": "bar", "groupBy": "g", "topN": 500}]}),
        )
        .unwrap_err();
        assert_eq!(
            e.message,
            "config.widgets.0.topN: Invalid input: expected int between 1 and 100"
        );
    }

    #[test]
    fn application_serializer_fallbacks() {
        let mut a = ApplicationRow {
            id: "a1".into(),
            name: "App".into(),
            description: None,
            config_json: sqlx::types::Json(json!({"widgets": null})),
            created_by: Some("x@y.z".into()),
            created_at: mf_types::ts::parse_ts("2026-02-12T03:04:05.123Z").unwrap(),
            updated_at: mf_types::ts::parse_ts("2026-02-12T03:04:05.123Z").unwrap(),
        };
        let v = serialize_application(&a);
        assert_eq!(v["config"]["pages"], default_app_pages());
        assert_eq!(v["config"]["widgets"], json!([]));
        assert_eq!(v["createdAt"], "2026-02-12T03:04:05.123Z");
        // empty pages array → default pages
        a.config_json = sqlx::types::Json(json!({"pages": [], "widgets": [], "filters": []}));
        let v2 = serialize_application(&a);
        assert_eq!(v2["config"]["pages"], default_app_pages());
    }

    #[test]
    fn referenced_types_skip_wildcard_and_action_buttons() {
        let cfg = json!({
            "widgets": [
                {"type": "actionButton", "actionApiName": "a"},
                {"type": "map", "layers": [{"objectTypeApiName": "warehouse"}, {"objectTypeApiName": "supplier"}]},
                {"type": "objectTable", "objectTypeApiName": "shipment"}
            ],
            "filters": [
                {"objectTypeApiName": "*"},
                {"objectTypeApiName": "shipment"}
            ]
        });
        assert_eq!(
            referenced_object_types(&cfg),
            vec!["shipment", "supplier", "warehouse"]
        );
    }
}
