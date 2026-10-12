//! P2 trust workflow — publication gate helpers (port of src/lib/publication.ts).
//!
//! A dataset with qualityGate=true holds every new version as a DRAFT;
//! consumers read the last PUBLISHED version until an admin approves the exact
//! draft. In the microservice split the ApprovalRequest rows live in
//! governance: the PUBLIC publish route validates the draft (exact legacy
//! reasons) and asks governance to create the approval; governance calls back
//! via POST /internal/datasets/{id}/publish-approved (or the
//! mf.approval.decided event) which runs `publish_approved` below.

use mf_events::NotifyEvent;
use serde_json::{json, Value};
use sqlx::PgPool;

use crate::state::AppState;

/// PublicationError — legacy status + machine-readable reasons.
pub struct PublicationError {
    pub status: u16,
    pub message: String,
    pub reasons: Vec<String>,
}

impl PublicationError {
    pub fn into_api_error(self) -> mf_web::ApiError {
        let status = match self.status {
            400 => axum::http::StatusCode::BAD_REQUEST,
            403 => axum::http::StatusCode::FORBIDDEN,
            404 => axum::http::StatusCode::NOT_FOUND,
            409 => axum::http::StatusCode::CONFLICT,
            _ => axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        };
        let mut err = mf_web::ApiError::new(status, self.message);
        // The legacy decide route surfaced reasons as { reasons } in `detail`.
        if !self.reasons.is_empty() {
            err = err.with_detail(json!({ "reasons": self.reasons }));
        }
        err
    }
}

#[allow(dead_code)] // flipped distinguishes a real publish from an idempotent no-op
pub struct PublishOutcome {
    pub dataset_id: String,
    pub dataset_name: String,
    pub version_number: i32,
    pub quality_state: String,
    pub published_version: i32,
    /// True when this call performed the flip (false = idempotent no-op).
    pub flipped: bool,
}

/// Failing error-severity rules for one version (latest result per rule).
pub async fn failing_error_rules(
    pool: &PgPool,
    dataset_id: &str,
    version_number: i32,
) -> Vec<(String, Option<String>)> {
    // Legacy: results ordered createdAt desc, first-seen per RULE wins.
    let rows: Vec<(String, bool, Option<String>, String, String)> = sqlx::query_as(
        "SELECT r.rule_id, r.passed, r.message, q.name, q.severity \
         FROM quality_results r JOIN quality_rules q ON q.id = r.rule_id \
         WHERE r.dataset_id = $1 AND r.version_number = $2 \
         ORDER BY r.created_at DESC, r.id DESC",
    )
    .bind(dataset_id)
    .bind(version_number)
    .fetch_all(pool)
    .await
    .unwrap_or_default();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out = Vec::new();
    for (rule_id, passed, message, name, severity) in rows {
        if seen.insert(rule_id) && !passed && severity == "error" {
            out.push((name, message));
        }
    }
    out
}

/// Latest draft version of a dataset (highest versionNumber on main), or None.
pub async fn latest_draft_version(
    pool: &PgPool,
    dataset_id: &str,
) -> Result<Option<i32>, sqlx::Error> {
    let n: Option<i32> = sqlx::query_scalar(
        "SELECT max(version_number) FROM dataset_versions \
         WHERE dataset_id = $1 AND branch = 'main' AND lifecycle = 'draft'",
    )
    .bind(dataset_id)
    .fetch_one(pool)
    .await?;
    Ok(n)
}

