//! Object row loading + link resolution orchestration — port of getObjectRows
//! and getLinksFor (ontology-service.ts). Dataset rows come from catalog's
//! internal rows endpoints WITH the caller's role so governance masking is
//! applied at the single masking site (catalog) before any filtering here.

use mf_types::{Row, Value};
use mf_web::ApiError;
use std::collections::HashMap;

use crate::filters::{apply_filters, ObjectViewFilter};
use crate::links::{
    resolve_link_targets, to_link_entry, Direction, LinkEntry, LinkRows, LinkSpec, TypeCore,
};
use crate::serialize::derive_properties;
use crate::state::AppState;
use crate::values::{compare_values, loose_equal, stringify_values};

/// One object instance: { pk, values, _title }.
pub struct ObjectRow {
    pub pk: Value,
    pub values: Row,
    pub title: Value,
}

impl ObjectRow {
    pub fn to_json(&self, masked: &[String]) -> Value {
        let mut m = serde_json::Map::new();
        m.insert("pk".into(), self.pk.clone());
        m.insert("values".into(), Value::Object(self.values.clone()));
        m.insert("_title".into(), self.title.clone());
        m.insert(
            "_masked".into(),
            Value::Array(masked.iter().map(|s| Value::String(s.clone())).collect()),
        );
        Value::Object(m)
    }
}

pub struct ObjectRowsResult {
    pub rows: Vec<ObjectRow>,
    pub total: usize,
    /// Column list for the explorer table (properties or schema fallback).
    pub columns: Vec<crate::links::PropLike>,
    /// Columns the catalog masked for the requested role (empty for raw
    /// reads) — surfaced as `_masked` on every row.
    pub masked_columns: Vec<String>,
}

pub struct GetObjectRowsOpts<'a> {
    pub query: Option<&'a str>,
    pub page: f64,
    pub page_size: f64,
    /// Server-side consumers that must aggregate the complete governed set.
    pub all: bool,
    pub filters: &'a [ObjectViewFilter],
    pub sort_by: Option<&'a str>,
    pub sort_dir: &'a str,
}

impl Default for GetObjectRowsOpts<'_> {
    fn default() -> Self {
        Self {
            query: None,
            page: 1.0,
            page_size: 50.0,
            all: false,
            filters: &[],
            sort_by: None,
            sort_dir: "asc",
        }
    }
}

/// Property column projection used by the response `columns` list.
pub fn columns_json(columns: &[crate::links::PropLike]) -> Vec<Value> {
    columns.iter().map(|p| p.to_json()).collect()
}

/// Title column of a type: the isTitle property, else the primary key.
pub fn title_column_of(ot: &TypeCore) -> Option<String> {
    ot.properties
        .iter()
        .find(|p| p.is_title)
        .map(|p| p.api_name.clone())
        .or_else(|| ot.primary_key.clone())
}

