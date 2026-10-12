//! Link resolution — pure port of resolveLinkTargets/getLinksFor/toLinkEntry
//! from ontology-service.ts. All functions operate on already-fetched row
//! sets (no I/O) so cardinality semantics are unit-testable.

use mf_types::{Row, SchemaColumn, Value};
use std::collections::HashSet;

use crate::values::{js_string, loose_equal};

/// Max related rows fetched for link targets (MAX_LINK_TARGETS).
pub const MAX_LINK_TARGETS: usize = 50;
/// R14.8: link entries carry a `total` plus at most this many sample targets.
pub const SAMPLE_LINK_TARGETS: usize = 5;

/// Minimal property shape (properties table row projected).
#[derive(Debug, Clone, PartialEq)]
pub struct PropLike {
    pub api_name: String,
    pub display_name: String,
    pub data_type: String,
    pub is_title: bool,
    pub hide_in_table: bool,
}

impl PropLike {
    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "apiName": self.api_name,
            "displayName": self.display_name,
            "dataType": self.data_type,
            "isTitle": self.is_title,
            "hideInTable": self.hide_in_table,
        })
    }
}

/// Minimal object-type shape needed to map dataset rows onto objects.
#[derive(Debug, Clone)]
pub struct TypeCore {
    pub id: String,
    pub api_name: String,
    pub display_name: String,
    pub primary_key: Option<String>,
    pub source_dataset_id: Option<String>,
    pub icon: String,
    pub color: String,
    pub properties: Vec<PropLike>,
}

/// Link definition (link_types row projected for resolution).
#[derive(Debug, Clone)]
pub struct LinkSpec {
    pub id: String,
    pub api_name: String,
    pub display_name: String,
    pub cardinality: String,
    pub fk_property: Option<String>,
    pub fk_side: Option<String>,
    pub link_dataset_id: Option<String>,
    pub from_key_column: Option<String>,
    pub to_key_column: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Outgoing,
    Incoming,
}

/// One resolved link target sample: { pk, _title }.
#[derive(Debug, Clone, PartialEq)]
pub struct LinkTarget {
    pub pk: Value,
    pub title: Value,
}

/// A link entry of the object-detail response.
#[derive(Debug, Clone)]
pub struct LinkEntry {
    pub id: String,
    pub api_name: String,
    pub display_name: String,
    pub direction: Direction,
    pub cardinality: String,
    pub to_type: TypeCore,
    pub total: usize,
    pub fk_property: Option<String>,
    pub targets: Vec<LinkTarget>,
}

impl LinkEntry {
    /// Contract JSON (exact legacy field order).
    pub fn to_json(&self) -> Value {
        let mut targets = Vec::with_capacity(self.targets.len());
        for t in &self.targets {
            let mut m = serde_json::Map::new();
            m.insert("pk".into(), t.pk.clone());
            m.insert("_title".into(), t.title.clone());
            targets.push(Value::Object(m));
        }
        serde_json::json!({
            "id": self.id,
            "apiName": self.api_name,
            "displayName": self.display_name,
            "direction": if self.direction == Direction::Outgoing { "outgoing" } else { "incoming" },
            "cardinality": self.cardinality,
            "toTypeId": self.to_type.id,
            "toTypeApiName": self.to_type.api_name,
            "toTypeDisplayName": self.to_type.display_name,
            "toTypeIcon": self.to_type.icon,
            "toTypeColor": self.to_type.color,
            "total": self.total,
            "fkProperty": self.fk_property,
            "targets": targets,
        })
    }
}

/// Port of foreignKeySide(): explicit fkSide wins; legacy null means 'to'
/// except for many-to-one (the FK lives on the FROM side).
pub fn foreign_key_side(link: &LinkSpec) -> &'static str {
    match link.fk_side.as_deref() {
        Some("from") => "from",
        Some("to") => "to",
        _ => {
            if link.cardinality == "many-to-one" {
                "from"
            } else {
                "to"
            }
        }
    }
}

/// Title column of a type: the isTitle property, else the primary key.
pub fn title_property_of(t: &TypeCore) -> Option<&str> {
    t.properties
        .iter()
        .find(|p| p.is_title)
        .map(|p| p.api_name.as_str())
        .or(t.primary_key.as_deref())
}