/// Validate a draft against the publication rules (port of the checks in
/// `publishDatasetVersion`, minus the approval-record check which governance
/// owns now). Ok(()) → the draft MAY be published.
pub async fn validate_publication(
    pool: &PgPool,
    dataset_id: &str,
    version_number: i32,
) -> Result<(String, String), PublicationError> {
    let dataset: Option<(String, bool)> =
        sqlx::query_as("SELECT name, quality_gate FROM datasets WHERE id = $1")
            .bind(dataset_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| PublicationError {
                status: 500,
                message: e.to_string(),
                reasons: vec![],
            })?;
    let Some((dataset_name, quality_gate)) = dataset else {
        return Err(PublicationError {
            status: 404,
            message: format!("Dataset '{dataset_id}' not found"),
            reasons: vec![],
        });
    };
    if !quality_gate {
        return Err(PublicationError {
            status: 409,
            message: "Dataset quality gate is disabled".to_string(),
            reasons: vec![],
        });
    }
    let version: Option<(String, Option<String>, Option<String>, String)> = sqlx::query_as(
        "SELECT lifecycle, quality_state, quality_summary_json::text, branch \
         FROM dataset_versions WHERE dataset_id = $1 AND version_number = $2",
    )
    .bind(dataset_id)
    .bind(version_number)
    .fetch_optional(pool)
    .await
    .map_err(|e| PublicationError {
        status: 500,
        message: e.to_string(),
        reasons: vec![],
    })?;
    let Some((lifecycle, quality_state, quality_summary, branch)) = version else {
        return Err(PublicationError {
            status: 404,
            message: format!("Version {version_number} of '{dataset_name}' not found"),
            reasons: vec![],
        });
    };
    if branch != "main" {
        return Err(PublicationError {
            status: 409,
            message: "Only main branch versions can be published".to_string(),
            reasons: vec![],
        });
    }
    if lifecycle == "published" {
        return Err(PublicationError {
            status: 400,
            message: format!(
                "v{version_number} is already published (only drafts can be published)"
            ),
            reasons: vec![],
        });
    }
    let state_ok = matches!(quality_state.as_deref(), Some("passed") | Some("warned"));
    let has_summary = quality_summary
        .as_ref()
        .map(|s| !s.is_empty() && s != "null")
        .unwrap_or(false);
    if !has_summary || !state_ok {
        let failures = failing_error_rules(pool, dataset_id, version_number).await;
        let current = quality_state.unwrap_or_else(|| "not_evaluated".to_string());
        return Err(PublicationError {
            status: 403,
            message: format!(
                "Publication blocked: v{version_number} requires a completed quality evaluation \
                 without error-severity failures (current: {current})"
            ),
            reasons: failures
                .into_iter()
                .map(|(name, message)| match message {
                    Some(m) => format!("{name} \u{2014} {m}"),
                    None => name,
                })
                .collect(),
        });
    }
    Ok((
        dataset_name,
        quality_state.unwrap_or_else(|| "not_evaluated".to_string()),
    ))
}

