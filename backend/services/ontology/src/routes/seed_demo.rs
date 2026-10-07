//! POST /api/ontology/seed-demo — idempotent demo ontology seeder (port of
//! ontology/seed-demo/route.ts). Creates the Shipment / Supplier / Warehouse
//! object types backed by the seeded datasets, two one-to-many links and
//! three write-back actions. Re-runs are silent no-ops per entity.

use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::Response;
use mf_types::Value;
use mf_web::{actor_from_headers, json_ok, require_role, ApiError, ApiResult};

use crate::audit::{self, AuditOptions};
use crate::serialize::derive_properties;
use crate::state::*;

struct DemoType {
    api_name: &'static str,
    display_name: &'static str,
    dataset_name: &'static str,
    primary_key: &'static str,
    title_property: &'static str,
    icon: &'static str,
    color: &'static str,
    description: &'static str,
}

const DEMO_TYPES: [DemoType; 3] = [
    DemoType {
        api_name: "shipment",
        display_name: "Shipment",
        dataset_name: "Shipments",
        primary_key: "id",
        title_property: "productName",
        icon: "truck",
        color: "emerald",
        description: "Outbound shipment instances flowing from suppliers through warehouses.",
    },
    DemoType {
        api_name: "supplier",
        display_name: "Supplier",
        dataset_name: "Suppliers",
        primary_key: "id",
        title_property: "name",
        icon: "factory",
        color: "teal",
        description: "Supplier master records with ratings, lead times and on-time delivery.",
    },
    DemoType {
        api_name: "warehouse",
        display_name: "Warehouse",
        dataset_name: "Warehouses",
        primary_key: "id",
        title_property: "name",
        icon: "warehouse",
        color: "amber",
        description: "Fulfilment warehouses and their storage capacity.",
    },
];

struct DemoLink {
    api_name: &'static str,
    display_name: &'static str,
    from_api_name: &'static str,
    to_api_name: &'static str,
    cardinality: &'static str,
    fk_property: &'static str,
}

const DEMO_LINKS: [DemoLink; 2] = [
    DemoLink {
        api_name: "shipments",
        display_name: "Shipments",
        from_api_name: "supplier",
        to_api_name: "shipment",
        cardinality: "one-to-many",
        fk_property: "supplierId",
    },
    DemoLink {
        api_name: "shipments",
        display_name: "Shipments",
        from_api_name: "warehouse",
        to_api_name: "shipment",
        cardinality: "one-to-many",
        fk_property: "warehouseId",
    },
];

/// The three demo action parameter definitions (exact legacy literals —
/// key order preserved; stored verbatim as parametersJson).
fn demo_action_parameters(api_name: &str) -> Value {
    match api_name {
        "update-shipment-status" => serde_json::json!([
            { "apiName": "shipmentId", "displayName": "Shipment Id", "dataType": "string", "required": true, "mapsTo": "id", "isPk": true },
            {
                "apiName": "newStatus",
                "displayName": "New Status",
                "dataType": "string",
                "required": true,
                "mapsTo": "status",
                "oneOf": ["in_transit", "delivered", "delayed", "customs"],
            },
        ]),
        "register-supplier" => serde_json::json!([
            { "apiName": "name", "displayName": "Name", "dataType": "string", "required": true, "mapsTo": "name" },
            { "apiName": "country", "displayName": "Country", "dataType": "string", "required": true, "mapsTo": "country" },
            { "apiName": "region", "displayName": "Region", "dataType": "string", "required": true, "mapsTo": "region" },
            { "apiName": "rating", "displayName": "Rating", "dataType": "number", "required": false, "mapsTo": "rating" },
            { "apiName": "leadTimeDays", "displayName": "Lead Time Days", "dataType": "number", "required": false, "mapsTo": "leadTimeDays" },
            { "apiName": "onTimePct", "displayName": "On Time Pct", "dataType": "number", "required": false, "mapsTo": "onTimePct" },
        ]),
        _ => serde_json::json!([
            { "apiName": "shipmentId", "displayName": "Shipment Id", "dataType": "string", "required": true, "mapsTo": "id", "isPk": true },
        ]),
    }
}

struct DemoAction {
    api_name: &'static str,
    display_name: &'static str,
    description: &'static str,
    object_api_name: &'static str,
    operation: &'static str,
}

const DEMO_ACTIONS: [DemoAction; 3] = [
    DemoAction {
        api_name: "update-shipment-status",
        display_name: "Update Shipment Status",
        // NOTE: legacy uses a typographic apostrophe (U+2019) here.
        description:
            "Set a shipment\u{2019}s live status (in_transit, delivered, delayed, customs).",
        object_api_name: "shipment",
        operation: "update",
    },
    DemoAction {
        api_name: "register-supplier",
        display_name: "Register Supplier",
        description: "Append a new supplier row to the Suppliers dataset (id is generated).",
        object_api_name: "supplier",
        operation: "create",
    },
    DemoAction {
        api_name: "remove-shipment",
        display_name: "Remove Shipment",
        description: "Delete a shipment row from the Shipments dataset.",
        object_api_name: "shipment",
        operation: "delete",
    },
];

