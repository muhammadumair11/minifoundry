//! Shared dataset service — port of src/lib/dataset-service.ts:
//! createDatasetFromRows, indexed row storage, consumer-version resolution,
//! retention pruning and the shared lineage-edge writers.

use mf_types::{Row, SchemaColumn};
use sqlx::PgPool;

use crate::rows::{data_json_string, infer_schema, normalize_rows, write_version_rows};
use crate::state::{DatasetRow, VersionRow, DATASET_COLS, VERSION_COLS};

pub struct CreateDatasetOptions<'a> {
    pub name: &'a str,
    /// Description for a NEW dataset (appends never touch it, like legacy).
    pub description: Option<&'a str>,
    pub connector_id: Option<&'a str>,
    pub project_id: Option<&'a str>,
    pub tags: Vec<String>,
    /// ingestion id | pipeline run id | "seed" | ...
    pub created_by: Option<&'a str>,
    pub output_job_id: Option<&'a str>,
    pub rows: Vec<Row>,
}

#[allow(dead_code)] // fidelity fields (legacy result shape)
pub struct CreateDatasetResult {
    pub dataset: DatasetRow,
    pub version: VersionRow,
    pub schema: Vec<SchemaColumn>,
    pub row_count: usize,
    /// Always false — oversized versions fail explicitly (legacy behavior).
    pub truncated: bool,
}

