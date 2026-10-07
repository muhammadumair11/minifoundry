//! /api/curriculum — Phase 3 guided curriculum (port of src/lib/curriculum.ts
//! + the legacy route).
//!
//! Verification model (the teaching point — trust but verify):
//! - `auto` steps: completion is computed LIVE from the audit trail this
//!   service owns (every platform action lands in audit_entries with the
//!   actor's email — legacy `detectAutoSteps` read the exact same table).
//!   Nothing is stored: you cannot fake a step by flipping a flag.
//! - `manual` steps: persisted check-offs per actorKey (curriculum_progress).
//!
//! actorKey = session/learner email, or 'sim:<role>' for the demo simulator.
//! GET mints a `foundry-learner-id` cookie for sim actors (legacy behavior;
//! the gateway resolves that cookie to `learner:<uuid>` on later requests).

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderValue};
use axum::response::Response;
use chrono::{DateTime, Utc};
use mf_web::{actor_from_headers, json_ok, ApiError, ApiResult};
use serde_json::Value;
use std::collections::HashMap;

use crate::state::{audit_local, AppState, AuditOptions, CurriculumRow};

pub struct CurriculumStep {
    pub id: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    pub teaches: &'static str,
    pub href: &'static str,
    pub cta: &'static str,
    /// "auto" | "manual"
    pub verify: &'static str,
}