/// Load the object type's backing dataset head rows (consumer version,
/// masked at `role` when provided) and map them to object instances.
/// Ok(None-shaped empty result) when the type has no consumable version
/// (legacy: empty result).
pub async fn get_object_rows(
    state: &AppState,
    object_type: &TypeCore,
    role: Option<&str>,
    opts: GetObjectRowsOpts<'_>,
) -> Result<ObjectRowsResult, ApiError> {
    let page = (opts.page.floor().max(1.0)) as usize;
    let page_size = (opts.page_size.floor().clamp(1.0, 200.0)) as usize;

    let empty = ObjectRowsResult {
        rows: vec![],
        total: 0,
        columns: object_type.properties.clone(),
        masked_columns: vec![],
    };
    let Some(dataset_id) = object_type.source_dataset_id.as_deref() else {
        return Ok(empty);
    };

    // P2: the object layer is a CONSUMER — catalog resolves the gated head.
    // Masking is applied in catalog at the caller's role BEFORE the query
    // filter and pagination, so search can never leak governed values.
    let Some(payload) = state.catalog.head_rows_full(dataset_id, role).await? else {
        return Ok(empty);
    };

    let pk_column = object_type.primary_key.clone();
    let title_column = title_column_of(object_type).or_else(|| pk_column.clone());

    let mut rows = payload.rows;
    let query = opts.query.map(|q| q.trim()).filter(|q| !q.is_empty());
    if let Some(q) = query {
        rows = query_filter(rows, q);
    }
    // Saved-view structured filters (after masking — same leak prevention).
    if !opts.filters.is_empty() {
        rows = apply_filters(rows, opts.filters);
    }
    // Sorting (numeric compare when both sides are numeric, else string).
    if let Some(sort_by) = opts.sort_by.map(|s| s.trim()).filter(|s| !s.is_empty()) {
        sort_rows(&mut rows, sort_by, opts.sort_dir == "desc");
    }

    let total = rows.len();
    let paged: Vec<Row> = if opts.all {
        rows
    } else {
        let start = (page - 1) * page_size;
        rows.into_iter().skip(start).take(page_size).collect()
    };

    // Fallback when a type somehow has no Property rows: derive from the
    // resolved version's schema (carried on the rows payload).
    let columns = if !object_type.properties.is_empty() {
        object_type.properties.clone()
    } else {
        derive_properties(&payload.schema, pk_column.as_deref().unwrap_or(""), None)
            .into_iter()
            .map(|p| crate::links::PropLike {
                api_name: p.api_name,
                display_name: p.display_name,
                data_type: p.data_type,
                is_title: p.is_title,
                hide_in_table: p.hide_in_table,
            })
            .collect()
    };

    Ok(ObjectRowsResult {
        rows: paged
            .into_iter()
            .map(|row| ObjectRow {
                pk: match &pk_column {
                    Some(c) => row.get(c).cloned().unwrap_or(Value::Null),
                    None => Value::Null,
                },
                title: match &title_column {
                    Some(c) => row.get(c).cloned().unwrap_or(Value::Null),
                    None => Value::Null,
                },
                values: row,
            })
            .collect(),
        total,
        columns,
        masked_columns: payload.masked_columns,
    })
}

/// Case-insensitive substring match across stringified row values (port of
/// the legacy ?query= filter: JSON.stringify(Object.values(row))).
pub fn query_filter(rows: Vec<Row>, q: &str) -> Vec<Row> {
    let needle = q.to_lowercase();
    rows.into_iter()
        .filter(|row| stringify_values(row).to_lowercase().contains(&needle))
        .collect()
}

/// Sort with the legacy comparator: nullish/'' last either way; numeric
/// compare when both sides are numeric, else string compare; stable order.
pub fn sort_rows(rows: &mut [Row], sort_by: &str, desc: bool) {
    fn empty(v: Option<&Value>) -> bool {
        match v {
            None | Some(Value::Null) => true,
            Some(Value::String(s)) => s.is_empty(),
            _ => false,
        }
    }
    rows.sort_by(|a, b| {
        let av = a.get(sort_by);
        let bv = b.get(sort_by);
        match (empty(av), empty(bv)) {
            (true, true) => std::cmp::Ordering::Equal,
            (true, false) => std::cmp::Ordering::Greater,
            (false, true) => std::cmp::Ordering::Less,
            (false, false) => {
                let c = compare_values(av.unwrap(), bv.unwrap());
                if desc {
                    c.reverse()
                } else {
                    c
                }
            }
        }
    });
}

/// Find one object row by pk (loose match) — port of the detail-route lookup.
pub fn find_row_by_pk<'a>(rows: &'a [Row], pk_column: &str, pk: &str) -> Option<&'a Row> {
    let wanted = Value::String(pk.to_string());
    rows.iter()
        .find(|row| match row.get(pk_column) {
            Some(cell) => loose_equal(cell, &wanted),
            None => false,
        })
}