/// Port of `createDatasetFromRows`:
/// - no dataset with the exact name → create one (+ version 1, published);
/// - existing → append the next version (MAX+1 over ALL branches) and touch
///   updatedAt; gated datasets land the new version as a DRAFT.
///
/// Err carries the exact legacy message (routes map it to 400/500 per legacy).
pub async fn create_dataset_from_rows(
    pool: &PgPool,
    max_rows: usize,
    opts: CreateDatasetOptions<'_>,
) -> Result<CreateDatasetResult, String> {
    if opts.rows.len() > max_rows {
        return Err(format!(
            "Dataset version has {} rows; the current storage limit is {max_rows}. No rows were written.",
            opts.rows.len()
        ));
    }
    let normalized = normalize_rows(&opts.rows);
    let schema = infer_schema(&normalized);
    let data_json = data_json_string(&normalized);

    let existing: Option<DatasetRow> = sqlx::query_as(&format!(
        "SELECT {DATASET_COLS} FROM datasets WHERE name = $1 LIMIT 1"
    ))
    .bind(opts.name)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;

    if let Some(existing) = existing {
        let next_version_number = head_version_number(pool, &existing.id)
            .await
            .map_err(|e| e.to_string())?
            + 1;
        let lifecycle = if existing.quality_gate {
            "draft"
        } else {
            "published"
        };
        let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
        let version: VersionRow = sqlx::query_as(&format!(
            "INSERT INTO dataset_versions (id, dataset_id, version_number, schema_json, row_count, \
              data_json, created_by, output_job_id, lifecycle) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING {VERSION_COLS}"
        ))
        .bind(mf_db::new_id())
        .bind(&existing.id)
        .bind(next_version_number)
        .bind(sqlx::types::Json(&schema))
        .bind(normalized.len() as i32)
        .bind(&data_json)
        .bind(opts.created_by)
        .bind(opts.output_job_id)
        .bind(lifecycle)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        let dataset: DatasetRow = sqlx::query_as(&format!(
            "UPDATE datasets SET updated_at = now(), \
              source_connector_id = COALESCE($2, source_connector_id), \
              published_version = CASE WHEN $3 THEN published_version ELSE $4 END \
             WHERE id = $1 RETURNING {DATASET_COLS}"
        ))
        .bind(&existing.id)
        .bind(
            if opts.connector_id.map(|s| !s.is_empty()).unwrap_or(false) {
                opts.connector_id
            } else {
                None
            },
        )
        .bind(existing.quality_gate)
        .bind(next_version_number)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        tx.commit().await.map_err(|e| e.to_string())?;
        // Indexed row storage for paged reads, then retention.
        write_version_rows(pool, &existing.id, next_version_number, &normalized)
            .await
            .map_err(|e| e.to_string())?;
        prune_dataset_versions(pool, &existing.id, existing.keep_last_n)
            .await
            .map_err(|e| e.to_string())?;
        return Ok(CreateDatasetResult {
            dataset,
            version,
            schema,
            row_count: normalized.len(),
            truncated: false,
        });
    }

    // Brand-new dataset: version 1, always published (gate defaults off).
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    let dataset: DatasetRow = sqlx::query_as(&format!(
        "INSERT INTO datasets (id, name, description, project_id, source_connector_id, tags, published_version) \
         VALUES ($1, $2, $3, $4, $5, $6, 1) RETURNING {DATASET_COLS}"
    ))
    .bind(mf_db::new_id())
    .bind(opts.name)
    .bind(opts.description)
    .bind(opts.project_id)
    .bind(opts.connector_id)
    .bind(sqlx::types::Json(&opts.tags))
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;
    let version: VersionRow = sqlx::query_as(&format!(
        "INSERT INTO dataset_versions (id, dataset_id, version_number, schema_json, row_count, \
          data_json, created_by, output_job_id, lifecycle) \
         VALUES ($1, $2, 1, $3, $4, $5, $6, $7, 'published') RETURNING {VERSION_COLS}"
    ))
    .bind(mf_db::new_id())
    .bind(&dataset.id)
    .bind(sqlx::types::Json(&schema))
    .bind(normalized.len() as i32)
    .bind(&data_json)
    .bind(opts.created_by)
    .bind(opts.output_job_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;
    write_version_rows(pool, &dataset.id, 1, &normalized)
        .await
        .map_err(|e| e.to_string())?;
    Ok(CreateDatasetResult {
        dataset,
        version,
        schema,
        row_count: normalized.len(),
        truncated: false,
    })
}

/// Latest versionNumber for a dataset across ALL branches (0 when empty) —
/// port of `getHeadVersionNumber`.
pub async fn head_version_number(pool: &PgPool, dataset_id: &str) -> Result<i32, sqlx::Error> {
    let n: Option<i32> = sqlx::query_scalar(
        "SELECT max(version_number) FROM dataset_versions WHERE dataset_id = $1",
    )
    .bind(dataset_id)
    .fetch_one(pool)
    .await?;
    Ok(n.unwrap_or(0))
}

/// Main-branch head version number (None when the dataset has no main versions).
pub async fn main_head_version_number(
    pool: &PgPool,
    dataset_id: &str,
) -> Result<Option<i32>, sqlx::Error> {
    let n: Option<i32> = sqlx::query_scalar(
        "SELECT max(version_number) FROM dataset_versions WHERE dataset_id = $1 AND branch = 'main'",
    )
    .bind(dataset_id)
    .fetch_one(pool)
    .await?;
    Ok(n)
}

/// Port of `resolveConsumerVersion` (P2 trust workflow):
/// gate ON → publishedVersion (may be null); gate OFF → main head.
#[allow(dead_code)] // fidelity fields (legacy ConsumerVersion shape)
pub struct ConsumerVersion {
    pub version_number: Option<i32>,
    pub gated: bool,
    pub published_version: Option<i32>,
}

pub async fn resolve_consumer_version(
    pool: &PgPool,
    dataset_id: &str,
) -> Result<Option<ConsumerVersion>, sqlx::Error> {
    let dataset: Option<(bool, Option<i32>)> =
        sqlx::query_as("SELECT quality_gate, published_version FROM datasets WHERE id = $1")
            .bind(dataset_id)
            .fetch_optional(pool)
            .await?;
    let Some((gated, published_version)) = dataset else {
        return Ok(None);
    };
    let head = main_head_version_number(pool, dataset_id).await?;
    let version_number = match head {
        None => None,
        Some(h) => {
            if gated {
                published_version
            } else {
                Some(h)
            }
        }
    };
    Ok(Some(ConsumerVersion {
        version_number,
        gated,
        published_version,
    }))
}

/// Port of `getDatasetVersion`: a specific version, or the main-branch head.
pub async fn get_dataset_version(
    pool: &PgPool,
    dataset_id: &str,
    version_number: Option<i32>,
) -> Result<Option<VersionRow>, sqlx::Error> {
    if let Some(n) = version_number {
        sqlx::query_as(&format!(
            "SELECT {VERSION_COLS} FROM dataset_versions WHERE dataset_id = $1 AND version_number = $2"
        ))
        .bind(dataset_id)
        .bind(n)
        .fetch_optional(pool)
        .await
    } else {
        sqlx::query_as(&format!(
            "SELECT {VERSION_COLS} FROM dataset_versions WHERE dataset_id = $1 AND branch = 'main' \
             ORDER BY version_number DESC LIMIT 1"
        ))
        .bind(dataset_id)
        .fetch_optional(pool)
        .await
    }
}

/// Port of `pruneDatasetVersions` (M2 retention + R14 branch safety):
/// keepLastN <= 0 → unlimited; only main versions are candidates; the 2 newest
/// main versions always stay; publishedVersion and branch head/base pointers
/// are protected. Returns the number of deleted versions.
///
/// Microservice deviation: the legacy also protected versions pinned by
/// PENDING governance approvals and by queued/running orchestration jobs —
/// those tables live in other services now and are not queryable from here.
/// Both protections almost always overlap the always-kept newest 2 versions.
pub async fn prune_dataset_versions(
    pool: &PgPool,
    dataset_id: &str,
    keep_last_n: i32,
) -> Result<i64, sqlx::Error> {
    if keep_last_n <= 0 {
        return Ok(0);
    }
    let versions: Vec<(String, i32, Option<String>)> = sqlx::query_as(
        "SELECT id, version_number, output_job_id FROM dataset_versions \
         WHERE dataset_id = $1 AND branch = 'main' ORDER BY version_number DESC",
    )
    .bind(dataset_id)
    .fetch_all(pool)
    .await?;
    let keep_count = keep_last_n.max(2) as usize;
    if versions.len() <= keep_count {
        return Ok(0);
    }
    let mut protected: std::collections::HashSet<i32> = std::collections::HashSet::new();
    let published: Option<Option<i32>> =
        sqlx::query_scalar("SELECT published_version FROM datasets WHERE id = $1")
            .bind(dataset_id)
            .fetch_optional(pool)
            .await?;
    if let Some(Some(p)) = published {
        protected.insert(p);
    }
    let branch_refs: Vec<(i32, i32)> = sqlx::query_as(
        "SELECT head_version, base_version FROM dataset_branches WHERE dataset_id = $1",
    )
    .bind(dataset_id)
    .fetch_all(pool)
    .await?;
    for (head, base) in branch_refs {
        protected.insert(head);
        protected.insert(base);
    }
    let excess: Vec<String> = versions[keep_count..]
        .iter()
        .filter(|(_, n, _)| !protected.contains(n))
        .map(|(id, _, _)| id.clone())
        .collect();
    if excess.is_empty() {
        return Ok(0);
    }
    // Improvement over legacy: also drop the pruned versions' indexed rows
    // (legacy orphaned them; no contract-visible difference).
    let numbers: Vec<i32> = versions[keep_count..]
        .iter()
        .filter(|(_, n, _)| !protected.contains(n))
        .map(|(_, n, _)| *n)
        .collect();
    sqlx::query(
        "DELETE FROM dataset_version_rows WHERE dataset_id = $1 AND version_number = ANY($2)",
    )
    .bind(dataset_id)
    .bind(&numbers)
    .execute(pool)
    .await?;
    let result = sqlx::query("DELETE FROM dataset_versions WHERE id = ANY($1)")
        .bind(&excess)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() as i64)
}