/// Exact port of CURRICULUM_STEPS (18 steps, strings byte-identical to the
/// legacy source / golden fixture).
pub const CURRICULUM_STEPS: [CurriculumStep; 18] = [
    CurriculumStep {
        id: "orient",
        title: "Orient — take the platform tour",
        description: "Skim the \"Using this app\" tab below: what each module does and how they fit together.",
        teaches: "Before touching data, know the map: ingest → store → transform → serve.",
        href: "/learn",
        cta: "Open the guide",
        verify: "manual",
    },
    CurriculumStep {
        id: "connectors",
        title: "Register a connector",
        description: "Create a connector on the Connectors page — a named, reusable source (sample, CSV/JSON upload or REST URL).",
        teaches: "Connectors decouple WHERE data comes from from HOW it is ingested.",
        href: "/connectors",
        cta: "Open connectors",
        verify: "auto",
    },
    CurriculumStep {
        id: "ingest",
        title: "Run an ingestion",
        description: "Pull data through a connector (or upload a file) until an ingestion reports success.",
        teaches: "Ingestion is a job with observable status — not a side effect of uploading.",
        href: "/connectors",
        cta: "Run an ingestion",
        verify: "auto",
    },
    CurriculumStep {
        id: "datasets",
        title: "Explore a versioned dataset",
        description: "Open a dataset in the studio: preview rows, check the inferred schema, look at its version history.",
        teaches: "Datasets are immutable: every write produces a NEW version, never an overwrite.",
        href: "/datasets",
        cta: "Open the catalog",
        verify: "auto",
    },
    CurriculumStep {
        id: "transform-write",
        title: "Write a code transform",
        description: "Create a workbook (SQL, JavaScript or Python) in Transforms that reads a dataset and outputs another.",
        teaches: "Code transforms are versioned first-class assets, like in a real code repo.",
        href: "/transforms",
        cta: "Open transforms",
        verify: "auto",
    },
    CurriculumStep {
        id: "transform-run",
        title: "Run the transform",
        description: "Execute the workbook and confirm it wrote a new dataset version from its output.",
        teaches: "Running code produces immutable outputs — same contract as visual pipelines.",
        href: "/transforms",
        cta: "Run it",
        verify: "auto",
    },
    CurriculumStep {
        id: "pipeline-build",
        title: "Build a pipeline graph",
        description: "Save a pipeline version in the visual builder (source → filter/derive → output).",
        teaches: "Pipelines are declarative DAGs; saving a version snapshots the whole graph.",
        href: "/pipelines",
        cta: "Open pipelines",
        verify: "auto",
    },
    CurriculumStep {
        id: "pipeline-run",
        title: "Run a pipeline to success",
        description: "Trigger a run and watch it go green on the Orchestration jobs table.",
        teaches: "A run records what it read and wrote — provenance is captured, not reconstructed.",
        href: "/orchestration",
        cta: "Run one",
        verify: "auto",
    },
    CurriculumStep {
        id: "schedule",
        title: "Schedule a pipeline",
        description: "Add a schedule (an interval) to a pipeline so the Bun scheduler service picks it up.",
        teaches: "Orchestration is outside the app: a separate service calls credentialed endpoints.",
        href: "/orchestration",
        cta: "Add a schedule",
        verify: "auto",
    },
    CurriculumStep {
        id: "ontology",
        title: "Register an object type",
        description: "Back an object type with a dataset in Ontology and pick its primary key.",
        teaches: "The ontology projects rows into business objects people can reason about.",
        href: "/ontology",
        cta: "Open ontology",
        verify: "auto",
    },
    CurriculumStep {
        id: "action-run",
        title: "Execute an action (write-back)",
        description: "Submit an action on an object and see the new dataset version it produced.",
        teaches: "Actions are governed writes: UI → action → new immutable version → pipelines react.",
        href: "/objects",
        cta: "Open objects",
        verify: "auto",
    },
    CurriculumStep {
        id: "dashboard",
        title: "Build a dashboard",
        description: "Add at least one widget backed by a dataset on the Dashboards page.",
        teaches: "Dashboards read the consumer pointer — the same view decisions see.",
        href: "/dashboards",
        cta: "Open dashboards",
        verify: "auto",
    },
    CurriculumStep {
        id: "column-marking",
        title: "Mark a sensitive column",
        description: "Attach a marking with a minRole to a dataset column and view it as a lower role.",
        teaches: "Governance is enforced at READ time: masking happens per viewer, per cell.",
        href: "/governance",
        cta: "Open governance",
        verify: "auto",
    },
    CurriculumStep {
        id: "quality-gate",
        title: "Publish through the quality gate",
        description: "Turn on a dataset's publication gate, ingest a draft, then publish it (see the dataset banner).",
        teaches: "Preview → validate → approve → publish: bad data never reaches consumers.",
        href: "/datasets",
        cta: "Try the gate",
        verify: "auto",
    },
    CurriculumStep {
        id: "run-replay",
        title: "Replay a run from its manifest",
        description: "Open any run's build record on Orchestration and click \"Replay from recorded inputs\".",
        teaches: "Reproducible builds: retry uses latest inputs; replay uses the RECORDED ones.",
        href: "/orchestration",
        cta: "Open jobs",
        verify: "auto",
    },
    CurriculumStep {
        id: "version-lineage",
        title: "Trace version-level lineage",
        description: "Open the lineage impact panel and follow which input versions fed an output version.",
        teaches: "Dataset-level edges say WHAT connects; version-level edges say WHEN and WITH WHAT.",
        href: "/lineage",
        cta: "Open lineage",
        verify: "auto",
    },
    CurriculumStep {
        id: "api-token",
        title: "Mint an API token",
        description: "Create a token on API Tokens and call the public API with it (see the curl snippet).",
        teaches: "Machine access is credentialed, rate-limited and logged per request.",
        href: "/api-tokens",
        cta: "Open tokens",
        verify: "auto",
    },
    CurriculumStep {
        id: "de-concepts",
        title: "Read the DE concepts",
        description: "Work through the \"DE concepts\" tab and connect each idea to the module you just used.",
        teaches: "The tooling changes; the concepts (immutability, lineage, gates) transfer.",
        href: "/learn",
        cta: "Read concepts",
        verify: "manual",
    },
];