pub async fn seed_demo(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;

    // ── resolve backing datasets (demo data must exist) ─────────────────
    let mut datasets_by_name: std::collections::HashMap<String, (String, String)> =
        std::collections::HashMap::new();
    for t in DEMO_TYPES.iter() {
        if datasets_by_name.contains_key(t.dataset_name) {
            continue;
        }
        let Some(dataset) = state.catalog.dataset_by_name(t.dataset_name).await? else {
            return Err(ApiError::bad_request(format!(
                "Backing dataset '{}' not found — seed demo data first (POST /api/seed)",
                t.dataset_name
            )));
        };
        datasets_by_name.insert(t.dataset_name.to_string(), (dataset.id, dataset.name));
    }

    let mut created: Vec<String> = Vec::new();

    // ── object types (+ derived properties) ─────────────────────────────
    for def in DEMO_TYPES.iter() {
        let existing: Option<(String,)> =
            sqlx::query_as("SELECT id FROM object_types WHERE api_name = $1")
                .bind(def.api_name)
                .fetch_optional(&state.db)
                .await?;
        if existing.is_some() {
            continue;
        }
        let (dataset_id, dataset_name) = datasets_by_name
            .get(def.dataset_name)
            .cloned()
            .ok_or_else(|| ApiError::internal("demo dataset map lost an entry"))?;
        let Some(version) = state.catalog.head_version(&dataset_id).await? else {
            return Err(ApiError::bad_request(format!(
                "Dataset '{dataset_name}' has no versions to derive properties from"
            )));
        };
        let schema = version.schema;
        if !schema.iter().any(|c| c.name == def.primary_key) {
            return Err(ApiError::bad_request(format!(
                "Primary key '{}' not found in dataset '{dataset_name}' schema",
                def.primary_key
            )));
        }
        if !schema.iter().any(|c| c.name == def.title_property) {
            return Err(ApiError::bad_request(format!(
                "titleProperty '{}' not found in dataset '{dataset_name}' schema",
                def.title_property
            )));
        }

        let id = mf_db::new_id();
        let mut tx = state.db.begin().await?;
        sqlx::query(
            "INSERT INTO object_types (id, api_name, display_name, description, \
             source_dataset_id, primary_key, icon, color) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        )
        .bind(&id)
        .bind(def.api_name)
        .bind(def.display_name)
        .bind(def.description)
        .bind(&dataset_id)
        .bind(def.primary_key)
        .bind(def.icon)
        .bind(def.color)
        .execute(&mut *tx)
        .await?;
        for p in derive_properties(&schema, def.primary_key, Some(def.title_property)) {
            sqlx::query(
                "INSERT INTO properties (id, object_type_id, api_name, display_name, \
                 data_type, is_title, hide_in_table) VALUES ($1, $2, $3, $4, $5, $6, $7)",
            )
            .bind(mf_db::new_id())
            .bind(&id)
            .bind(&p.api_name)
            .bind(&p.display_name)
            .bind(&p.data_type)
            .bind(p.is_title)
            .bind(p.hide_in_table)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        created.push(def.api_name.to_string());
    }

    // resolve type ids (all ensured above)
    let mut type_ids: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for def in DEMO_TYPES.iter() {
        let t: Option<(String,)> =
            sqlx::query_as("SELECT id FROM object_types WHERE api_name = $1")
                .bind(def.api_name)
                .fetch_optional(&state.db)
                .await?;
        if let Some((id,)) = t {
            type_ids.insert(def.api_name.to_string(), id);
        }
    }

    // ── link types ──────────────────────────────────────────────────────
    for link in DEMO_LINKS.iter() {
        let (Some(from_type_id), Some(to_type_id)) = (
            type_ids.get(link.from_api_name),
            type_ids.get(link.to_api_name),
        ) else {
            continue;
        };
        let existing: Option<(String,)> =
            sqlx::query_as("SELECT id FROM link_types WHERE from_type_id = $1 AND api_name = $2")
                .bind(from_type_id)
                .bind(link.api_name)
                .fetch_optional(&state.db)
                .await?;
        if existing.is_some() {
            continue;
        }
        sqlx::query(
            "INSERT INTO link_types (id, api_name, display_name, from_type_id, to_type_id, \
             cardinality, fk_property) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(mf_db::new_id())
        .bind(link.api_name)
        .bind(link.display_name)
        .bind(from_type_id)
        .bind(to_type_id)
        .bind(link.cardinality)
        .bind(link.fk_property)
        .execute(&state.db)
        .await?;
    }

    // ── action types ────────────────────────────────────────────────────
    for action in DEMO_ACTIONS.iter() {
        let existing: Option<(String,)> =
            sqlx::query_as("SELECT id FROM action_types WHERE api_name = $1")
                .bind(action.api_name)
                .fetch_optional(&state.db)
                .await?;
        if existing.is_some() {
            continue;
        }
        let Some(object_type_id) = type_ids.get(action.object_api_name) else {
            continue;
        };
        sqlx::query(
            "INSERT INTO action_types (id, api_name, display_name, description, object_type_id, \
             operation, parameters_json, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)",
        )
        .bind(mf_db::new_id())
        .bind(action.api_name)
        .bind(action.display_name)
        .bind(action.description)
        .bind(object_type_id)
        .bind(action.operation)
        .bind(sqlx::types::Json(demo_action_parameters(action.api_name)))
        .execute(&state.db)
        .await?;
    }

    // Governance audit — only when something was actually created.
    if !created.is_empty() {
        audit::audit(
            &state,
            &actor,
            AuditOptions::new("ontology.create", "ontology")
                .resource_name(Some("demo ontology"))
                .detail(Some(&format!(
                    "seeded object types: {}",
                    created.join(", ")
                ))),
        )
        .await;
    }

    Ok(json_ok(serde_json::json!({
        "seeded": !created.is_empty(),
        "created": created,
    })))
}
