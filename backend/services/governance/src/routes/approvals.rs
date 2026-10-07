//! /api/approvals* — P2 trust workflow (ports of the legacy approvals
//! routes). GET list (any role, latest 100, live publish-gate preview for
//! PENDING publish_dataset rows via the catalog); POST create (editor+,
//! target name + latest draft resolved through catalog/orchestration);
//! POST decide (admin).
//!
//! Decide → publish_dataset fan-out contract (per task spec):
//! - catalog 2xx  → commit decision + dataset.publish audit + Published bell;
//! - catalog 4xx  → pass the callee's { error, detail?{reasons} } through
//!   UNCHANGED (legacy PublicationError path); the approval stays pending;
//! - transport    → STILL commit the decision and publish mf.approval.decided
//!   (catalog's consumer is the retry path); publish-side audit/bell skipped
//!   (publication unconfirmed).
//!
//! Every committed decision emits mf.approval.decided (fire-and-forget).

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use mf_web::{actor_from_headers, json_ok, require_role, ApiError, ApiResult};
use serde_json::Value;
use std::collections::HashMap;

use crate::fanout::{pass_through, FanOutError};
use crate::state::{
    audit_local, create_notification, serialize_approval, ApprovalRow, AppState, AuditOptions,
    NotificationInput, APPROVAL_COLS,
};

/// GET /api/approvals?status= — latest 100, created desc.
pub async fn list_approvals(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    let status = params
        .get("status")
        .filter(|s| !s.is_empty())
        .cloned();

    let approvals: Vec<ApprovalRow> = sqlx::query_as(&format!(
        "SELECT {APPROVAL_COLS} FROM approval_requests \
         WHERE ($1::text IS NULL OR status = $1) \
         ORDER BY created_at DESC, id DESC LIMIT 100"
    ))
    .bind(&status)
    .fetch_all(&state.db)
    .await?;

    // Live gate previews for distinct pending publish_dataset targets
    // (additive field; decided rows and publish_pipeline keep the raw shape).
    let mut targets: Vec<(String, Option<i32>)> = Vec::new();
    for a in &approvals {
        if a.status == "pending" && a.kind == "publish_dataset"
            && !targets.iter().any(|(id, _)| id == &a.target_id)
        {
            targets.push((a.target_id.clone(), a.version_number));
        }
    }
    let mut previews: HashMap<String, Value> = HashMap::new();
    for (id, version) in &targets {
        previews.insert(
            id.clone(),
            gate_preview(&state, id, *version).await.unwrap_or(Value::Null),
        );
    }

    let out: Vec<Value> = approvals
        .iter()
        .map(|a| {
            let mut v = serialize_approval(a);
            if a.status == "pending" && a.kind == "publish_dataset" {
                v["publishPreview"] = previews
                    .get(&a.target_id)
                    .cloned()
                    .unwrap_or(Value::Null);
            }
            v
        })
        .collect();

    Ok(json_ok(serde_json::json!({ "approvals": out })))
}