/// One audit-trail row as seen by the auto-verifier.
#[derive(Debug, Clone)]
pub struct EvidenceEntry {
    pub action: String,
    pub detail: Option<String>,
    pub resource_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Evidence {
    pub done: bool,
    pub evidence: Option<String>,
}

impl Evidence {
    fn none() -> Self {
        Evidence {
            done: false,
            evidence: None,
        }
    }
}

/// Port of `detectAutoSteps` — first matching entry wins (entries arrive
/// newest-first, like the legacy `orderBy: createdAt desc` query).
pub fn detect_auto(entries: &[EvidenceEntry]) -> HashMap<&'static str, Evidence> {
    type DetailPredicate<'a> = &'a dyn Fn(Option<&str>) -> bool;
    fn find<'a>(
        entries: &'a [EvidenceEntry],
        actions: &[&str],
        predicate: Option<DetailPredicate<'a>>,
    ) -> Option<&'a EvidenceEntry> {
        entries.iter().find(|e| {
            actions.contains(&e.action.as_str())
                && predicate.map(|p| p(e.detail.as_deref())).unwrap_or(true)
        })
    }
    fn ev(entry: Option<&EvidenceEntry>) -> Evidence {
        match entry {
            Some(e) => Evidence {
                done: true,
                evidence: Some(format!(
                    "{}{}",
                    e.action,
                    e.resource_name
                        .as_ref()
                        .map(|n| format!(": {n}"))
                        .unwrap_or_default()
                )),
            },
            None => Evidence::none(),
        }
    }
    let contains_success =
        |d: Option<&str>| d.map(|d| d.contains("status=success")).unwrap_or(false);
    let not_failed = |d: Option<&str>| !d.map(|d| d.starts_with("FAILED")).unwrap_or(false);
    let is_replay = |d: Option<&str>| d.map(|d| d.starts_with("replay of run")).unwrap_or(false);

    let mut out = HashMap::new();
    out.insert("connectors", ev(find(entries, &["connector.create"], None)));
    out.insert("ingest", ev(find(entries, &["ingest.complete"], None)));
    out.insert("datasets", ev(find(entries, &["dataset.view"], None)));
    out.insert(
        "transform-write",
        ev(find(entries, &["transform.create"], None)),
    );
    out.insert(
        "transform-run",
        ev(find(entries, &["transform.run"], Some(&contains_success))),
    );
    out.insert(
        "pipeline-build",
        ev(find(entries, &["pipeline.create", "pipeline.update"], None)),
    );
    out.insert(
        "pipeline-run",
        ev(find(entries, &["pipeline.run"], Some(&contains_success))),
    );
    out.insert("schedule", ev(find(entries, &["schedule.create"], None)));
    out.insert("ontology", ev(find(entries, &["ontology.create"], None)));
    out.insert(
        "action-run",
        ev(find(entries, &["action.apply"], Some(&not_failed))),
    );
    out.insert(
        "dashboard",
        ev(find(
            entries,
            &["dashboard.create", "dashboard.update"],
            None,
        )),
    );
    out.insert(
        "column-marking",
        ev(find(entries, &["marking.attach"], None)),
    );
    out.insert(
        "quality-gate",
        ev(find(entries, &["dataset.publish"], None)),
    );
    out.insert(
        "run-replay",
        ev(find(entries, &["pipeline.run"], Some(&is_replay))),
    );
    out.insert(
        "version-lineage",
        ev(find(entries, &["lineage.version.view"], None)),
    );
    out.insert("api-token", ev(find(entries, &["apiToken.create"], None)));
    out
}

/// Pure port of the merge + counters + 'Up next' pick in
/// `getCurriculumStatus` (manual = stepId → completedAt).
pub fn build_status(
    auto: &HashMap<&'static str, Evidence>,
    manual: &HashMap<String, DateTime<Utc>>,
) -> Value {
    let mut steps: Vec<Value> = Vec::with_capacity(CURRICULUM_STEPS.len());
    let mut completed = 0usize;
    let mut first_incomplete: Option<&'static str> = None;
    let mut first_incomplete_auto: Option<&'static str> = None;

    for step in CURRICULUM_STEPS.iter() {
        let (done, evidence, source, completed_at) = if step.verify == "auto" {
            let e = auto.get(step.id).cloned().unwrap_or_else(Evidence::none);
            let done = e.done;
            (
                done,
                if done { e.evidence } else { None },
                if done { Some("auto") } else { None },
                None,
            )
        } else {
            match manual.get(step.id) {
                Some(ts) => (
                    true,
                    Some("checked off by you".to_string()),
                    Some("manual"),
                    Some(mf_types::ts::format(ts)),
                ),
                None => (false, None, None, None),
            }
        };
        if done {
            completed += 1;
        } else {
            if first_incomplete.is_none() {
                first_incomplete = Some(step.id);
            }
            if step.verify == "auto" && first_incomplete_auto.is_none() {
                first_incomplete_auto = Some(step.id);
            }
        }
        steps.push(serde_json::json!({
            "id": step.id,
            "title": step.title,
            "description": step.description,
            "teaches": step.teaches,
            "href": step.href,
            "cta": step.cta,
            "verify": step.verify,
            "done": done,
            "evidence": evidence,
            "source": source,
            "completedAt": completed_at,
        }));
    }

    let total = CURRICULUM_STEPS.len();
    let percent = if total > 0 {
        ((completed as f64 / total as f64) * 100.0).round() as i64
    } else {
        0
    };

    // 'Up next' pick (legacy):
    //   1. brand-new user (0%) starts with the tour ('orient');
    //   2. otherwise the first incomplete AUTO step wins (a stale manual
    //      check-off must not hijack the pointer);
    //   3. only when every auto step is done do manual steps surface.
    let next = if completed == 0 && first_incomplete == Some("orient") {
        first_incomplete
    } else {
        first_incomplete_auto.or(first_incomplete)
    };

    serde_json::json!({
        "steps": steps,
        "completed": completed,
        "total": total,
        "percent": percent,
        "nextStepId": next,
    })
}