/// Flip a validated draft to published (the legacy publish transaction):
/// lifecycle draft→published, dataset.publishedVersion → version, additive
/// 'production' tag. Idempotent: an already-published version is a no-op
/// success (INTERNAL_API.md requires idempotency for retries/events).
pub async fn publish_approved(
    state: &AppState,
    dataset_id: &str,
    version_number: i32,
    approval_id: Option<&str>,
    decided_by: Option<&str>,
) -> Result<PublishOutcome, PublicationError> {
    // Dataset must exist (404 like the legacy).
    let dataset_exists: Option<(String,)> =
        sqlx::query_as("SELECT name FROM datasets WHERE id = $1")
            .bind(dataset_id)
            .fetch_optional(&state.db)
            .await
            .map_err(|e| PublicationError {
                status: 500,
                message: e.to_string(),
                reasons: vec![],
            })?;
    if dataset_exists.is_none() {
        return Err(PublicationError {
            status: 404,
            message: format!("Dataset '{dataset_id}' not found"),
            reasons: vec![],
        });
    }

    // Idempotency probe FIRST: an already-published version is a no-op
    // success (event redelivery / retry after the sync call succeeded).
    let existing: Option<(String, Option<String>)> = sqlx::query_as(
        "SELECT lifecycle, quality_state FROM dataset_versions \
         WHERE dataset_id = $1 AND version_number = $2",
    )
    .bind(dataset_id)
    .bind(version_number)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| PublicationError {
        status: 500,
        message: e.to_string(),
        reasons: vec![],
    })?;
    if let Some((lifecycle, quality_state)) = &existing {
        if lifecycle == "published" {
            let (name, _published) = current_dataset_name_state(&state.db, dataset_id).await?;
            return Ok(PublishOutcome {
                dataset_id: dataset_id.to_string(),
                dataset_name: name,
                version_number,
                quality_state: quality_state
                    .clone()
                    .unwrap_or_else(|| "not_evaluated".to_string()),
                published_version: version_number,
                flipped: false,
            });
        }
    }

    // Legacy decide-route behavior: re-check the exact draft against current
    // rules immediately before publication (failed evaluation blocks).
    if let Err(e) =
        crate::quality::evaluate_rules(state, dataset_id, version_number, "manual").await
    {
        // Missing version → PublicationError-style 400; dataset issues 404.
        return Err(PublicationError {
            status: e.status,
            message: e.message,
            reasons: vec![],
        });
    }

    let (dataset_name, quality_state) =
        validate_publication(&state.db, dataset_id, version_number).await?;

    let mut tx = state.db.begin().await.map_err(|e| PublicationError {
        status: 500,
        message: e.to_string(),
        reasons: vec![],
    })?;
    let published = sqlx::query(
        "UPDATE dataset_versions SET lifecycle = 'published' \
         WHERE dataset_id = $1 AND version_number = $2 AND branch = 'main' AND lifecycle = 'draft' \
           AND quality_state IN ('passed', 'warned')",
    )
    .bind(dataset_id)
    .bind(version_number)
    .execute(&mut *tx)
    .await
    .map_err(|e| PublicationError {
        status: 500,
        message: e.to_string(),
        reasons: vec![],
    })?;
    if published.rows_affected() != 1 {
        return Err(PublicationError {
            status: 409,
            message: "Draft changed before publication".to_string(),
            reasons: vec![],
        });
    }
    let tags_raw: (Value,) = sqlx::query_as("SELECT tags FROM datasets WHERE id = $1")
        .bind(dataset_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| PublicationError {
            status: 500,
            message: e.to_string(),
            reasons: vec![],
        })?;
    let mut tags: Vec<String> = serde_json::from_value(tags_raw.0).unwrap_or_default();
    if !tags.iter().any(|t| t == "production") {
        tags.push("production".to_string());
    }
    sqlx::query(
        "UPDATE datasets SET published_version = $2, tags = $3, updated_at = now() WHERE id = $1",
    )
    .bind(dataset_id)
    .bind(version_number)
    .bind(sqlx::types::Json(&tags))
    .execute(&mut *tx)
    .await
    .map_err(|e| PublicationError {
        status: 500,
        message: e.to_string(),
        reasons: vec![],
    })?;
    tx.commit().await.map_err(|e| PublicationError {
        status: 500,
        message: e.to_string(),
        reasons: vec![],
    })?;

    // Only a published version may trigger downstream consumers (legacy
    // handleVersionCreated({source:'publication'}) → the version event).
    let event = mf_events::VersionCreatedEvent {
        dataset_id: dataset_id.to_string(),
        version_number: version_number as i64,
        source: Some("publication".to_string()),
        cascade_parent_run_id: None,
        cascade_depth: None,
    };
    mf_events::publish_json_quiet(&state.nats, mf_events::subject::VERSION_CREATED, &event).await;

    // Legacy decide-route side effects owned by the catalog side now:
    // audit 'dataset.publish' + the 'Published:' broadcast notification.
    let detail = match approval_id {
        Some(a) => format!("v{version_number} published via approval {a}"),
        None => format!("v{version_number} published"),
    };
    crate::audit::audit_system(
        state,
        crate::audit::AuditOptions::new("dataset.publish", "dataset")
            .actor_role(decided_by.unwrap_or("system"))
            .resource_id(Some(dataset_id))
            .resource_name(Some(&dataset_name))
            .detail(Some(&detail)),
    )
    .await;
    let notify = NotifyEvent {
        user_email: None,
        notif_type: "system".to_string(),
        title: format!("Published: {dataset_name} v{version_number}"),
        body: Some(format!(
            "Quality state: {quality_state}. Consumers now read v{version_number}."
        )),
        resource_type: Some("dataset".to_string()),
        resource_id: Some(dataset_id.to_string()),
        href: Some(format!("/datasets/{dataset_id}")),
    };
    mf_events::publish_json_quiet(&state.nats, mf_events::subject::NOTIFY, &notify).await;

    Ok(PublishOutcome {
        dataset_id: dataset_id.to_string(),
        dataset_name,
        version_number,
        quality_state,
        published_version: version_number,
        flipped: true,
    })
}

