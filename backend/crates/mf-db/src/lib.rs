//! MiniFoundry — Postgres access helpers shared by every service.
//!
//! Topology: ONE Postgres instance, one schema per service (`auth`, `catalog`,
//! `orchestration`, `compute`, `ontology`, `governance`). Each service connects
//! with its own role that only has grants on its own schema (enforced by
//! `deploy/postgres/init.sql`), and its `search_path` pinned to that schema so
//! plain table names never cross domain boundaries.
//!
//! Migrations live in each service crate (`services/<name>/migrations/`) and
//! are applied idempotently at startup with [`run_migrations`].

use chrono::{DateTime, Utc};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::PgPool;
use std::str::FromStr;

/// Build a pool for `database_url` with `search_path` pinned to `schema`.
///
/// `database_url` may already carry `options=-csearch_path%3D...`; when it
/// does not, the schema is applied here. Connection errors fail fast at boot.
pub async fn connect(
    database_url: &str,
    schema: &str,
    max_connections: u32,
) -> anyhow::Result<PgPool> {
    let mut opts = PgConnectOptions::from_str(database_url)
        .map_err(|e| anyhow::anyhow!("invalid DATABASE_URL: {e}"))?;
    let existing_options = opts.get_options().unwrap_or("").to_string();
    if !existing_options.contains("search_path") {
        opts = opts.options([("search_path", schema)]);
    }
    let pool = PgPoolOptions::new()
        .max_connections(max_connections)
        .acquire_timeout(std::time::Duration::from_secs(10))
        .connect_with(opts)
        .await
        .map_err(|e| anyhow::anyhow!("cannot connect to Postgres (schema {schema}): {e}"))?;
    tracing::info!(schema, "postgres pool established");
    Ok(pool)
}

/// Connect using `DATABASE_URL` from the environment (panics when unset —
/// every service requires it at boot).
pub async fn connect_from_env(schema: &str) -> anyhow::Result<PgPool> {
    let url = std::env::var("DATABASE_URL")
        .map_err(|_| anyhow::anyhow!("DATABASE_URL must be set (schema {schema})"))?;
    let max: u32 = std::env::var("DATABASE_MAX_CONNECTIONS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(10);
    connect(&url, schema, max).await
}

/// Apply a service's embedded migrations (`sqlx::migrate!()` from the service
/// crate) idempotently. Safe under concurrent replicas: sqlx takes the
/// advisory migration lock.
pub async fn run_migrations(
    pool: &PgPool,
    migrator: &sqlx::migrate::Migrator,
) -> anyhow::Result<()> {
    migrator
        .run(pool)
        .await
        .map_err(|e| anyhow::anyhow!("migrations failed: {e}"))?;
    Ok(())
}

/// New opaque entity id (replaces Prisma cuid()). UUID v7 keeps ids
/// time-ordered (index-friendly) while remaining opaque to clients.
pub fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

/// Current time in UTC (single clock helper for consistent timestamps).
pub fn now() -> DateTime<Utc> {
    Utc::now()
}

/// JSONB helper: read a `serde_json::Value` column that may be NULL.
pub fn json_or(default: Value, v: Option<sqlx::types::Json<Value>>) -> Value {
    v.map(|j| j.0).unwrap_or(default)
}

use serde_json::Value;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_uuid_v7_strings() {
        let a = new_id();
        let b = new_id();
        assert_eq!(a.len(), 36);
        assert_ne!(a, b);
        // UUID v7: version nibble is 7
        assert_eq!(a.chars().nth(14), Some('7'));
    }

    #[test]
    fn search_path_is_applied() {
        let opts = PgConnectOptions::from_str("postgres://u:p@localhost/db")
            .unwrap()
            .options([("search_path", "catalog")]);
        assert!(opts.get_options().unwrap_or("").contains("search_path"));
        assert!(opts.get_options().unwrap_or("").contains("catalog"));
    }
}
