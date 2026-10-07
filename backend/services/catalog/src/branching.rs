//! R14 dataset branching & merge — port of src/lib/branching.ts.
//!
//! Version numbers are GLOBAL per dataset (unique across branches):
//! next = max(versionNumber over ALL versions) + 1. "main" head = highest
//! main-branch versionNumber; a feature branch head = branch.head_version.
//! Merges COPY the branch head's data as a NEW main version — branch versions
//! are never rewritten (immutability).

use chrono::Utc;
use mf_web::ApiError;
use sqlx::PgPool;

use crate::dataset_service::{head_version_number, main_head_version_number, prune_dataset_versions};
use crate::rows::{data_json_string, infer_schema, normalize_rows, rows_from_data_json, write_version_rows};
use crate::state::{AppState, BranchRow, VersionRow, BRANCH_COLS, VERSION_COLS};

/// Typed error so routes map to the right HTTP status (legacy BranchError).
pub struct BranchError {
    pub status: u16,
    pub message: String,
}

impl BranchError {
    pub fn new(message: impl Into<String>, status: u16) -> Self {
        Self { message: message.into(), status }
    }
    pub fn into_api_error(self) -> ApiError {
        let status = match self.status {
            404 => axum::http::StatusCode::NOT_FOUND,
            409 => axum::http::StatusCode::CONFLICT,
            _ => axum::http::StatusCode::BAD_REQUEST,
        };
        ApiError::new(status, self.message)
    }
}

/// List all branches of a dataset + the current main head version number.
pub async fn list_branches(pool: &PgPool, dataset_id: &str) -> Result<serde_json::Value, sqlx::Error> {
    let branches: Vec<BranchRow> =
        sqlx::query_as(&format!("SELECT {BRANCH_COLS} FROM dataset_branches WHERE dataset_id = $1 ORDER BY created_at ASC, id ASC"))
            .bind(dataset_id)
            .fetch_all(pool)
            .await?;
    let main_head = main_head_version_number(pool, dataset_id).await?.unwrap_or(0);
    Ok(serde_json::json!({
        "branches": branches.iter().map(crate::state::serialize_branch).collect::<Vec<_>>(),
        "mainHead": main_head,
    }))
}

/// Resolve a branch name to its head version number ('main' → main head).
pub async fn resolve_branch_head(
    pool: &PgPool,
    dataset_id: &str,
    branch_name: &str,
) -> Result<Option<i32>, sqlx::Error> {
    if branch_name == "main" {
        return main_head_version_number(pool, dataset_id).await;
    }
    let head: Option<i32> = sqlx::query_scalar(
        "SELECT head_version FROM dataset_branches WHERE dataset_id = $1 AND name = $2",
    )
    .bind(dataset_id)
    .bind(branch_name)
    .fetch_optional(pool)
    .await?;
    Ok(head)
}

pub struct CreateBranchInput<'a> {
    pub name: &'a str,
    pub description: Option<&'a str>,
    pub base_version: Option<i64>,
}