/// Full curriculum status for an actor (DB orchestration around the pure
/// builders above). Enrollment ('__started__') is upserted first so auto
/// evidence only counts actions AFTER the actor's first status read.
pub async fn get_curriculum_status(state: &AppState, actor_key: &str) -> Result<Value, ApiError> {
    let enrolled_at: DateTime<Utc> = sqlx::query_scalar(
        "INSERT INTO curriculum_progress (id, actor_key, step_id, source) \
         VALUES ($1, $2, '__started__', 'system') \
         ON CONFLICT (actor_key, step_id) DO UPDATE SET step_id = EXCLUDED.step_id \
         RETURNING completed_at",
    )
    .bind(mf_db::new_id())
    .bind(actor_key)
    .fetch_one(&state.db)
    .await?;

    let entries: Vec<crate::state::AuditEvidenceRow> = sqlx::query_as(
        "SELECT action, detail, resource_name FROM audit_entries \
         WHERE actor_email = $1 AND created_at >= $2 ORDER BY created_at DESC",
    )
    .bind(actor_key)
    .bind(enrolled_at)
    .fetch_all(&state.db)
    .await
    .map_err(|e| {
        tracing::warn!(error = %e, "curriculum auto-detection failed; degrading to empty");
        ApiError::internal(e.to_string())
    })
    .unwrap_or_default();
    let evidence_entries: Vec<EvidenceEntry> = entries
        .into_iter()
        .map(|r| EvidenceEntry {
            action: r.action,
            detail: r.detail,
            resource_name: r.resource_name,
        })
        .collect();
    let auto = detect_auto(&evidence_entries);

    let rows: Vec<CurriculumRow> = sqlx::query_as(
        "SELECT step_id, completed_at FROM curriculum_progress WHERE actor_key = $1",
    )
    .bind(actor_key)
    .fetch_all(&state.db)
    .await?;
    let manual: HashMap<String, DateTime<Utc>> = rows
        .into_iter()
        .map(|r| (r.step_id, r.completed_at))
        .collect();

    Ok(build_status(&auto, &manual))
}

/// actorKey = session email or 'sim:<role>' (legacy actorKeyOf).
fn actor_key_of(actor: &mf_auth::Actor) -> String {
    actor
        .email
        .clone()
        .unwrap_or_else(|| format!("sim:{}", actor.role))
}

/// GET /api/curriculum — sim actors get a fresh learner identity + cookie
/// (exactly like the legacy route's randomUUID branch).
pub async fn get_curriculum(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    let actor_key = actor_key_of(&actor);

    if actor_key.starts_with("sim:") {
        let learner_id = uuid::Uuid::new_v4().to_string();
        let status = get_curriculum_status(&state, &format!("learner:{learner_id}")).await?;
        let mut resp = json_ok(status);
        let cookie = mf_web::cookie::CookieSpec {
            name: mf_auth::LEARNER_COOKIE,
            value: learner_id,
            http_only: true,
            same_site: "Lax",
            path: "/",
            max_age: 60 * 60 * 24 * 365,
            secure: state.cookie_secure,
        };
        if let Ok(v) = HeaderValue::from_str(&cookie.to_header()) {
            resp.headers_mut().append(header::SET_COOKIE, v);
        }
        return Ok(resp);
    }

    Ok(json_ok(get_curriculum_status(&state, &actor_key).await?))
}

