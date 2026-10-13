//! /api/projects — platform projects/spaces (ports projects/route.ts +
//! projects/[id]/route.ts).

use axum::body::Bytes;
use axum::extract::Path;
use axum::http::HeaderMap;
use axum::response::Response;
use mf_web::TenantState as State;
use mf_web::{actor_from_headers, json_created, json_ok, require_role, ApiError, ApiResult};
use serde_json::json;

use crate::audit::{audit, AuditOptions};
use crate::state::{AppState, ProjectRow, PROJECT_COLS};
use crate::validate::{as_object, opt_str_nullish, parse_body, req_str_min1_custom, Nullish};

/// Pipeline counts per project — best-effort from orchestration's internal
/// list (pipelines live in the orchestration service now; when it is
/// unreachable or its list carries no projectId the count is 0, which is what
/// the golden fixture shows for projects without pipelines).
async fn pipelines_count_by_project(state: &AppState) -> std::collections::HashMap<String, i64> {
    let mut counts: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    if let Ok(v) = state
        .orchestration
        .get_json::<serde_json::Value>("/internal/pipelines")
        .await
    {
        if let Some(list) = v.get("pipelines").and_then(|p| p.as_array()) {
            for p in list {
                if let Some(pid) = p.get("projectId").and_then(|x| x.as_str()) {
                    *counts.entry(pid.to_string()).or_insert(0) += 1;
                }
            }
        }
    }
    counts
}

async fn datasets_count_by_project(
    pool: &sqlx::PgPool,
) -> Result<std::collections::HashMap<String, i64>, sqlx::Error> {
    let rows: Vec<(Option<String>, i64)> =
        sqlx::query_as("SELECT project_id, count(*) FROM datasets GROUP BY project_id")
            .fetch_all(pool)
            .await?;
    let mut out = std::collections::HashMap::new();
    for (pid, n) in rows {
        if let Some(pid) = pid {
            out.insert(pid, n);
        }
    }
    Ok(out)
}

/// GET /api/projects — createdAt asc with datasets/pipelines counts.
pub async fn list_projects(State(state): State<AppState>) -> ApiResult<Response> {
    let projects: Vec<ProjectRow> = sqlx::query_as(&format!(
        "SELECT {PROJECT_COLS} FROM projects ORDER BY created_at ASC, id ASC"
    ))
    .fetch_all(&state.db)
    .await?;
    let dataset_counts = datasets_count_by_project(&state.db).await?;
    let pipeline_counts = pipelines_count_by_project(&state).await;

    let out: Vec<serde_json::Value> = projects
        .iter()
        .map(|p| {
            json!({
                "id": p.id,
                "name": p.name,
                "description": p.description,
                "createdAt": crate::state::ts(&p.created_at),
                "updatedAt": crate::state::ts(&p.updated_at),
                "datasetsCount": dataset_counts.get(&p.id).copied().unwrap_or(0),
                "pipelinesCount": pipeline_counts.get(&p.id).copied().unwrap_or(0),
            })
        })
        .collect();
    Ok(json_ok(json!({ "projects": out })))
}

/// POST /api/projects — editor+; returns the full project row (201), no audit
/// (legacy create was not audited).
pub async fn create_project(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;

    let v = parse_body(&body)?;
    let m = as_object(v)?;
    let name = req_str_min1_custom(&m, "name", "name is required")?;
    let description = match opt_str_nullish(&m, "description")? {
        Nullish::Value(s) => Some(s.to_string()),
        _ => None,
    };

    let project: ProjectRow = sqlx::query_as(&format!(
        "INSERT INTO projects (id, name, description) VALUES ($1, $2, $3) RETURNING {PROJECT_COLS}"
    ))
    .bind(mf_db::new_id())
    .bind(name)
    .bind(description.as_deref())
    .fetch_one(&state.db)
    .await?;

    Ok(json_created(json!({
        "project": {
            "id": project.id,
            "name": project.name,
            "description": project.description,
            "createdAt": crate::state::ts(&project.created_at),
            "updatedAt": crate::state::ts(&project.updated_at),
        }
    })))
}

/// PATCH /api/projects/{id} — editor+; { project } WITHOUT timestamps
/// (legacy serializeProject shape).
pub async fn update_project(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;

    let v = parse_body(&body)?;
    let m = as_object(v)?;
    let name = match m.get("name") {
        None => None,
        Some(_) => Some(req_str_min1_custom(&m, "name", "name is required")?.to_string()),
    };
    let description = opt_str_nullish(&m, "description")?;

    let existing: Option<(String, String)> =
        sqlx::query_as("SELECT id, name FROM projects WHERE id = $1")
            .bind(&id)
            .fetch_optional(&state.db)
            .await?;
    let Some((existing_id, existing_name)) = existing else {
        return Err(ApiError::not_found(format!("Project '{id}' not found")));
    };

    let new_name = name.clone().unwrap_or(existing_name.clone());
    sqlx::query(
        "UPDATE projects SET name = $2, \
         description = CASE WHEN $3::boolean THEN $4 ELSE description END, \
         updated_at = now() \
         WHERE id = $1",
    )
    .bind(&id)
    .bind(&new_name)
    .bind(!matches!(description, Nullish::Absent))
    .bind(match description {
        Nullish::Value(s) => Some(s.to_string()),
        _ => None,
    })
    .execute(&state.db)
    .await?;

    audit(
        &state,
        &actor,
        AuditOptions::new("project.update", "project")
            .resource_id(Some(&existing_id))
            .resource_name(Some(name.as_deref().unwrap_or(&existing_name))),
    )
    .await;

    // serializeProject: counts, no timestamps.
    let datasets_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM datasets WHERE project_id = $1")
            .bind(&id)
            .fetch_one(&state.db)
            .await?;
    let pipelines_count = pipelines_count_by_project(&state)
        .await
        .get(&id)
        .copied()
        .unwrap_or(0);
    let project: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT name, description FROM projects WHERE id = $1")
            .bind(&id)
            .fetch_optional(&state.db)
            .await?;
    let Some((pname, pdesc)) = project else {
        return Ok(json_ok(json!({ "project": null })));
    };
    Ok(json_ok(json!({
        "project": {
            "id": id,
            "name": pname,
            "description": pdesc,
            "datasetsCount": datasets_count,
            "pipelinesCount": pipelines_count,
        }
    })))
}

/// DELETE /api/projects/{id} — editor+; detaches datasets (projectId → null)
/// then deletes. (Legacy also detached pipelines — orchestration owns those
/// now; FK-free projectId there is cleaned by orchestration's own logic.)
pub async fn delete_project(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;

    let existing: Option<(String, String)> =
        sqlx::query_as("SELECT id, name FROM projects WHERE id = $1")
            .bind(&id)
            .fetch_optional(&state.db)
            .await?;
    let Some((existing_id, existing_name)) = existing else {
        return Err(ApiError::not_found(format!("Project '{id}' not found")));
    };

    sqlx::query("UPDATE datasets SET project_id = NULL, updated_at = now() WHERE project_id = $1")
        .bind(&id)
        .execute(&state.db)
        .await?;
    sqlx::query("DELETE FROM projects WHERE id = $1")
        .bind(&id)
        .execute(&state.db)
        .await?;

    audit(
        &state,
        &actor,
        AuditOptions::new("project.delete", "project")
            .resource_id(Some(&existing_id))
            .resource_name(Some(&existing_name)),
    )
    .await;

    Ok(json_ok(json!({ "ok": true })))
}