/// JS String(v) for a cell (undefined when the column is missing).
fn stringify_cell(row: &Row, col: &str) -> String {
    match row.get(col) {
        Some(v) => js_string(v),
        None => "undefined".to_string(),
    }
}

/// Port of fetchRowsByPkValues: other-type rows whose pk STRING-matches one of
/// `pks`, capped at MAX_LINK_TARGETS (scan order preserved).
pub fn fetch_rows_by_pk_values<'a>(
    other: &TypeCore,
    pks: &[Value],
    rows: &'a [Row],
) -> Vec<&'a Row> {
    let (Some(pk_col), false) = (other.primary_key.as_deref(), pks.is_empty()) else {
        return vec![];
    };
    let wanted: HashSet<String> = pks.iter().map(js_string).collect();
    let mut found = Vec::new();
    for row in rows {
        if wanted.contains(&stringify_cell(row, pk_col)) {
            found.push(row);
            if found.len() >= MAX_LINK_TARGETS {
                break;
            }
        }
    }
    found
}

/// Everything the resolver may need, pre-fetched by the caller (None = the
/// backing dataset could not be loaded → treated as empty, like legacy null
/// snapshots).
pub struct LinkRows<'a> {
    /// Rows of the link dataset (many-to-many only).
    pub link_rows: Option<&'a [Row]>,
    /// Schema of the link dataset (firstCol/secondCol fallback).
    pub link_schema: Option<&'a [SchemaColumn]>,
    /// Rows of the OTHER type's source dataset.
    pub other_rows: Option<&'a [Row]>,
    /// The viewed object's own row.
    pub viewed_row: Option<&'a Row>,
}

fn target_of(row: &Row, other: &TypeCore) -> LinkTarget {
    let pk_col = other.primary_key.as_deref().unwrap_or("");
    let title_col = title_property_of(other);
    LinkTarget {
        pk: row.get(pk_col).cloned().unwrap_or(Value::Null),
        title: match title_col {
            Some(tc) => row.get(tc).cloned().unwrap_or(Value::Null),
            None => Value::Null,
        },
    }
}

/// Port of resolveLinkTargets — per-cardinality traversal over row sets.
/// Returns (sample targets ≤ SAMPLE_LINK_TARGETS, total matches).
pub fn resolve_link_targets(
    link: &LinkSpec,
    other: &TypeCore,
    direction: Direction,
    viewed_pk: &Value,
    data: &LinkRows<'_>,
) -> (Vec<LinkTarget>, usize) {
    if other.primary_key.is_none() {
        return (vec![], 0);
    }

    // ── many-to-many: explicit mapping dataset ─────────────────────────
    if link.cardinality == "many-to-many" {
        if link.link_dataset_id.is_none() {
            return (vec![], 0);
        }
        let (Some(link_rows), Some(schema)) = (data.link_rows, data.link_schema) else {
            return (vec![], 0);
        };
        let first_col = link
            .from_key_column
            .clone()
            .or_else(|| schema.first().map(|c| c.name.clone()));
        let second_col = link
            .to_key_column
            .clone()
            .or_else(|| schema.get(1).map(|c| c.name.clone()));
        let (Some(first_col), Some(second_col)) = (first_col, second_col) else {
            return (vec![], 0);
        };
        // outgoing: this type is the FROM side (firstCol); incoming: secondCol.
        let (own_col, other_col) = if direction == Direction::Outgoing {
            (first_col.as_str(), second_col.as_str())
        } else {
            (second_col.as_str(), first_col.as_str())
        };
        let mut other_pks: Vec<Value> = Vec::new();
        for row in link_rows {
            let own = row.get(own_col).cloned().unwrap_or(Value::Null);
            if loose_equal(&own, viewed_pk) {
                let v = row.get(other_col).cloned().unwrap_or(Value::Null);
                if !v.is_null() && !other_pks.iter().any(|p| loose_equal(p, &v)) {
                    other_pks.push(v);
                }
            }
        }
        // total = every distinct match; rows fetched for the sample only.
        let sample_pks: Vec<Value> = other_pks
            .iter()
            .take(SAMPLE_LINK_TARGETS)
            .cloned()
            .collect();
        let rows = match data.other_rows {
            Some(rows) => fetch_rows_by_pk_values(other, &sample_pks, rows),
            None => vec![],
        };
        let targets: Vec<LinkTarget> = rows
            .iter()
            .map(|r| target_of(r, other))
            .take(SAMPLE_LINK_TARGETS)
            .collect();
        return (targets, other_pks.len());
    }

    // ── the linked type holds the FK (one-to-many from this side) ──────
    let own_side = if direction == Direction::Outgoing {
        "from"
    } else {
        "to"
    };
    if foreign_key_side(link) != own_side {
        let (true, Some(fk_property)) = (
            other.source_dataset_id.is_some(),
            link.fk_property.as_deref(),
        ) else {
            return (vec![], 0);
        };
        let Some(other_rows) = data.other_rows else {
            return (vec![], 0);
        };
        let mut all: Vec<LinkTarget> = Vec::new();
        for row in other_rows {
            let cell = row.get(fk_property).cloned().unwrap_or(Value::Null);
            if loose_equal(&cell, viewed_pk) {
                all.push(target_of(row, other));
            }
        }
        let total = all.len();
        all.truncate(SAMPLE_LINK_TARGETS);
        return (all, total);
    }

    // ── the viewed object holds the other type's pk in its FK column ───
    let (Some(viewed_row), Some(fk_property)) = (data.viewed_row, link.fk_property.as_deref())
    else {
        return (vec![], 0);
    };
    let fk_value = viewed_row.get(fk_property).cloned().unwrap_or(Value::Null);
    let empty = matches!(&fk_value, Value::Null) || fk_value.as_str().is_some_and(|s| s.is_empty());
    if empty {
        return (vec![], 0);
    }
    let rows = match data.other_rows {
        Some(rows) => fetch_rows_by_pk_values(other, &[fk_value], rows),
        None => vec![],
    };
    let targets: Vec<LinkTarget> = rows.iter().map(|r| target_of(r, other)).collect();
    let total = targets.len();
    (targets, total)
}