/// POST /api/curriculum — toggle a MANUAL step's check-off { stepId, done }.
pub async fn post_curriculum(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    let v = crate::routes::parse_body_or_null(&body);
    let m = crate::routes::as_object(v)?;
    let step_id =
        crate::routes::req_str_min1(&m, "stepId", "Too small: expected string to have >=1 chars")?;
    let done = crate::routes::req_bool(&m, "done")?;

    let Some(step) = CURRICULUM_STEPS.iter().find(|s| s.id == step_id) else {
        return Err(ApiError::bad_request(format!("unknown step '{step_id}'")));
    };
    if step.verify != "manual" {
        return Err(ApiError::bad_request(format!(
            "'{}' is auto-verified from real platform state — do the action on {} to complete it",
            step.id, step.href
        )));
    }

    let actor_key = actor_key_of(&actor);
    if done {
        sqlx::query(
            "INSERT INTO curriculum_progress (id, actor_key, step_id, source) \
             VALUES ($1, $2, $3, 'manual') ON CONFLICT (actor_key, step_id) DO NOTHING",
        )
        .bind(mf_db::new_id())
        .bind(&actor_key)
        .bind(step.id)
        .execute(&state.db)
        .await?;
    } else {
        sqlx::query("DELETE FROM curriculum_progress WHERE actor_key = $1 AND step_id = $2")
            .bind(&actor_key)
            .bind(step.id)
            .execute(&state.db)
            .await?;
    }

    audit_local(
        &state,
        &actor,
        AuditOptions::new(
            if done {
                "curriculum.step_complete"
            } else {
                "curriculum.step_uncheck"
            },
            "curriculum",
        )
        .resource_id(Some(step.id))
        .resource_name(Some(step.title))
        .detail(Some(&format!(
            "manual check-off {} for {actor_key}",
            if done { "set" } else { "cleared" }
        ))),
    )
    .await;

    Ok(json_ok(get_curriculum_status(&state, &actor_key).await?))
}

