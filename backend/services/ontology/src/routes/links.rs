//! /api/ontology/links — link type CRUD (ports of ontology/links/route.ts and
//! [id]/route.ts + src/lib/ontology-link-config.ts validation).

use axum::body::Bytes;
use axum::extract::Path;
use axum::http::HeaderMap;
use axum::response::Response;
use mf_types::Value;
use mf_web::TenantState as State;
use mf_web::{
    actor_from_headers, json_created, json_ok, no_content, require_role, ApiError, ApiResult,
};

use crate::dbx;
use crate::jsonutil::{as_object, check_max_len, check_regex, enum_or_err, kind_of, parse_body};
use crate::links::effective_fk_side;
use crate::serialize::slug_re;
use crate::state::*;

const CARDINALITIES: [&str; 4] = ["one-to-one", "one-to-many", "many-to-one", "many-to-many"];
const FK_SIDES: [&str; 2] = ["from", "to"];

/// Validated link config input (port of linkConfigSchema).
struct LinkConfigInput {
    display_name: String,
    api_name: String,
    from_type_id: String,
    to_type_id: String,
    cardinality: String,
    fk_property: Option<String>,
    fk_side: Option<String>,
    link_dataset_id: Option<String>,
    from_key_column: Option<String>,
    to_key_column: Option<String>,
}

fn min1_nullish(
    m: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<Option<String>, ApiError> {
    // z.string().min(1).nullish()
    match m.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => {
            if s.is_empty() {
                return Err(ApiError::bad_request(format!(
                    "{field}: Too small: expected string to have >=1 chars"
                )));
            }
            Ok(Some(s.clone()))
        }
        Some(other) => Err(ApiError::bad_request(format!(
            "{field}: Invalid input: expected string, received {}",
            kind_of(other)
        ))),
    }
}

fn parse_link_config(m: &serde_json::Map<String, Value>) -> Result<LinkConfigInput, ApiError> {
    // displayName: z.string().trim().min(1).max(120)
    let display_name = match m.get("displayName").and_then(|v| v.as_str()) {
        Some(s) if !s.trim().is_empty() => {
            let t = s.trim().to_string();
            check_max_len("displayName", &t, 120)?;
            t
        }
        Some(_) => {
            return Err(ApiError::bad_request(
                "displayName: Too small: expected string to have >=1 chars",
            ))
        }
        None => {
            return Err(ApiError::bad_request(
                "displayName: Invalid input: expected string, received undefined",
            ))
        }
    };
    // apiName: slug regex with its own message
    let api_name = match m.get("apiName").and_then(|v| v.as_str()) {
        Some(s) => {
            check_regex(
                "apiName",
                s,
                slug_re(),
                "Use a lowercase slug starting with a letter",
            )?;
            s.to_string()
        }
        None => {
            return Err(ApiError::bad_request(
                "apiName: Invalid input: expected string, received undefined",
            ))
        }
    };
    let from_type_id = match m.get("fromTypeId").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => s.to_string(),
        Some(_) => {
            return Err(ApiError::bad_request(
                "fromTypeId: Too small: expected string to have >=1 chars",
            ))
        }
        None => {
            return Err(ApiError::bad_request(
                "fromTypeId: Invalid input: expected string, received undefined",
            ))
        }
    };
    let to_type_id = match m.get("toTypeId").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => s.to_string(),
        Some(_) => {
            return Err(ApiError::bad_request(
                "toTypeId: Too small: expected string to have >=1 chars",
            ))
        }
        None => {
            return Err(ApiError::bad_request(
                "toTypeId: Invalid input: expected string, received undefined",
            ))
        }
    };
    let cardinality = match m.get("cardinality").and_then(|v| v.as_str()) {
        Some(s) => enum_or_err(s, "cardinality", &CARDINALITIES)?.to_string(),
        None => {
            return Err(ApiError::bad_request(
                "cardinality: Invalid input: expected string, received undefined",
            ))
        }
    };
    let fk_property = min1_nullish(m, "fkProperty")?;
    let fk_side = match m.get("fkSide") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(enum_or_err(s, "fkSide", &FK_SIDES)?.to_string()),
        Some(other) => {
            return Err(ApiError::bad_request(format!(
                "fkSide: Invalid input: expected string, received {}",
                kind_of(other)
            )))
        }
    };
    let link_dataset_id = min1_nullish(m, "linkDatasetId")?;
    let from_key_column = min1_nullish(m, "fromKeyColumn")?;
    let to_key_column = min1_nullish(m, "toKeyColumn")?;

    Ok(LinkConfigInput {
        display_name,
        api_name,
        from_type_id,
        to_type_id,
        cardinality,
        fk_property,
        fk_side,
        link_dataset_id,
        from_key_column,
        to_key_column,
    })
}