// ─── getLinksFor ──────────────────────────────────────────────────────────

fn link_spec_of(row: &crate::state::LinkTypeRow) -> LinkSpec {
    LinkSpec {
        id: row.id.clone(),
        api_name: row.api_name.clone(),
        display_name: row.display_name.clone(),
        cardinality: row.cardinality.clone(),
        fk_property: row.fk_property.clone(),
        fk_side: row.fk_side.clone(),
        link_dataset_id: row.link_dataset_id.clone(),
        from_key_column: row.from_key_column.clone(),
        to_key_column: row.to_key_column.clone(),
    }
}

/// Row cache per dataset (link resolution touches a few datasets repeatedly).
struct RowCache {
    rows: HashMap<String, Option<Vec<Row>>>,
    schemas: HashMap<String, Vec<mf_types::SchemaColumn>>,
}

impl RowCache {
    async fn rows_of(
        &mut self,
        state: &AppState,
        dataset_id: &str,
        role: &str,
    ) -> Result<Option<&Vec<Row>>, ApiError> {
        if !self.rows.contains_key(dataset_id) {
            let fetched = state.catalog.head_rows(dataset_id, Some(role)).await?;
            self.rows.insert(dataset_id.to_string(), fetched);
        }
        Ok(self.rows.get(dataset_id).and_then(|o| o.as_ref()))
    }

    async fn schema_of(
        &mut self,
        state: &AppState,
        dataset_id: &str,
    ) -> Result<&Vec<mf_types::SchemaColumn>, ApiError> {
        if !self.schemas.contains_key(dataset_id) {
            let schema = state
                .catalog
                .head_version(dataset_id)
                .await?
                .map(|v| v.schema)
                .unwrap_or_default();
            self.schemas.insert(dataset_id.to_string(), schema);
        }
        Ok(self.schemas.get(dataset_id).unwrap())
    }
}

/// Links for an object detail page in BOTH directions (port of getLinksFor).
/// `viewed_row` is the (masked) row of the viewed object; other-side rows are
/// fetched through catalog with the caller's role so link titles arrive
/// already masked (legacy masked them in maskLinkTitles).
pub async fn get_links_for(
    state: &AppState,
    viewed_row: Option<&Row>,
    pk: &Value,
    role: &str,
    outgoing: Vec<(crate::state::LinkTypeRow, TypeCore)>,
    incoming: Vec<(crate::state::LinkTypeRow, TypeCore)>,
) -> Result<Vec<LinkEntry>, ApiError> {
    let mut cache = RowCache {
        rows: HashMap::new(),
        schemas: HashMap::new(),
    };
    let mut entries = Vec::new();

    for (direction, links) in [
        (Direction::Outgoing, outgoing),
        (Direction::Incoming, incoming),
    ] {
        for (link_row, other) in links {
            let link = link_spec_of(&link_row);
            // Pre-fetch the datasets the resolver may need.
            let other_rows: Option<Vec<Row>> = match other.source_dataset_id.as_deref() {
                Some(ds) => cache.rows_of(state, ds, role).await?.cloned(),
                None => None,
            };
            let (link_rows, link_schema) = if link.cardinality == "many-to-many" {
                match link.link_dataset_id.as_deref() {
                    Some(ds) => {
                        let rows = cache.rows_of(state, ds, role).await?.cloned();
                        let schema = cache.schema_of(state, ds).await?.clone();
                        (rows, Some(schema))
                    }
                    None => (None, None),
                }
            } else {
                (None, None)
            };
            let (targets, total) = resolve_link_targets(
                &link,
                &other,
                direction,
                pk,
                &LinkRows {
                    link_rows: link_rows.as_deref(),
                    link_schema: link_schema.as_deref(),
                    other_rows: other_rows.as_deref(),
                    viewed_row,
                },
            );
            entries.push(to_link_entry(&link, other, direction, targets, total));
        }
    }
    Ok(entries)
}