/// Port of the legacy `gatePreview()` — never fails (degrades to None).
async fn gate_preview(state: &AppState, target_id: &str, version_number: Option<i32>) -> Option<Value> {
    let detail = state
        .clients
        .catalog
        .get(&format!("/internal/datasets/{target_id}"))
        .await
        .ok()?;
    let detail = detail
        .get("dataset")
        .cloned()
        .unwrap_or(detail);
    let gate_on = detail.get("qualityGate").and_then(|v| v.as_bool())?;
    if !gate_on {
        return Some(serde_json::json!({
            "status": "ungated", "gateOn": false, "draftVersion": null,
            "qualityState": null, "failing": [],
        }));
    }
    let Some(draft) = version_number else {
        return Some(serde_json::json!({
            "status": "no_draft", "gateOn": true, "draftVersion": null,
            "qualityState": null, "failing": [],
        }));
    };
    let version = state
        .clients
        .catalog
        .get(&format!("/internal/datasets/{target_id}/versions/{draft}"))
        .await
        .ok()?;
    let version = version.get("version").cloned().unwrap_or(version);
    let quality_state = version
        .get("qualityState")
        .and_then(|v| v.as_str())
        .unwrap_or("not_evaluated");
    let failing = version
        .get("failingRules")
        .or_else(|| version.get("failing"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .map(|f| {
                    serde_json::json!({
                        "name": f.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                        "message": f.get("message").cloned().unwrap_or(Value::Null),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let status = if quality_state == "passed" || quality_state == "warned" {
        "ready"
    } else {
        "blocked"
    };
    Some(serde_json::json!({
        "status": status, "gateOn": true, "draftVersion": draft,
        "qualityState": quality_state, "failing": failing,
    }))
}

/// POST /api/approvals — request an approval (editor+).
pub async fn create_approval(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;
    let role = actor.role.clone();

    let v = crate::routes::parse_body(&body)?;
    let m = crate::routes::as_object(v)?;
    let kind = crate::routes::req_enum(&m, "kind", &["publish_dataset", "publish_pipeline"])?;
    let target_id = crate::routes::req_str_min1(&m, "targetId", "targetId is required")?;
    let note = crate::routes::opt_str(&m, "note")?;

    // Resolve the target's display name (dataset or pipeline).
    let detail = match kind {
        "publish_dataset" => state
            .clients
            .catalog
            .get(&format!("/internal/datasets/{target_id}"))
            .await,
        _ => state
            .clients
            .orchestration
            .get(&format!("/internal/pipelines/{target_id}"))
            .await,
    };
    let envelope = match detail {
        Ok(v) => v,
        Err(FanOutError::Api { status: 404, .. }) => {
            return Err(ApiError::not_found(format!(
                "Target '{target_id}' not found for kind '{kind}'"
            )))
        }
        Err(e) if e.is_transport() => {
            tracing::warn!(kind, target_id, error = %e, "target service unreachable for approval create");
            return Err(crate::fanout::upstream_unavailable());
        }
        Err(e) => return Err(pass_through(e)),
    };
    let detail = payload_root(&envelope, &["dataset", "pipeline"]);
    let target_name = detail.get("name").and_then(|v| v.as_str()).filter(|s| !s.is_empty());
    let Some(target_name) = target_name else {
        return Err(ApiError::not_found(format!(
            "Target '{target_id}' not found for kind '{kind}'"
        )));
    };

    // publish_dataset pins the latest main-branch draft (legacy
    // latestDraftVersion); the versions list lives on the catalog ENVELOPE
    // (sibling of the dataset object), so scan before rooting.
    let version_number = if kind == "publish_dataset" {
        let draft = latest_draft_version(&envelope).or_else(|| latest_draft_version(detail));
        if draft.is_none() {
            return Err(ApiError::bad_request(
                "No draft version exists to request publication",
            ));
        }
        draft.map(|n| n as i32)
    } else {
        None
    };

    let duplicate: Option<(String,)> = sqlx::query_as(
        "SELECT id FROM approval_requests WHERE kind = $1 AND target_id = $2 AND status = 'pending' \
         ORDER BY created_at ASC LIMIT 1",
    )
    .bind(kind)
    .bind(target_id)
    .fetch_optional(&state.db)
    .await?;
    if duplicate.is_some() {
        return Err(ApiError::bad_request(format!(
            "A pending {kind} request for '{target_name}' already exists"
        )));
    }

    let id = mf_db::new_id();
    let approval: ApprovalRow = sqlx::query_as(&format!(
        "INSERT INTO approval_requests (id, kind, target_id, version_number, target_name, requested_by, note) \
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING {APPROVAL_COLS}"
    ))
    .bind(&id)
    .bind(kind)
    .bind(target_id)
    .bind(version_number)
    .bind(target_name)
    .bind(&role)
    .bind(note)
    .fetch_one(&state.db)
    .await?;

    audit_local(
        &state,
        &actor,
        AuditOptions::new("approval.request", "approval")
            .resource_id(Some(&approval.id))
            .resource_name(Some(&format!("{kind}: {target_name}")))
            .detail(note),
    )
    .await;

    // R14: bell notification for the request (broadcast — admins decide it).
    create_notification(
        &state,
        NotificationInput {
            user_email: None,
            notif_type: "approval_requested",
            title: &format!("Approval requested: {target_name}"),
            body: Some(&format!("{kind} by {role}")),
            resource_type: Some("approval"),
            resource_id: Some(&approval.id),
            href: Some("/governance"),
        },
    )
    .await;

    Ok(mf_web::json_created(serde_json::json!({
        "approval": serialize_approval(&approval),
    })))
}

/// POST /api/approvals/{id}/decide — decide a pending approval (admin).
pub async fn decide_approval(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "admin")?;
    let role = actor.role.clone();

    let approval: Option<ApprovalRow> = sqlx::query_as(&format!(
        "SELECT {APPROVAL_COLS} FROM approval_requests WHERE id = $1"
    ))
    .bind(&id)
    .fetch_optional(&state.db)
    .await?;
    let Some(approval) = approval else {
        return Err(ApiError::not_found(format!(
            "Approval request '{id}' not found"
        )));
    };
    if approval.status != "pending" {
        return Err(ApiError::bad_request(format!(
            "Approval request is already {}",
            approval.status
        )));
    }

    let v = crate::routes::parse_body_or_null(&body);
    let m = crate::routes::as_object(v)?;
    let decision = crate::routes::req_enum(&m, "decision", &["approved", "rejected"])?;
    let note = crate::routes::opt_str(&m, "note")?;

    let mut published_outcome: Option<Value> = None;
    if decision == "approved" && approval.kind == "publish_dataset" {
        let Some(version_number) = approval.version_number else {
            return Err(ApiError::bad_request(
                "This legacy request has no pinned draft; create a new publication request",
            ));
        };
        let call = state
            .clients
            .catalog
            .post(
                &format!("/internal/datasets/{}/publish-approved", approval.target_id),
                &serde_json::json!({
                    "versionNumber": version_number,
                    "approvalId": approval.id,
                    "decidedBy": role,
                    "decisionNote": note,
                }),
            )
            .await;
        match call {
            Ok(resp) => published_outcome = Some(resp),
            Err(FanOutError::Api {
                status,
                message,
                detail,
            }) => {
                // Legacy PublicationError path: surface the callee's contract
                // error unchanged; the approval stays PENDING.
                let code = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST);
                let mut err = ApiError::new(code, message);
                if let Some(d) = detail {
                    err = err.with_detail(d);
                }
                return Err(err);
            }
            Err(e @ FanOutError::Transport(_)) => {
                // Retry path: commit the decision anyway; mf.approval.decided
                // (published below) lets the catalog complete the publication.
                tracing::warn!(approval = %approval.id, error = %e,
                    "catalog unreachable during publish-approved; committing decision + event fallback");
            }
        }
    }

    let updated = commit_decision(&state, &approval.id, decision, &role, note).await?;

    if let Some(resp) = published_outcome {
        // Publication confirmed — legacy dataset.publish audit + Published bell.
        let dataset_id = resp
            .get("datasetId")
            .and_then(|v| v.as_str())
            .unwrap_or(&approval.target_id)
            .to_string();
        let dataset_name = resp
            .get("datasetName")
            .and_then(|v| v.as_str())
            .unwrap_or(&approval.target_name)
            .to_string();
        let version_number = resp
            .get("versionNumber")
            .and_then(|v| v.as_i64())
            .unwrap_or(approval.version_number.unwrap_or(0) as i64);
        let quality_state = resp
            .get("qualityState")
            .and_then(|v| v.as_str())
            .unwrap_or("not_evaluated");
        let published_version = resp
            .get("publishedVersion")
            .and_then(|v| v.as_i64())
            .unwrap_or(version_number);

        audit_local(
            &state,
            &actor,
            AuditOptions::new("dataset.publish", "dataset")
                .resource_id(Some(&dataset_id))
                .resource_name(Some(&dataset_name))
                .detail(Some(&format!(
                    "v{version_number} published via approval {}",
                    approval.id
                ))),
        )
        .await;
        create_notification(
            &state,
            NotificationInput {
                user_email: None,
                notif_type: "system",
                title: &format!("Published: {dataset_name} v{version_number}"),
                body: Some(&format!(
                    "Quality state: {quality_state}. Consumers now read v{published_version}."
                )),
                resource_type: Some("dataset"),
                resource_id: Some(&dataset_id),
                href: Some(&format!("/datasets/{dataset_id}")),
            },
        )
        .await;
    }

    audit_local(
        &state,
        &actor,
        AuditOptions::new("approval.decide", "approval")
            .resource_id(Some(&id))
            .resource_name(Some(&format!("{}: {}", approval.kind, approval.target_name)))
            .detail(Some(&format!(
                "{decision} by {role}{}",
                note.map(|n| format!(" — {n}")).unwrap_or_default()
            ))),
    )
    .await;
    create_notification(
        &state,
        NotificationInput {
            user_email: None,
            notif_type: "system",
            title: &format!(
                "{}: {}",
                if decision == "approved" {
                    "Approved"
                } else {
                    "Rejected"
                },
                approval.target_name
            ),
            body: Some(&format!(
                "{}{}",
                approval.kind,
                note.map(|n| format!(" — {n}")).unwrap_or_default()
            )),
            resource_type: Some("approval"),
            resource_id: Some(&id),
            href: Some("/governance"),
        },
    )
    .await;

    // Retry/fallback signal for the catalog (idempotent there).
    mf_events::publish_json_quiet(
        &state.nats,
        mf_events::subject::APPROVAL_DECIDED,
        &mf_events::ApprovalDecidedEvent {
            approval_id: approval.id.clone(),
            kind: approval.kind.clone(),
            target_id: approval.target_id.clone(),
            version_number: approval.version_number.map(|n| n as i64),
            status: decision.to_string(),
            decided_by: role,
        },
    )
    .await;

    Ok(json_ok(serde_json::json!({
        "approval": serialize_approval(&updated),
    })))
}

async fn commit_decision(
    state: &AppState,
    id: &str,
    decision: &str,
    role: &str,
    note: Option<&str>,
) -> Result<ApprovalRow, ApiError> {
    let updated: ApprovalRow = sqlx::query_as(&format!(
        "UPDATE approval_requests SET status = $1, decided_by = $2, decided_at = now(), \
         decision_note = $3 WHERE id = $4 RETURNING {APPROVAL_COLS}"
    ))
    .bind(decision)
    .bind(role)
    .bind(note)
    .bind(id)
    .fetch_one(&state.db)
    .await?;
    Ok(updated)
}

/// Unwrap a `{dataset:{…}}` / `{pipeline:{…}}` envelope when present.
fn payload_root<'a>(v: &'a Value, keys: &[&str]) -> &'a Value {
    for k in keys {
        if let Some(inner) = v.get(*k) {
            if inner.is_object() {
                return inner;
            }
        }
    }
    v
}

/// Latest main-branch draft version from a catalog dataset-detail payload
/// (tolerant: explicit field first, then a versions[] scan).
pub fn latest_draft_version(detail: &Value) -> Option<i64> {
    if let Some(n) = detail
        .get("latestDraftVersion")
        .or_else(|| detail.get("draftVersion"))
        .and_then(|v| v.as_i64())
    {
        return Some(n);
    }
    let versions = detail.get("versions")?.as_array()?;
    versions
        .iter()
        .filter(|v| {
            v.get("lifecycle").and_then(|x| x.as_str()) == Some("draft")
                && v.get("branch")
                    .and_then(|x| x.as_str())
                    .map(|b| b == "main")
                    .unwrap_or(true)
        })
        .filter_map(|v| v.get("versionNumber").and_then(|x| x.as_i64()))
        .max()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn draft_version_from_explicit_field() {
        let d = serde_json::json!({ "latestDraftVersion": 3 });
        assert_eq!(latest_draft_version(&d), Some(3));
    }

    #[test]
    fn draft_version_from_versions_scan() {
        let d = serde_json::json!({
            "versions": [
                { "versionNumber": 1, "lifecycle": "published", "branch": "main" },
                { "versionNumber": 2, "lifecycle": "draft", "branch": "main" },
                { "versionNumber": 3, "lifecycle": "draft", "branch": "feature" },
                { "versionNumber": 4, "lifecycle": "draft" }
            ]
        });
        // main-branch drafts only: 2 and 4 (branch absent → treated as main)
        assert_eq!(latest_draft_version(&d), Some(4));
    }

    #[test]
    fn draft_version_absent() {
        assert_eq!(latest_draft_version(&serde_json::json!({})), None);
        assert_eq!(
            latest_draft_version(&serde_json::json!({"versions": []})),
            None
        );
    }
}