/// Check mappings against the CURRENT consumer-visible dataset schemas
/// (port of validateLinkConfig). Err carries the exact legacy message.
async fn validate_link_config(state: &AppState, input: &LinkConfigInput) -> Result<(), ApiError> {
    let bad = |m: String| ApiError::bad_request(m);

    let from = dbx::object_type_by_id(&state.db, &input.from_type_id).await?;
    let to = dbx::object_type_by_id(&state.db, &input.to_type_id).await?;
    let (Some(from), Some(to)) = (from, to) else {
        return Err(bad("Select two existing object types".into()));
    };
    let (Some(from_ds), Some(from_pk)) = (from.source_dataset_id.clone(), from.primary_key.clone())
    else {
        return Err(bad(
            "Both object types need a backing dataset and primary key".into(),
        ));
    };
    let (Some(to_ds), Some(to_pk)) = (to.source_dataset_id.clone(), to.primary_key.clone()) else {
        return Err(bad(
            "Both object types need a backing dataset and primary key".into(),
        ));
    };

    if input.cardinality == "many-to-many" {
        let (Some(link_ds), Some(from_col), Some(to_col)) = (
            input.link_dataset_id.clone(),
            input.from_key_column.clone(),
            input.to_key_column.clone(),
        ) else {
            return Err(bad(
                "Select a relationship dataset and both key columns".into()
            ));
        };
        if from_col == to_col {
            return Err(bad("Select two different relationship key columns".into()));
        }
        // schemas
        let Some(link_schema) = schema_of(state, &link_ds).await? else {
            return Err(bad("Relationship dataset not found".into()));
        };
        let from_schema = schema_of(state, &from_ds).await?.unwrap_or_default();
        let to_schema = schema_of(state, &to_ds).await?.unwrap_or_default();
        if !from_schema.iter().any(|c| c.name == from_pk) {
            return Err(bad(format!(
                "{} primary key is missing from its consumer-visible dataset schema",
                from.display_name
            )));
        }
        if !to_schema.iter().any(|c| c.name == to_pk) {
            return Err(bad(format!(
                "{} primary key is missing from its consumer-visible dataset schema",
                to.display_name
            )));
        }
        let col_type = |schema: &[mf_types::SchemaColumn], name: &str| {
            schema
                .iter()
                .find(|c| c.name == name)
                .map(|c| format!("{:?}", c.column_type))
        };
        if !link_schema.iter().any(|c| c.name == from_col) {
            return Err(bad(format!(
                "Relationship column '{from_col}' does not exist"
            )));
        }
        if !link_schema.iter().any(|c| c.name == to_col) {
            return Err(bad(format!(
                "Relationship column '{to_col}' does not exist"
            )));
        }
        if col_type(&link_schema, &from_col) != col_type(&from_schema, &from_pk) {
            return Err(bad(format!(
                "Relationship column '{from_col}' must match {}'s primary key type",
                from.display_name
            )));
        }
        if col_type(&link_schema, &to_col) != col_type(&to_schema, &to_pk) {
            return Err(bad(format!(
                "Relationship column '{to_col}' must match {}'s primary key type",
                to.display_name
            )));
        }
        return Ok(());
    }

    // non-m2m
    let Some(fk) = input.fk_property.clone() else {
        return Err(bad("Select a foreign key column".into()));
    };
    let side = effective_fk_side(&input.cardinality, input.fk_side.as_deref());
    if input.cardinality == "one-to-many" && side != "to" {
        return Err(bad(
            "One to many requires a foreign key on the target type".into()
        ));
    }
    if input.cardinality == "many-to-one" && side != "from" {
        return Err(bad(
            "Many to one requires a foreign key on the source type".into()
        ));
    }

    let from_schema = schema_of(state, &from_ds).await?;
    let to_schema = schema_of(state, &to_ds).await?;
    let (from_schema, to_schema) = (
        from_schema.unwrap_or_default(),
        to_schema.unwrap_or_default(),
    );
    if !from_schema.iter().any(|c| c.name == from_pk) {
        return Err(bad(format!(
            "{} primary key is missing from its consumer-visible dataset schema",
            from.display_name
        )));
    }
    if !to_schema.iter().any(|c| c.name == to_pk) {
        return Err(bad(format!(
            "{} primary key is missing from its consumer-visible dataset schema",
            to.display_name
        )));
    }
    let (holder, referenced, holder_schema, holder_ds) = if side == "from" {
        (&from, &to, &from_schema, &from_ds)
    } else {
        (&to, &from, &to_schema, &to_ds)
    };
    let _ = holder_ds;
    let col_type = |schema: &[mf_types::SchemaColumn], name: &str| {
        schema
            .iter()
            .find(|c| c.name == name)
            .map(|c| format!("{:?}", c.column_type))
    };
    if !holder_schema.iter().any(|c| c.name == fk) {
        return Err(bad(format!(
            "Column '{fk}' is missing from {}'s consumer-visible dataset schema",
            holder.display_name
        )));
    }
    let referenced_schema = if side == "from" {
        &to_schema
    } else {
        &from_schema
    };
    let referenced_pk = if side == "from" { &to_pk } else { &from_pk };
    if col_type(holder_schema, &fk) != col_type(referenced_schema, referenced_pk) {
        return Err(bad(format!(
            "{}.{fk} and {}.{referenced_pk} must have the same data type",
            holder.display_name, referenced.display_name
        )));
    }
    Ok(())
}