/// Build the response entry (port of toLinkEntry): fkProperty is surfaced only
/// when the OTHER side does not hold it (deep-link "view all" affordance).
pub fn to_link_entry(
    link: &LinkSpec,
    other: TypeCore,
    direction: Direction,
    targets: Vec<LinkTarget>,
    total: usize,
) -> LinkEntry {
    let own_side = if direction == Direction::Outgoing {
        "from"
    } else {
        "to"
    };
    let fk_property = if link.cardinality != "many-to-many" && foreign_key_side(link) != own_side {
        link.fk_property.clone()
    } else {
        None
    };
    LinkEntry {
        id: link.id.clone(),
        api_name: link.api_name.clone(),
        display_name: link.display_name.clone(),
        direction,
        cardinality: link.cardinality.clone(),
        to_type: other,
        total,
        fk_property,
        targets,
    }
}

// ─── Link config validation helpers (ontology-link-config.ts) ─────────────

/// effectiveFkSide(): fkSide ?? (one-to-many ? 'to' : 'from').
pub fn effective_fk_side(cardinality: &str, fk_side: Option<&str>) -> &'static str {
    match fk_side {
        Some("from") => "from",
        Some("to") => "to",
        _ => {
            if cardinality == "one-to-many" {
                "to"
            } else {
                "from"
            }
        }
    }
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

    fn tcore(id: &str, api: &str, pk: &str, ds: &str, title_prop: Option<&str>) -> TypeCore {
        let mut props = vec![PropLike {
            api_name: pk.into(),
            display_name: pk.into(),
            data_type: "string".into(),
            is_title: title_prop.is_none(),
            hide_in_table: false,
        }];
        if let Some(tp) = title_prop {
            props.push(PropLike {
                api_name: tp.into(),
                display_name: tp.into(),
                data_type: "string".into(),
                is_title: true,
                hide_in_table: false,
            });
        }
        TypeCore {
            id: id.into(),
            api_name: api.into(),
            display_name: api.into(),
            primary_key: Some(pk.into()),
            source_dataset_id: Some(ds.into()),
            icon: "box".into(),
            color: "emerald".into(),
            properties: props,
        }
    }

    fn link(card: &str, fk: Option<&str>, side: Option<&str>) -> LinkSpec {
        LinkSpec {
            id: "l1".into(),
            api_name: "lk".into(),
            display_name: "Lk".into(),
            cardinality: card.into(),
            fk_property: fk.map(String::from),
            fk_side: side.map(String::from),
            link_dataset_id: None,
            from_key_column: None,
            to_key_column: None,
        }
    }

    #[test]
    fn fk_side_derivation() {
        // legacy null fkSide: many-to-one → from, everything else → to
        assert_eq!(
            foreign_key_side(&link("many-to-one", Some("x"), None)),
            "from"
        );
        assert_eq!(
            foreign_key_side(&link("one-to-many", Some("x"), None)),
            "to"
        );
        assert_eq!(foreign_key_side(&link("one-to-one", Some("x"), None)), "to");
        assert_eq!(
            foreign_key_side(&link("one-to-many", Some("x"), Some("from"))),
            "from"
        );
        // config-time default: one-to-many → to, else from
        assert_eq!(effective_fk_side("one-to-many", None), "to");
        assert_eq!(effective_fk_side("many-to-one", None), "from");
        assert_eq!(effective_fk_side("one-to-one", None), "from");
        assert_eq!(effective_fk_side("many-to-many", None), "from");
        assert_eq!(effective_fk_side("one-to-many", Some("from")), "from");
    }

    #[test]
    fn one_to_many_outgoing_scans_other_rows() {
        // supplier (viewed, FROM side) → shipments (other, holds supplierId)
        let supplier = tcore("sup", "supplier", "id", "ds-sup", Some("name"));
        let shipment = tcore("shp", "shipment", "id", "ds-shp", Some("productName"));
        let l = link("one-to-many", Some("supplierId"), Some("to"));
        let ship_rows = rows(json!([
            {"id": "S1", "supplierId": "SUP-1", "productName": "Widgets"},
            {"id": "S2", "supplierId": "SUP-1", "productName": "Bolts"},
            {"id": "S3", "supplierId": "SUP-2", "productName": "Gears"},
            {"id": "S4", "supplierId": "SUP-1", "productName": "Nuts"},
            {"id": "S5", "supplierId": "SUP-1", "productName": "Screws"},
            {"id": "S6", "supplierId": "SUP-1", "productName": "Nails"},
            {"id": "S7", "supplierId": "SUP-1", "productName": "Pins"}
        ]));
        let (targets, total) = resolve_link_targets(
            &l,
            &shipment,
            Direction::Outgoing,
            &json!("SUP-1"),
            &LinkRows {
                link_rows: None,
                link_schema: None,
                other_rows: Some(&ship_rows),
                viewed_row: None,
            },
        );
        // total counts ALL matches; targets sample capped at 5
        assert_eq!(total, 6);
        assert_eq!(targets.len(), 5);
        assert_eq!(targets[0].pk, json!("S1"));
        assert_eq!(targets[0].title, json!("Widgets"));
        // string/loose pk match on the viewed value
        let (t2, total2) = resolve_link_targets(
            &l,
            &shipment,
            Direction::Outgoing,
            &json!("SUP-2"),
            &LinkRows {
                link_rows: None,
                link_schema: None,
                other_rows: Some(&ship_rows),
                viewed_row: None,
            },
        );
        assert_eq!(total2, 1);
        assert_eq!(t2[0].pk, json!("S3"));

        // The same link seen from the SHIPMENT side is incoming: the viewed
        // row holds the FK (supplierId) → resolves the single supplier.
        let sup_rows = rows(json!([{"id": "SUP-1", "name": "Acme"}]));
        let viewed_ship =
            rows(json!([{"id": "S1", "supplierId": "SUP-1", "productName": "Widgets"}]));
        let (t3, total3) = resolve_link_targets(
            &l,
            &supplier,
            Direction::Incoming,
            &json!("S1"),
            &LinkRows {
                link_rows: None,
                link_schema: None,
                other_rows: Some(&sup_rows),
                viewed_row: viewed_ship.first(),
            },
        );
        assert_eq!(total3, 1);
        assert_eq!(t3[0].pk, json!("SUP-1"));
        assert_eq!(t3[0].title, json!("Acme"));
    }

    #[test]
    fn many_to_one_outgoing_uses_viewed_fk() {
        // order (viewed) → customer via order.customerId
        let customer = tcore(
            "cus",
            "customer",
            "customer_id",
            "ds-cus",
            Some("customer_name"),
        );
        let l = link("many-to-one", Some("customerId"), Some("from"));
        let viewed = rows(json!([{"order_id": "O1", "customerId": "C001"}]));
        let cust_rows = rows(json!([
            {"customer_id": "C001", "customer_name": "Amina Khan"},
            {"customer_id": "C002", "customer_name": "Hassan Ali"}
        ]));
        let (targets, total) = resolve_link_targets(
            &l,
            &customer,
            Direction::Outgoing,
            &json!("O1"),
            &LinkRows {
                link_rows: None,
                link_schema: None,
                other_rows: Some(&cust_rows),
                viewed_row: viewed.first(),
            },
        );
        assert_eq!(total, 1);
        assert_eq!(targets[0].pk, json!("C001"));
        assert_eq!(targets[0].title, json!("Amina Khan"));

        // empty/null fk → no targets
        let viewed_blank = rows(json!([{"order_id": "O2", "customerId": ""}]));
        let (t2, total2) = resolve_link_targets(
            &l,
            &customer,
            Direction::Outgoing,
            &json!("O2"),
            &LinkRows {
                link_rows: None,
                link_schema: None,
                other_rows: Some(&cust_rows),
                viewed_row: viewed_blank.first(),
            },
        );
        assert_eq!(total2, 0);
        assert!(t2.is_empty());
    }

    #[test]
    fn many_to_many_via_link_dataset() {
        let supplier = tcore("sup", "supplier", "id", "ds-sup", Some("name"));
        let product = tcore("prd", "product", "sku", "ds-prd", Some("label"));
        let mut l = link("many-to-many", None, None);
        l.link_dataset_id = Some("ds-map".into());
        let map_rows = rows(json!([
            {"supplier_id": "SUP-1", "product_sku": "P1"},
            {"supplier_id": "SUP-1", "product_sku": "P2"},
            {"supplier_id": "SUP-2", "product_sku": "P1"},
            {"supplier_id": "SUP-1", "product_sku": "P2"}
        ]));
        let schema = vec![
            SchemaColumn {
                name: "supplier_id".into(),
                column_type: mf_types::ColumnType::String,
            },
            SchemaColumn {
                name: "product_sku".into(),
                column_type: mf_types::ColumnType::String,
            },
        ];
        let prod_rows = rows(json!([
            {"sku": "P1", "label": "Widget"},
            {"sku": "P2", "label": "Bolt"}
        ]));
        // outgoing from supplier: distinct P1, P2 (duplicate suppressed)
        let (targets, total) = resolve_link_targets(
            &l,
            &product,
            Direction::Outgoing,
            &json!("SUP-1"),
            &LinkRows {
                link_rows: Some(&map_rows),
                link_schema: Some(&schema),
                other_rows: Some(&prod_rows),
                viewed_row: None,
            },
        );
        assert_eq!(total, 2);
        assert_eq!(targets.len(), 2);
        assert_eq!(targets[0].title, json!("Widget"));

        // incoming on product P1: suppliers SUP-1 + SUP-2
        let (t2, total2) = resolve_link_targets(
            &l,
            &supplier,
            Direction::Incoming,
            &json!("P1"),
            &LinkRows {
                link_rows: Some(&map_rows),
                link_schema: Some(&schema),
                other_rows: None,
                viewed_row: None,
            },
        );
        assert_eq!(total2, 2);
        assert!(t2.is_empty()); // other rows unavailable → empty sample

        // explicit key columns override schema order
        let mut l2 = l.clone();
        l2.from_key_column = Some("supplier_id".into());
        l2.to_key_column = Some("product_sku".into());
        let (_, total3) = resolve_link_targets(
            &l2,
            &product,
            Direction::Outgoing,
            &json!("SUP-2"),
            &LinkRows {
                link_rows: Some(&map_rows),
                link_schema: Some(&schema),
                other_rows: Some(&prod_rows),
                viewed_row: None,
            },
        );
        assert_eq!(total3, 1);

        // no link dataset → empty
        let l3 = link("many-to-many", None, None);
        let (t4, total4) = resolve_link_targets(
            &l3,
            &product,
            Direction::Outgoing,
            &json!("SUP-1"),
            &LinkRows {
                link_rows: Some(&map_rows),
                link_schema: Some(&schema),
                other_rows: Some(&prod_rows),
                viewed_row: None,
            },
        );
        assert_eq!(total4, 0);
        assert!(t4.is_empty());
    }

    #[test]
    fn fk_side_flip_uses_other_rows_scan_for_one_to_one() {
        // one-to-one with fkSide 'from': viewed row holds the FK
        let b = tcore("b", "b", "id", "ds-b", None);
        let l = link("one-to-one", Some("bId"), Some("from"));
        let viewed = rows(json!([{"id": "A1", "bId": "B9"}]));
        let b_rows = rows(json!([{"id": "B9"}]));
        let (targets, total) = resolve_link_targets(
            &l,
            &b,
            Direction::Outgoing,
            &json!("A1"),
            &LinkRows {
                link_rows: None,
                link_schema: None,
                other_rows: Some(&b_rows),
                viewed_row: viewed.first(),
            },
        );
        assert_eq!(total, 1);
        assert_eq!(targets[0].pk, json!("B9"));
    }

    #[test]
    fn link_entry_fk_property_visibility() {
        let other = tcore("shp", "shipment", "id", "ds-shp", None);
        // one-to-many, FK on the 'to' side. Viewed from the FROM type this is
        // OUTGOING and the OTHER side holds the FK → fkProperty is surfaced
        // for "view all" deep links.
        let l = link("one-to-many", Some("supplierId"), Some("to"));
        let e = to_link_entry(&l, other.clone(), Direction::Outgoing, vec![], 0);
        assert_eq!(e.fk_property.as_deref(), Some("supplierId"));
        // Viewed from the TO type (incoming) the VIEWED row holds the FK →
        // not surfaced.
        let e2 = to_link_entry(&l, other.clone(), Direction::Incoming, vec![], 3);
        assert_eq!(e2.fk_property, None);
        // many-to-many never surfaces fkProperty
        let mut m = link("many-to-many", Some("x"), None);
        m.link_dataset_id = Some("d".into());
        let e3 = to_link_entry(&m, other.clone(), Direction::Outgoing, vec![], 0);
        assert_eq!(e3.fk_property, None);
    }

    #[test]
    fn link_entry_json_shape() {
        let other = tcore("cus", "customer", "customer_id", "ds", Some("name"));
        let l = link("many-to-one", Some("customerId"), Some("from"));
        let e = to_link_entry(
            &l,
            other,
            Direction::Outgoing,
            vec![LinkTarget {
                pk: json!("C1"),
                title: json!("Amina"),
            }],
            1,
        );
        let v = e.to_json();
        let keys: Vec<&String> = v.as_object().unwrap().keys().collect();
        assert_eq!(
            keys,
            vec![
                "id",
                "apiName",
                "displayName",
                "direction",
                "cardinality",
                "toTypeId",
                "toTypeApiName",
                "toTypeDisplayName",
                "toTypeIcon",
                "toTypeColor",
                "total",
                "fkProperty",
                "targets"
            ]
        );
        assert_eq!(v["direction"], "outgoing");
        assert_eq!(v["toTypeIcon"], "box");
        assert_eq!(v["targets"][0]["_title"], "Amina");
    }

    #[test]
    fn fetch_rows_caps_at_max() {
        let t = tcore("x", "x", "id", "ds", None);
        let many: Vec<Row> = (0..60)
            .map(|i| {
                let mut m = Row::new();
                m.insert("id".into(), json!(1));
                m.insert("n".into(), json!(i));
                m
            })
            .collect();
        let found = fetch_rows_by_pk_values(&t, &[json!(1)], &many);
        assert_eq!(found.len(), MAX_LINK_TARGETS);
        // numeric pk matches string wanted value (String() equality)
        let found2 = fetch_rows_by_pk_values(&t, &[json!("1")], &many);
        assert_eq!(found2.len(), MAX_LINK_TARGETS);
    }
}
