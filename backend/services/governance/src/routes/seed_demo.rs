//! POST /api/governance/seed-demo — idempotent M9 demo governance data
//! (exact port of the legacy route):
//!  - marking "PII" (minRole editor, rose) attached to Suppliers.name
//!  - marking "Confidential" (minRole admin, amber) attached to Inventory.unitCost
//!  - one pending ApprovalRequest publish_dataset targeting Shipments
//!    ("Ready for production review") — skipped when one already exists.
//!
//! Datasets live in the catalog now: lookups go through
//! GET /internal/datasets/by-name/{name}; a definite 404 reproduces the
//! legacy 400 `Dataset '<name>' not found — seed demo data first
//! (POST /api/seed)`, a transport failure is a clean 502.

use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::Response;
use mf_web::{actor_from_headers, json_ok, require_role, ApiError, ApiResult};

use crate::fanout::{pass_through, percent_encode, FanOutError};
use crate::state::{audit_local, AppState, AuditOptions, MarkingRow, MARKING_COLS};

struct DemoMarkingSpec {
    name: &'static str,
    description: &'static str,
    color: &'static str,
    min_role: &'static str,
    dataset_name: &'static str,
    columns: [&'static str; 1],
}

const DEMO_MARKINGS: [DemoMarkingSpec; 2] = [
    DemoMarkingSpec {
        name: "PII",
        description: "Personally identifiable information — visible to editors and above.",
        color: "rose",
        min_role: "editor",
        dataset_name: "Suppliers",
        columns: ["name"],
    },
    DemoMarkingSpec {
        name: "Confidential",
        description: "Confidential commercial data — visible to admins only.",
        color: "amber",
        min_role: "admin",
        dataset_name: "Inventory",
        columns: ["unitCost"],
    },
];

pub async fn seed_demo(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "admin")?;

    let mut seeded = false;
    let mut marking_names: Vec<String> = Vec::new();
    let mut approval_ids: Vec<String> = Vec::new();

    // ── markings + column attachments ───────────────────────────────
    for spec in DEMO_MARKINGS.iter() {
        let marking: MarkingRow = match sqlx::query_as(&format!(
            "SELECT {MARKING_COLS} FROM markings WHERE name = $1"
        ))
        .bind(spec.name)
        .fetch_optional(&state.db)
        .await?
        {
            Some(m) => m,
            None => {
                let id = mf_db::new_id();
                let m: MarkingRow = sqlx::query_as(&format!(
                    "INSERT INTO markings (id, name, description, color, min_role) \
                     VALUES ($1,$2,$3,$4,$5) RETURNING {MARKING_COLS}"
                ))
                .bind(&id)
                .bind(spec.name)
                .bind(spec.description)
                .bind(spec.color)
                .bind(spec.min_role)
                .fetch_one(&state.db)
                .await?;
                seeded = true;
                audit_local(
                    &state,
                    &actor,
                    AuditOptions::new("marking.create", "marking")
                        .resource_id(Some(&m.id))
                        .resource_name(Some(&m.name))
                        .detail(Some(&format!(
                            "minRole {}, color {} (demo seed)",
                            m.min_role, m.color
                        ))),
                )
                .await;
                m
            }
        };
        marking_names.push(marking.name.clone());

        // Backing dataset must exist for the attachment.
        let dataset = dataset_by_name(&state, spec.dataset_name).await?;
        let (dataset_id, dataset_name) = dataset;

        let mut touched = false;
        for column_name in spec.columns.iter() {
            let existing: Option<(String, String)> = sqlx::query_as(
                "SELECT id, marking_id FROM column_markings WHERE dataset_id = $1 AND column_name = $2",
            )
            .bind(&dataset_id)
            .bind(column_name)
            .fetch_optional(&state.db)
            .await?;
            if existing.as_ref().is_some_and(|(_, mid)| mid == &marking.id) {
                continue;
            }
            sqlx::query(
                "INSERT INTO column_markings (id, dataset_id, column_name, marking_id) \
                 VALUES ($1,$2,$3,$4) \
                 ON CONFLICT (dataset_id, column_name) DO UPDATE SET marking_id = $4",
            )
            .bind(mf_db::new_id())
            .bind(&dataset_id)
            .bind(*column_name)
            .bind(&marking.id)
            .execute(&state.db)
            .await?;
            seeded = true;
            touched = true;
            audit_local(
                &state,
                &actor,
                AuditOptions::new("marking.attach", "marking")
                    .resource_id(Some(&marking.id))
                    .resource_name(Some(&marking.name))
                    .detail(Some(&format!(
                        "dataset '{dataset_name}': column {column_name} (demo seed)"
                    ))),
            )
            .await;
        }
        if touched {
            mf_events::publish_json_quiet(
                &state.nats,
                mf_events::subject::MARKINGS_CHANGED,
                &mf_events::MarkingsChangedEvent {
                    dataset_id: dataset_id.clone(),
                },
            )
            .await;
        }
    }

    // ── pending publish_dataset approval for Shipments ──────────────
    let (shipments_id, shipments_name) = dataset_by_name(&state, "Shipments").await?;

    let existing_pending: Option<(String,)> = sqlx::query_as(
        "SELECT id FROM approval_requests \
         WHERE kind = 'publish_dataset' AND target_id = $1 AND status = 'pending' \
         ORDER BY created_at ASC LIMIT 1",
    )
    .bind(&shipments_id)
    .fetch_optional(&state.db)
    .await?;
    match existing_pending {
        Some((id,)) => approval_ids.push(id),
        None => {
            let id = mf_db::new_id();
            sqlx::query(
                "INSERT INTO approval_requests (id, kind, target_id, version_number, target_name, requested_by, note) \
                 VALUES ($1,'publish_dataset',$2,NULL,$3,'editor',$4)",
            )
            .bind(&id)
            .bind(&shipments_id)
            .bind(&shipments_name)
            .bind("Ready for production review")
            .execute(&state.db)
            .await?;
            seeded = true;
            approval_ids.push(id.clone());
            audit_local(
                &state,
                &actor,
                AuditOptions::new("approval.request", "approval")
                    .resource_id(Some(&id))
                    .resource_name(Some(&format!("publish_dataset: {shipments_name}")))
                    .detail(Some("Ready for production review")),
            )
            .await;
        }
    }

    Ok(json_ok(serde_json::json!({
        "seeded": seeded,
        "markings": marking_names,
        "approvals": approval_ids,
    })))
}

/// (id, name) of a dataset resolved through the catalog, or the legacy 400
/// refusal when it does not exist.
async fn dataset_by_name(state: &AppState, name: &str) -> Result<(String, String), ApiError> {
    let resp = state
        .clients
        .catalog
        .get(&format!(
            "/internal/datasets/by-name/{}",
            percent_encode(name)
        ))
        .await;
    match resp {
        Ok(v) => {
            let root = v.get("dataset").filter(|d| d.is_object()).unwrap_or(&v);
            let id = root.get("id").and_then(|x| x.as_str());
            let Some(id) = id else {
                return Err(ApiError::bad_request(format!(
                    "Dataset '{name}' not found — seed demo data first (POST /api/seed)"
                )));
            };
            Ok((id.to_string(), name.to_string()))
        }
        Err(FanOutError::Api { status: 404, .. }) => Err(ApiError::bad_request(format!(
            "Dataset '{name}' not found — seed demo data first (POST /api/seed)"
        ))),
        Err(e) if e.is_transport() => {
            tracing::warn!(name, error = %e, "catalog unreachable during seed-demo");
            Err(crate::fanout::upstream_unavailable())
        }
        Err(e) => Err(pass_through(e)),
    }
}