async fn schema_of(
    state: &AppState,
    dataset_id: &str,
) -> Result<Option<Vec<mf_types::SchemaColumn>>, ApiError> {
    Ok(state
        .catalog
        .head_version(dataset_id)
        .await?
        .map(|v| v.schema))
}

/// normalizedLinkConfig output columns: (fk_property, fk_side,
/// link_dataset_id, from_key_column, to_key_column).
type NormalizedLinkCols = (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

/// normalizedLinkConfig — m2m keeps only the mapping columns; other
/// cardinalities keep fkProperty + effective fkSide.
fn normalized_values(input: &LinkConfigInput) -> NormalizedLinkCols {
    let m2m = input.cardinality == "many-to-many";
    (
        if m2m { None } else { input.fk_property.clone() },
        if m2m {
            None
        } else {
            Some(effective_fk_side(&input.cardinality, input.fk_side.as_deref()).to_string())
        },
        if m2m {
            input.link_dataset_id.clone()
        } else {
            None
        },
        if m2m {
            input.from_key_column.clone()
        } else {
            None
        },
        if m2m {
            input.to_key_column.clone()
        } else {
            None
        },
    )
}

/// The legacy response serializes the raw LinkType row (Prisma field order).
fn serialize_link(l: &LinkTypeRow) -> Value {
    serde_json::json!({
        "id": l.id,
        "apiName": l.api_name,
        "displayName": l.display_name,
        "fromTypeId": l.from_type_id,
        "toTypeId": l.to_type_id,
        "cardinality": l.cardinality,
        "fkProperty": l.fk_property,
        "fkSide": l.fk_side,
        "linkDatasetId": l.link_dataset_id,
        "fromKeyColumn": l.from_key_column,
        "toKeyColumn": l.to_key_column,
        "createdAt": mf_types::ts::format(&l.created_at),
    })
}

async fn fetch_link(db: &sqlx::PgPool, id: &str) -> Result<Option<LinkTypeRow>, ApiError> {
    let q = format!("SELECT {LINK_COLS} FROM link_types WHERE id = $1");
    Ok(sqlx::query_as::<_, LinkTypeRow>(&q)
        .bind(id)
        .fetch_optional(db)
        .await?)
}

/// POST /api/ontology/links — create (editor+).
pub async fn create_link(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;

    let v = parse_body(&body)?;
    let m = as_object(v)?;
    let input = parse_link_config(&m)?;
    validate_link_config(&state, &input).await?;

    let taken: Option<(String,)> =
        sqlx::query_as("SELECT id FROM link_types WHERE from_type_id = $1 AND api_name = $2")
            .bind(&input.from_type_id)
            .bind(&input.api_name)
            .fetch_optional(&state.db)
            .await?;
    if taken.is_some() {
        return Err(ApiError::bad_request(format!(
            "Link API name '{}' already exists on this source type",
            input.api_name
        )));
    }

    let (fk_property, fk_side, link_dataset_id, from_key_column, to_key_column) =
        normalized_values(&input);
    let id = mf_db::new_id();
    sqlx::query(
        "INSERT INTO link_types (id, api_name, display_name, from_type_id, to_type_id, \
         cardinality, fk_property, fk_side, link_dataset_id, from_key_column, to_key_column) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
    )
    .bind(&id)
    .bind(&input.api_name)
    .bind(&input.display_name)
    .bind(&input.from_type_id)
    .bind(&input.to_type_id)
    .bind(&input.cardinality)
    .bind(&fk_property)
    .bind(&fk_side)
    .bind(&link_dataset_id)
    .bind(&from_key_column)
    .bind(&to_key_column)
    .execute(&state.db)
    .await?;

    let link = fetch_link(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::internal("link vanished after create"))?;

    crate::audit::audit(
        &state,
        &actor,
        crate::audit::AuditOptions::new("ontology.link.create", "ontology")
            .resource_id(Some(&link.id))
            .resource_name(Some(&link.display_name))
            .detail(Some(&format!(
                "{} -> {}",
                link.from_type_id, link.to_type_id
            ))),
    )
    .await;

    Ok(json_created(
        serde_json::json!({ "link": serialize_link(&link) }),
    ))
}

/// PATCH /api/ontology/links/{id} — full-config update (editor+).
pub async fn update_link(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;

    let Some(_existing) = fetch_link(&state.db, &id).await? else {
        return Err(ApiError::not_found(format!("Link '{id}' not found")));
    };
    let v = parse_body(&body)?;
    let m = as_object(v)?;
    let input = parse_link_config(&m)?;
    validate_link_config(&state, &input).await?;

    let taken: Option<LinkTypeRow> = sqlx::query_as(&format!(
        "SELECT {LINK_COLS} FROM link_types WHERE from_type_id = $1 AND api_name = $2"
    ))
    .bind(&input.from_type_id)
    .bind(&input.api_name)
    .fetch_optional(&state.db)
    .await?;
    if taken.is_some_and(|t| t.id != id) {
        return Err(ApiError::bad_request(format!(
            "Link API name '{}' already exists on this source type",
            input.api_name
        )));
    }

    let (fk_property, fk_side, link_dataset_id, from_key_column, to_key_column) =
        normalized_values(&input);
    sqlx::query(
        "UPDATE link_types SET api_name = $1, display_name = $2, from_type_id = $3, \
         to_type_id = $4, cardinality = $5, fk_property = $6, fk_side = $7, \
         link_dataset_id = $8, from_key_column = $9, to_key_column = $10 WHERE id = $11",
    )
    .bind(&input.api_name)
    .bind(&input.display_name)
    .bind(&input.from_type_id)
    .bind(&input.to_type_id)
    .bind(&input.cardinality)
    .bind(&fk_property)
    .bind(&fk_side)
    .bind(&link_dataset_id)
    .bind(&from_key_column)
    .bind(&to_key_column)
    .bind(&id)
    .execute(&state.db)
    .await?;

    let link = fetch_link(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::internal("link vanished after update"))?;
    crate::audit::audit(
        &state,
        &actor,
        crate::audit::AuditOptions::new("ontology.link.update", "ontology")
            .resource_id(Some(&id))
            .resource_name(Some(&link.display_name))
            .detail(Some(&format!(
                "{} -> {}",
                link.from_type_id, link.to_type_id
            ))),
    )
    .await;

    Ok(json_ok(
        serde_json::json!({ "link": serialize_link(&link) }),
    ))
}

/// DELETE /api/ontology/links/{id} (editor+, 204).
pub async fn delete_link(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;

    let Some(existing) = fetch_link(&state.db, &id).await? else {
        return Err(ApiError::not_found(format!("Link '{id}' not found")));
    };
    sqlx::query("DELETE FROM link_types WHERE id = $1")
        .bind(&id)
        .execute(&state.db)
        .await?;
    crate::audit::audit(
        &state,
        &actor,
        crate::audit::AuditOptions::new("ontology.link.delete", "ontology")
            .resource_id(Some(&id))
            .resource_name(Some(&existing.display_name))
            .detail(Some(&format!(
                "{} -> {}",
                existing.from_type_id, existing.to_type_id
            ))),
    )
    .await;
    Ok(no_content())
}
