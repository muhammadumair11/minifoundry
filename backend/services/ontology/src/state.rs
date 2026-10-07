//! Shared service state + DB row models (schema `ontology`).

use chrono::{DateTime, Utc};
use mf_auth::RuntimeMode;
use sqlx::types::Json;
use sqlx::PgPool;
use std::sync::Arc;

use mf_types::Value;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub nats: async_nats::Client,
    pub mode: Arc<RuntimeMode>,
    /// Catalog service client (dataset rows/schemas/versions; masking via the
    /// `role` query param — see contracts/INTERNAL_API.md).
    pub catalog: crate::catalog::CatalogClient,
    /// Governance service client (column markings for `_masked` lists).
    pub governance: crate::catalog::GovernanceClient,
}

// ─── DB rows ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ObjectTypeRow {
    pub id: String,
    pub api_name: String,
    pub display_name: String,
    pub description: Option<String>,
    pub source_dataset_id: Option<String>,
    pub primary_key: Option<String>,
    pub icon: String,
    pub color: String,
    pub created_at: DateTime<Utc>,
    #[allow(dead_code)]
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct PropertyRow {
    #[allow(dead_code)]
    pub id: String,
    pub object_type_id: String,
    pub api_name: String,
    pub display_name: String,
    pub data_type: String,
    pub is_title: bool,
    pub hide_in_table: bool,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct LinkTypeRow {
    pub id: String,
    pub api_name: String,
    pub display_name: String,
    pub from_type_id: String,
    pub to_type_id: String,
    pub cardinality: String,
    pub fk_property: Option<String>,
    pub fk_side: Option<String>,
    pub link_dataset_id: Option<String>,
    pub from_key_column: Option<String>,
    pub to_key_column: Option<String>,
    #[allow(dead_code)]
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ActionTypeRow {
    pub id: String,
    pub api_name: String,
    pub display_name: String,
    pub description: Option<String>,
    pub object_type_id: String,
    pub operation: String,
    pub parameters_json: Json<Value>,
    pub enabled: bool,
    pub target_dataset_id: Option<String>,
    pub write_mode: Option<String>,
    pub key_property: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Model of the action_logs table (writes/reads go through inline queries in
/// actions.rs / routes::actions; kept for schema documentation parity).
#[allow(dead_code)]
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ActionLogRow {
    pub id: String,
    pub action_type_id: String,
    pub params_json: Json<Value>,
    pub result: String,
    pub message: Option<String>,
    pub object_pk: Option<String>,
    pub version_number: Option<i32>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ObjectViewRow {
    pub id: String,
    pub object_type_id: String,
    pub name: String,
    pub filters_json: Json<Value>,
    pub sort_by: Option<String>,
    pub sort_dir: String,
    pub created_by: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct DashboardRow {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub layout_json: Json<Value>,
    pub created_by: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ApplicationRow {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub config_json: Json<Value>,
    pub created_by: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

// ─── Column lists (shared by queries) ─────────────────────────────────────

pub const OBJECT_TYPE_COLS: &str = "id, api_name, display_name, description, source_dataset_id, \
     primary_key, icon, color, created_at, updated_at";
pub const PROPERTY_COLS: &str =
    "id, object_type_id, api_name, display_name, data_type, is_title, hide_in_table";
pub const LINK_COLS: &str = "id, api_name, display_name, from_type_id, to_type_id, cardinality, \
     fk_property, fk_side, link_dataset_id, from_key_column, to_key_column, created_at";
pub const ACTION_COLS: &str = "id, api_name, display_name, description, object_type_id, operation, \
     parameters_json, enabled, target_dataset_id, write_mode, key_property, created_at, updated_at";
#[allow(dead_code)]
pub const ACTION_LOG_COLS: &str =
    "id, action_type_id, params_json, result, message, object_pk, version_number, created_at";
pub const VIEW_COLS: &str =
    "id, object_type_id, name, filters_json, sort_by, sort_dir, created_by, created_at";
pub const DASHBOARD_COLS: &str =
    "id, title, description, layout_json, created_by, created_at, updated_at";
pub const APPLICATION_COLS: &str =
    "id, name, description, config_json, created_by, created_at, updated_at";