/// Load the OTHER-side TypeCore for every link of a type (both directions),
/// with properties so titles resolve.
pub async fn load_link_sides(
    db: &sqlx::PgPool,
    type_id: &str,
) -> Result<
    (
        Vec<(crate::state::LinkTypeRow, TypeCore)>,
        Vec<(crate::state::LinkTypeRow, TypeCore)>,
    ),
    ApiError,
> {
    let mut out_links = Vec::new();
    for (l, _meta) in crate::dbx::outgoing_links(db, type_id).await? {
        if let Some(other) = crate::dbx::object_type_by_id(db, &l.to_type_id).await? {
            let props = crate::dbx::load_properties(db, &other.id).await?;
            out_links.push((l, crate::dbx::type_core_of(&other, &props)));
        }
    }
    let mut in_links = Vec::new();
    for (l, _meta) in crate::dbx::incoming_links(db, type_id).await? {
        if let Some(other) = crate::dbx::object_type_by_id(db, &l.from_type_id).await? {
            let props = crate::dbx::load_properties(db, &other.id).await?;
            in_links.push((l, crate::dbx::type_core_of(&other, &props)));
        }
    }
    Ok((out_links, in_links))
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

    #[test]
    fn query_filter_matches_stringified_values() {
        let data = rows(json!([
            {"id": "C001", "name": "Amina Khan", "qty": 10},
            {"id": "C002", "name": "Hassan Ali", "qty": 22}
        ]));
        assert_eq!(query_filter(data.clone(), "amina").len(), 1);
        // numeric cells match through JSON.stringify
        assert_eq!(query_filter(data.clone(), "22").len(), 1);
        assert_eq!(query_filter(data.clone(), "c00").len(), 2);
        assert_eq!(query_filter(data.clone(), "nope").len(), 0);
        // keys are NOT part of the stringified values
        assert_eq!(query_filter(data.clone(), "name").len(), 0);
    }

    #[test]
    fn sort_nulls_last_numeric_and_string() {
        let mut data = rows(json!([
            {"n": 3, "s": "b"},
            {"n": null, "s": ""},
            {"n": 10, "s": "a"},
            {"n": 1, "s": "C"}
        ]));
        sort_rows(&mut data, "n", false);
        let ns: Vec<Value> = data.iter().map(|r| r["n"].clone()).collect();
        assert_eq!(ns, vec![json!(1), json!(3), json!(10), Value::Null]);
        sort_rows(&mut data, "n", true);
        let ns: Vec<Value> = data.iter().map(|r| r["n"].clone()).collect();
        // desc: 10, 3, 1, null LAST either way
        assert_eq!(ns, vec![json!(10), json!(3), json!(1), Value::Null]);
        // '' counts as empty too
        sort_rows(&mut data, "s", false);
        let ss: Vec<Value> = data.iter().map(|r| r["s"].clone()).collect();
        assert_eq!(ss, vec![json!("C"), json!("a"), json!("b"), json!("")]);
    }

    #[test]
    fn find_row_loose_pk() {
        let data = rows(json!([{"id": 5}, {"id": "C2"}]));
        assert!(find_row_by_pk(&data, "id", "5").is_some());
        assert!(find_row_by_pk(&data, "id", "C2").is_some());
        assert!(find_row_by_pk(&data, "id", "C3").is_none());
    }

    #[test]
    fn object_row_json_shape() {
        let r = ObjectRow {
            pk: json!("C1"),
            values: rows(json!([{"id": "C1"}])).remove(0),
            title: json!("Amina"),
        };
        let v = r.to_json(&["salary".to_string()]);
        assert_eq!(
            v,
            json!({"pk": "C1", "values": {"id": "C1"}, "_title": "Amina", "_masked": ["salary"]})
        );
        let keys: Vec<&String> = v.as_object().unwrap().keys().collect();
        assert_eq!(keys, vec!["pk", "values", "_title", "_masked"]);
    }
}