/// Create a branch pointing at a main version (defaults to the main head).
pub async fn create_branch(
    pool: &PgPool,
    dataset_id: &str,
    input: CreateBranchInput<'_>,
    created_by: Option<&str>,
) -> Result<BranchRow, BranchError> {
    let name = input.name.trim();
    let main_head = resolve_branch_head(pool, dataset_id, "main")
        .await
        .map_err(|e| BranchError::new(e.to_string(), 500))?;
    let Some(main_head) = main_head else {
        return Err(BranchError::new("Dataset has no main versions to branch from", 400));
    };
    let base_version = input.base_version.unwrap_or(main_head as i64);
    if base_version < 1 {
        return Err(BranchError::new(
            format!("Invalid baseVersion '{base_version}'"),
            400,
        ));
    }
    let base: Option<(String,)> = sqlx::query_as(
        "SELECT branch FROM dataset_versions WHERE dataset_id = $1 AND version_number = $2",
    )
    .bind(dataset_id)
    .bind(base_version as i32)
    .fetch_optional(pool)
    .await
    .map_err(|e| BranchError::new(e.to_string(), 500))?;
    let Some((base_branch,)) = base else {
        return Err(BranchError::new(
            format!("Version {base_version} not found on this dataset"),
            400,
        ));
    };
    if base_branch != "main" {
        return Err(BranchError::new(
            format!("baseVersion must be a main version (v{base_version} is on branch '{base_branch}')"),
            400,
        ));
    }
    let dup: Option<(String,)> =
        sqlx::query_as("SELECT id FROM dataset_branches WHERE dataset_id = $1 AND name = $2")
            .bind(dataset_id)
            .bind(name)
            .fetch_optional(pool)
            .await
            .map_err(|e| BranchError::new(e.to_string(), 500))?;
    if dup.is_some() {
        return Err(BranchError::new(format!("Branch '{name}' already exists"), 409));
    }
    let description = input.description.map(|d| d.trim()).filter(|d| !d.is_empty());
    let branch: BranchRow = sqlx::query_as(&format!(
        "INSERT INTO dataset_branches (id, dataset_id, name, base_version, head_version, description, created_by) \
         VALUES ($1, $2, $3, $4, $4, $5, $6) RETURNING {BRANCH_COLS}"
    ))
    .bind(mf_db::new_id())
    .bind(dataset_id)
    .bind(name)
    .bind(base_version as i32)
    .bind(description)
    .bind(created_by)
    .fetch_one(pool)
    .await
    .map_err(|e| BranchError::new(e.to_string(), 500))?;
    Ok(branch)
}

pub struct CommitResult {
    pub branch_name: String,
    pub version_number: i32,
    pub row_count: usize,
}

/// Append an isolated branch commit. The expected head prevents stale edits.
pub async fn commit_branch_version(
    state: &AppState,
    dataset_id: &str,
    branch_id: &str,
    rows: &[serde_json::Map<String, mf_types::Value>],
    expected_head_version: i32,
    created_by: &str,
) -> Result<CommitResult, BranchError> {
    if rows.len() > state.max_rows {
        return Err(BranchError::new(
            format!("Branch commits are limited to {} rows", state.max_rows),
            400,
        ));
    }
    let pool = &state.db;
    let branch: Option<BranchRow> = sqlx::query_as(&format!(
        "SELECT {BRANCH_COLS} FROM dataset_branches WHERE id = $1 AND dataset_id = $2"
    ))
    .bind(branch_id)
    .bind(dataset_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| BranchError::new(e.to_string(), 500))?;
    let Some(branch) = branch else {
        return Err(BranchError::new("Branch not found", 404));
    };
    if branch.head_version != expected_head_version {
        return Err(BranchError::new(
            "Branch head changed; reload before committing",
            409,
        ));
    }
    let normalized = normalize_rows(rows);
    let schema = infer_schema(&normalized);
    let data_json = data_json_string(&normalized);
    let next = head_version_number(pool, dataset_id)
        .await
        .map_err(|e| BranchError::new(e.to_string(), 500))?
        + 1;

    let mut tx = pool.begin().await.map_err(|e| BranchError::new(e.to_string(), 500))?;
    let updated = sqlx::query(
        "UPDATE dataset_branches SET head_version = $3, merged_at = NULL, merged_into = NULL \
         WHERE id = $1 AND dataset_id = $2 AND head_version = $4",
    )
    .bind(branch_id)
    .bind(dataset_id)
    .bind(next)
    .bind(expected_head_version)
    .execute(&mut *tx)
    .await
    .map_err(|e| BranchError::new(e.to_string(), 500))?;
    if updated.rows_affected() != 1 {
        return Err(BranchError::new(
            "Branch head changed; reload before committing",
            409,
        ));
    }
    sqlx::query(
        "INSERT INTO dataset_versions (id, dataset_id, version_number, branch, parent_version, \
          created_by, lifecycle, row_count, schema_json, data_json) \
         VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7, $8, $9)",
    )
    .bind(mf_db::new_id())
    .bind(dataset_id)
    .bind(next)
    .bind(&branch.name)
    .bind(expected_head_version)
    .bind(created_by)
    .bind(normalized.len() as i32)
    .bind(sqlx::types::Json(&schema))
    .bind(&data_json)
    .execute(&mut *tx)
    .await
    .map_err(|e| BranchError::new(e.to_string(), 500))?;
    sqlx::query(
        "INSERT INTO version_lineage_edges (id, from_dataset_id, from_version_number, to_dataset_id, to_version_number) \
         VALUES ($1, $2, $3, $2, $4)",
    )
    .bind(mf_db::new_id())
    .bind(dataset_id)
    .bind(expected_head_version)
    .bind(next)
    .execute(&mut *tx)
    .await
    .map_err(|e| BranchError::new(e.to_string(), 500))?;
    tx.commit().await.map_err(|e| BranchError::new(e.to_string(), 500))?;

    // Indexed row storage (improvement: legacy commits relied on the
    // dataJson read fallback; behavior is contract-identical).
    write_version_rows(pool, dataset_id, next, &normalized)
        .await
        .map_err(|e| BranchError::new(e.to_string(), 500))?;

    Ok(CommitResult {
        branch_name: branch.name,
        version_number: next,
        row_count: normalized.len(),
    })
}