async fn current_dataset_name_state(
    pool: &PgPool,
    dataset_id: &str,
) -> Result<(String, Option<i32>), PublicationError> {
    let row: Option<(String, Option<i32>)> =
        sqlx::query_as("SELECT name, published_version FROM datasets WHERE id = $1")
            .bind(dataset_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| PublicationError {
                status: 500,
                message: e.to_string(),
                reasons: vec![],
            })?;
    match row {
        Some((name, published)) => Ok((name, published)),
        None => Err(PublicationError {
            status: 404,
            message: format!("Dataset '{dataset_id}' not found"),
            reasons: vec![],
        }),
    }
}

/// Toggle a dataset's quality gate (port of `setQualityGate`).
/// Enabling backfills publishedVersion to the newest PUBLISHED main version;
/// disabling requires no outstanding main drafts.
pub async fn set_quality_gate(
    pool: &PgPool,
    dataset_id: &str,
    enabled: bool,
) -> Result<(), PublicationError> {
    let dataset: Option<(bool,)> =
        sqlx::query_as("SELECT quality_gate FROM datasets WHERE id = $1")
            .bind(dataset_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| PublicationError {
                status: 500,
                message: e.to_string(),
                reasons: vec![],
            })?;
    let Some((current,)) = dataset else {
        return Ok(());
    };
    if current == enabled {
        return Ok(());
    }
    if enabled {
        let head: Option<i32> = sqlx::query_scalar(
            "SELECT max(version_number) FROM dataset_versions \
             WHERE dataset_id = $1 AND branch = 'main' AND lifecycle = 'published'",
        )
        .bind(dataset_id)
        .fetch_one(pool)
        .await
        .map_err(|e| PublicationError {
            status: 500,
            message: e.to_string(),
            reasons: vec![],
        })?;
        sqlx::query("UPDATE datasets SET quality_gate = TRUE, published_version = $2, updated_at = now() WHERE id = $1")
            .bind(dataset_id)
            .bind(head)
            .execute(pool)
            .await
            .map_err(|e| PublicationError { status: 500, message: e.to_string(), reasons: vec![] })?;
        return Ok(());
    }
    let drafts: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM dataset_versions WHERE dataset_id = $1 AND branch = 'main' AND lifecycle = 'draft'",
    )
    .bind(dataset_id)
    .fetch_one(pool)
    .await
    .map_err(|e| PublicationError { status: 500, message: e.to_string(), reasons: vec![] })?;
    if drafts > 0 {
        return Err(PublicationError {
            status: 409,
            message: "Resolve or remove all drafts before disabling the quality gate".to_string(),
            reasons: vec![],
        });
    }
    // Disabling is an admin operation; no draft may be implicitly published.
    let head: Option<i32> = sqlx::query_scalar(
        "SELECT max(version_number) FROM dataset_versions WHERE dataset_id = $1 AND branch = 'main'",
    )
    .bind(dataset_id)
    .fetch_one(pool)
    .await
    .map_err(|e| PublicationError { status: 500, message: e.to_string(), reasons: vec![] })?;
    sqlx::query("UPDATE datasets SET quality_gate = FALSE, published_version = $2, updated_at = now() WHERE id = $1")
        .bind(dataset_id)
        .bind(head)
        .execute(pool)
        .await
        .map_err(|e| PublicationError { status: 500, message: e.to_string(), reasons: vec![] })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publication_error_maps_status_and_reasons() {
        let e = PublicationError {
            status: 403,
            message: "Publication blocked: v2 requires a completed quality evaluation without error-severity failures (current: failed)".into(),
            reasons: vec!["Risk score within 0\u{2013}100 \u{2014} 1 of 5 rows outside range [0, 100] for 'risk_score'".into()],
        };
        let api = e.into_api_error();
        assert_eq!(api.status, axum::http::StatusCode::FORBIDDEN);
        let detail = api.detail.unwrap();
        assert_eq!(detail["reasons"].as_array().unwrap().len(), 1);
        assert!(detail["reasons"][0]
            .as_str()
            .unwrap()
            .contains("1 of 5 rows outside range [0, 100]"));
    }

    #[test]
    fn reasons_format_uses_em_dash() {
        let failures = vec![
            ("rule".to_string(), Some("msg".to_string())),
            ("bare".to_string(), None),
        ];
        let reasons: Vec<String> = failures
            .into_iter()
            .map(|(name, message)| match message {
                Some(m) => format!("{name} \u{2014} {m}"),
                None => name,
            })
            .collect();
        assert_eq!(reasons, vec!["rule \u{2014} msg", "bare"]);
    }
}