// ─── Lineage edge writers (shared by the version door) ──────────────────

/// Dataset-level lineage edge, deduplicated like the legacy:
/// - pipelineId set → unique-index upsert (ON CONFLICT DO NOTHING);
/// - pipelineId null → manual existence check (NULLs are distinct in the
///   unique index, matching SQLite legacy semantics).
pub async fn ensure_lineage_edge(
    pool: &PgPool,
    from_dataset_id: &str,
    to_dataset_id: &str,
    pipeline_id: Option<&str>,
) -> Result<(), sqlx::Error> {
    match pipeline_id {
        Some(pid) => {
            sqlx::query(
                "INSERT INTO lineage_edges (id, from_dataset_id, to_dataset_id, pipeline_id) \
                 VALUES ($1, $2, $3, $4) \
                 ON CONFLICT (from_dataset_id, to_dataset_id, pipeline_id) DO NOTHING",
            )
            .bind(mf_db::new_id())
            .bind(from_dataset_id)
            .bind(to_dataset_id)
            .bind(pid)
            .execute(pool)
            .await?;
        }
        None => {
            sqlx::query(
                "INSERT INTO lineage_edges (id, from_dataset_id, to_dataset_id, pipeline_id) \
                 SELECT $1, $2, $3, NULL WHERE NOT EXISTS ( \
                   SELECT 1 FROM lineage_edges \
                   WHERE from_dataset_id = $2 AND to_dataset_id = $3 AND pipeline_id IS NULL)",
            )
            .bind(mf_db::new_id())
            .bind(from_dataset_id)
            .bind(to_dataset_id)
            .execute(pool)
            .await?;
        }
    }
    Ok(())
}

pub struct VersionLineageInput {
    pub run_id: Option<String>,
    pub pipeline_id: Option<String>,
    pub transform_run_id: Option<String>,
    pub transform_id: Option<String>,
    pub from_dataset_id: String,
    pub from_version_number: i32,
    pub to_dataset_id: String,
    pub to_version_number: i32,
}

/// Version-level lineage inserts (additive telemetry — never fails the caller).
pub async fn write_version_lineage_edges(pool: &PgPool, edges: &[VersionLineageInput]) {
    for e in edges {
        let result = sqlx::query(
            "INSERT INTO version_lineage_edges (id, run_id, pipeline_id, transform_run_id, \
              transform_id, from_dataset_id, from_version_number, to_dataset_id, to_version_number) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        )
        .bind(mf_db::new_id())
        .bind(&e.run_id)
        .bind(&e.pipeline_id)
        .bind(&e.transform_run_id)
        .bind(&e.transform_id)
        .bind(&e.from_dataset_id)
        .bind(e.from_version_number)
        .bind(&e.to_dataset_id)
        .bind(e.to_version_number)
        .execute(pool)
        .await;
        if let Err(err) = result {
            tracing::warn!(error = %err, "version lineage edge insert failed (swallowed)");
        }
    }
}