pub struct MergeResult {
    pub merged_version: i32,
    pub rows_merged: i32,
    pub branch_name: String,
}

/// Merge a branch back into main: the branch head version's data becomes a
/// NEW main version (next global number, parent = branch head). Re-merge is
/// allowed once the branch has new commits after the last merge.
pub async fn merge_branch(
    state: &AppState,
    dataset_id: &str,
    branch_id: &str,
) -> Result<MergeResult, BranchError> {
    let pool = &state.db;
    let branch: Option<BranchRow> = sqlx::query_as(&format!(
        "SELECT {BRANCH_COLS} FROM dataset_branches WHERE id = $1 AND dataset_id = $2"
    ))
    .bind(branch_id)
    .bind(dataset_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| BranchError::new(e.to_string(), 500))?;
    let Some(branch) = branch else {
        return Err(BranchError::new("Branch not found", 404));
    };
    // Already merged with no new commits since.
    if branch.merged_at.is_some() && branch.head_version <= branch.merged_into.unwrap_or(0) {
        return Err(BranchError::new(
            format!(
                "Branch '{}' is already merged into v{} (new commits required to merge again)",
                branch.name,
                branch.merged_into.unwrap_or(0)
            ),
            409,
        ));
    }
    let head: Option<VersionRow> = sqlx::query_as(&format!(
        "SELECT {VERSION_COLS} FROM dataset_versions WHERE dataset_id = $1 AND version_number = $2"
    ))
    .bind(dataset_id)
    .bind(branch.head_version)
    .fetch_optional(pool)
    .await
    .map_err(|e| BranchError::new(e.to_string(), 500))?;
    let Some(head) = head else {
        return Err(BranchError::new(
            format!("Branch head version {} no longer exists", branch.head_version),
            400,
        ));
    };
    if branch.head_version == branch.base_version {
        return Err(BranchError::new("Branch has no commits to merge", 409));
    }
    let current_main = resolve_branch_head(pool, dataset_id, "main")
        .await
        .map_err(|e| BranchError::new(e.to_string(), 500))?;
    if current_main != Some(branch.base_version) {
        return Err(BranchError::new(
            format!(
                "Main advanced to v{}; create a fresh branch from current main before merging",
                current_main.map(|n| n.to_string()).unwrap_or_else(|| "null".to_string())
            ),
            409,
        ));
    }
    let target: Option<(bool, i32)> =
        sqlx::query_as("SELECT quality_gate, keep_last_n FROM datasets WHERE id = $1")
            .bind(dataset_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| BranchError::new(e.to_string(), 500))?;
    let quality_gate = target.map(|t| t.0).unwrap_or(false);

    let next_version_number = head_version_number(pool, dataset_id)
        .await
        .map_err(|e| BranchError::new(e.to_string(), 500))?
        + 1;
    let merged_at = Utc::now();
    let lifecycle = if quality_gate { "draft" } else { "published" };

    let mut tx = pool.begin().await.map_err(|e| BranchError::new(e.to_string(), 500))?;
    sqlx::query(
        "INSERT INTO dataset_versions (id, dataset_id, version_number, schema_json, row_count, \
          data_json, created_by, branch, parent_version, lifecycle) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'main', $8, $9)",
    )
    .bind(mf_db::new_id())
    .bind(dataset_id)
    .bind(next_version_number)
    .bind(sqlx::types::Json(&head.schema_json.0))
    .bind(head.row_count)
    .bind(&head.data_json)
    .bind(format!("branch-merge:{}", branch.name))
    .bind(branch.head_version)
    .bind(lifecycle)
    .execute(&mut *tx)
    .await
    .map_err(|e| BranchError::new(e.to_string(), 500))?;
    sqlx::query(
        "UPDATE dataset_branches SET base_version = $2, merged_at = $3, merged_into = $2 WHERE id = $1",
    )
    .bind(&branch.id)
    .bind(next_version_number)
    .bind(merged_at)
    .execute(&mut *tx)
    .await
    .map_err(|e| BranchError::new(e.to_string(), 500))?;
    sqlx::query(
        "INSERT INTO version_lineage_edges (id, from_dataset_id, from_version_number, to_dataset_id, to_version_number) \
         VALUES ($1, $2, $3, $2, $4)",
    )
    .bind(mf_db::new_id())
    .bind(dataset_id)
    .bind(branch.head_version)
    .bind(next_version_number)
    .execute(&mut *tx)
    .await
    .map_err(|e| BranchError::new(e.to_string(), 500))?;
    if quality_gate {
        sqlx::query("UPDATE datasets SET updated_at = $2 WHERE id = $1")
            .bind(dataset_id)
            .bind(merged_at)
            .execute(&mut *tx)
            .await
            .map_err(|e| BranchError::new(e.to_string(), 500))?;
    } else {
        sqlx::query("UPDATE datasets SET updated_at = $2, published_version = $3 WHERE id = $1")
            .bind(dataset_id)
            .bind(merged_at)
            .bind(next_version_number)
            .execute(&mut *tx)
            .await
            .map_err(|e| BranchError::new(e.to_string(), 500))?;
    }
    tx.commit().await.map_err(|e| BranchError::new(e.to_string(), 500))?;

    // Indexed row storage for the new main version (copied from the branch
    // head; legacy relied on the dataJson fallback — contract-identical).
    let head_rows = rows_from_data_json(&head.data_json);
    write_version_rows(pool, dataset_id, next_version_number, &head_rows)
        .await
        .map_err(|e| BranchError::new(e.to_string(), 500))?;

    // Retention safety: prunes only main versions and never a branch head/base.
    if let Some((_, keep_last_n)) = target {
        prune_dataset_versions(pool, dataset_id, keep_last_n)
            .await
            .map_err(|e| BranchError::new(e.to_string(), 500))?;
    }

    Ok(MergeResult {
        merged_version: next_version_number,
        rows_merged: head.row_count,
        branch_name: branch.name,
    })
}

/// Delete an UNMERGED branch pointer. Branch version rows stay (history).
pub async fn delete_branch(
    pool: &PgPool,
    dataset_id: &str,
    branch_id: &str,
) -> Result<BranchRow, BranchError> {
    let branch: Option<BranchRow> = sqlx::query_as(&format!(
        "SELECT {BRANCH_COLS} FROM dataset_branches WHERE id = $1 AND dataset_id = $2"
    ))
    .bind(branch_id)
    .bind(dataset_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| BranchError::new(e.to_string(), 500))?;
    let Some(branch) = branch else {
        return Err(BranchError::new("Branch not found", 404));
    };
    if branch.merged_at.is_some() {
        return Err(BranchError::new(
            format!(
                "Branch '{}' is merged (v{}) and cannot be deleted",
                branch.name,
                branch.merged_into.map(|n| n.to_string()).unwrap_or_else(|| "null".to_string())
            ),
            409,
        ));
    }
    sqlx::query("DELETE FROM dataset_branches WHERE id = $1")
        .bind(&branch.id)
        .execute(pool)
        .await
        .map_err(|e| BranchError::new(e.to_string(), 500))?;
    Ok(branch)
}