/// DELETE /api/curriculum — reset the caller's manual progress (incl. the
/// enrollment marker, exactly like the legacy deleteMany).
pub async fn delete_curriculum(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    let actor_key = actor_key_of(&actor);
    let removed = sqlx::query("DELETE FROM curriculum_progress WHERE actor_key = $1")
        .bind(&actor_key)
        .execute(&state.db)
        .await?
        .rows_affected();

    audit_local(
        &state,
        &actor,
        AuditOptions::new("curriculum.reset", "curriculum").detail(Some(&format!(
            "{removed} manual check-off(s) cleared for {actor_key}"
        ))),
    )
    .await;

    Ok(json_ok(get_curriculum_status(&state, &actor_key).await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(action: &str, detail: Option<&str>, name: Option<&str>) -> EvidenceEntry {
        EvidenceEntry {
            action: action.to_string(),
            detail: detail.map(String::from),
            resource_name: name.map(String::from),
        }
    }

    #[test]
    fn steps_table_matches_contract() {
        assert_eq!(CURRICULUM_STEPS.len(), 18);
        assert_eq!(CURRICULUM_STEPS[0].id, "orient");
        assert_eq!(CURRICULUM_STEPS[17].id, "de-concepts");
        let manual: Vec<_> = CURRICULUM_STEPS
            .iter()
            .filter(|s| s.verify == "manual")
            .map(|s| s.id)
            .collect();
        assert_eq!(manual, vec!["orient", "de-concepts"]);
    }

    #[test]
    fn auto_detection_rules() {
        let entries = vec![
            entry(
                "pipeline.run",
                Some("replay of run abc status=success"),
                Some("P"),
            ),
            entry("pipeline.run", Some("status=success"), Some("P")),
            entry("action.apply", Some("FAILED: boom"), None),
            entry("apiToken.create", None, Some("tok")),
            entry("dataset.view", None, Some("Supplier Risk Scores")),
        ];
        let auto = detect_auto(&entries);
        assert!(auto["pipeline-run"].done);
        assert_eq!(
            auto["pipeline-run"].evidence.as_deref(),
            Some("pipeline.run: P")
        );
        // replay predicate: first entry (newest) starts with 'replay of run'
        assert!(auto["run-replay"].done);
        // FAILED action.apply does not count
        assert!(!auto["action-run"].done);
        assert!(auto["api-token"].done);
        assert_eq!(
            auto["api-token"].evidence.as_deref(),
            Some("apiToken.create: tok")
        );
        assert_eq!(
            auto["datasets"].evidence.as_deref(),
            Some("dataset.view: Supplier Risk Scores")
        );
        assert!(!auto["connectors"].done);
    }

    #[test]
    fn action_apply_null_detail_passes() {
        // legacy predicate: (detail) => !detail?.startsWith('FAILED')
        let auto = detect_auto(&[entry("action.apply", None, Some("Update Order Status"))]);
        assert!(auto["action-run"].done);
        assert_eq!(
            auto["action-run"].evidence.as_deref(),
            Some("action.apply: Update Order Status")
        );
    }

    #[test]
    fn fresh_actor_next_step_is_orient() {
        let status = build_status(&HashMap::new(), &HashMap::new());
        assert_eq!(status["completed"], 0);
        assert_eq!(status["total"], 18);
        assert_eq!(status["percent"], 0);
        assert_eq!(status["nextStepId"], "orient");
        assert_eq!(status["steps"][0]["done"], false);
        assert_eq!(status["steps"][0]["evidence"], Value::Null);
        assert_eq!(status["steps"][0]["source"], Value::Null);
        assert_eq!(status["steps"][0]["completedAt"], Value::Null);
    }

    #[test]
    fn stale_manual_checkoff_does_not_hijack_pointer() {
        // 'orient' checked but auto steps pending → next is the first
        // incomplete AUTO step ('connectors'), not 'de-concepts'/'orient'.
        let mut manual = HashMap::new();
        manual.insert("orient".to_string(), Utc::now());
        let status = build_status(&HashMap::new(), &manual);
        assert_eq!(status["completed"], 1);
        assert_eq!(status["nextStepId"], "connectors");
        // manual step serialization
        let orient = &status["steps"][0];
        assert_eq!(orient["done"], true);
        assert_eq!(orient["evidence"], "checked off by you");
        assert_eq!(orient["source"], "manual");
        assert!(orient["completedAt"].as_str().unwrap().ends_with('Z'));
    }

    #[test]
    fn all_auto_done_surfaces_manual_next() {
        let mut auto = HashMap::new();
        for step in CURRICULUM_STEPS.iter().filter(|s| s.verify == "auto") {
            auto.insert(
                step.id,
                Evidence {
                    done: true,
                    evidence: Some(format!("{}: x", step.id)),
                },
            );
        }
        let status = build_status(&auto, &HashMap::new());
        // 16 auto done, orient + de-concepts pending → next = 'orient'
        // (first incomplete, since no incomplete AUTO step remains)
        assert_eq!(status["completed"], 16);
        assert_eq!(status["percent"], 89);
        assert_eq!(status["nextStepId"], "orient");
    }

    #[test]
    fn everything_done_clears_pointer() {
        let mut auto = HashMap::new();
        for step in CURRICULUM_STEPS.iter().filter(|s| s.verify == "auto") {
            auto.insert(
                step.id,
                Evidence {
                    done: true,
                    evidence: Some("e".into()),
                },
            );
        }
        let mut manual = HashMap::new();
        manual.insert("orient".to_string(), Utc::now());
        manual.insert("de-concepts".to_string(), Utc::now());
        let status = build_status(&auto, &manual);
        assert_eq!(status["completed"], 18);
        assert_eq!(status["percent"], 100);
        assert_eq!(status["nextStepId"], Value::Null);
    }

    #[test]
    fn fixture_scenario_percent_and_next() {
        // Golden fixture: datasets/transform-run/ontology/action-run/api-token
        // done → completed 5, percent 28, next 'connectors'.
        let mut auto = HashMap::new();
        for id in [
            "datasets",
            "transform-run",
            "ontology",
            "action-run",
            "api-token",
        ] {
            auto.insert(
                id,
                Evidence {
                    done: true,
                    evidence: Some("e".into()),
                },
            );
        }
        let status = build_status(&auto, &HashMap::new());
        assert_eq!(status["completed"], 5);
        assert_eq!(status["percent"], 28);
        assert_eq!(status["nextStepId"], "connectors");
    }
}
