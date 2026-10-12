//! DB access helpers for the ontology schema (queries shared by routes).

use sqlx::PgPool;

use crate::links::{PropLike, TypeCore};
use crate::serialize::TypeMeta;
use crate::state::*;

/// Find an object type by id OR apiName (port of findObjectType).
pub async fn find_object_type(
    db: &PgPool,
    id_or_api_name: &str,
) -> Result<Option<ObjectTypeRow>, ApiErr> {
    let q = format!("SELECT {OBJECT_TYPE_COLS} FROM object_types WHERE id = $1");
    if let Some(row) = sqlx::query_as::<_, ObjectTypeRow>(&q)
        .bind(id_or_api_name)
        .fetch_optional(db)
        .await?
    {
        return Ok(Some(row));
    }
    let q = format!("SELECT {OBJECT_TYPE_COLS} FROM object_types WHERE api_name = $1");
    let row = sqlx::query_as::<_, ObjectTypeRow>(&q)
        .bind(id_or_api_name)
        .fetch_optional(db)
        .await?;
    Ok(row)
}

pub async fn load_properties(
    db: &PgPool,
    object_type_id: &str,
) -> Result<Vec<PropertyRow>, ApiErr> {
    let q =
        format!("SELECT {PROPERTY_COLS} FROM properties WHERE object_type_id = $1 ORDER BY id ASC");
    Ok(sqlx::query_as::<_, PropertyRow>(&q)
        .bind(object_type_id)
        .fetch_all(db)
        .await?)
}

/// Build the TypeCore projection used by the row/link engines.
pub fn type_core_of(row: &ObjectTypeRow, properties: &[PropertyRow]) -> TypeCore {
    TypeCore {
        id: row.id.clone(),
        api_name: row.api_name.clone(),
        display_name: row.display_name.clone(),
        primary_key: row.primary_key.clone(),
        source_dataset_id: row.source_dataset_id.clone(),
        icon: row.icon.clone(),
        color: row.color.clone(),
        properties: properties
            .iter()
            .map(|p| PropLike {
                api_name: p.api_name.clone(),
                display_name: p.display_name.clone(),
                data_type: p.data_type.clone(),
                is_title: p.is_title,
                hide_in_table: p.hide_in_table,
            })
            .collect(),
    }
}

pub async fn type_meta(db: &PgPool, type_id: &str) -> Result<Option<TypeMeta>, ApiErr> {
    let row: Option<(String, String, String)> =
        sqlx::query_as("SELECT id, api_name, display_name FROM object_types WHERE id = $1")
            .bind(type_id)
            .fetch_optional(db)
            .await?;
    Ok(row.map(|(id, api_name, display_name)| TypeMeta {
        id,
        api_name,
        display_name,
    }))
}

/// Outgoing links of a type, apiName asc, with toType meta.
pub async fn outgoing_links(
    db: &PgPool,
    type_id: &str,
) -> Result<Vec<(LinkTypeRow, Option<TypeMeta>)>, ApiErr> {
    let q =
        format!("SELECT {LINK_COLS} FROM link_types WHERE from_type_id = $1 ORDER BY api_name ASC");
    let links = sqlx::query_as::<_, LinkTypeRow>(&q)
        .bind(type_id)
        .fetch_all(db)
        .await?;
    let mut out = Vec::with_capacity(links.len());
    for l in links {
        out.push((l.clone(), type_meta(db, &l.to_type_id).await?));
    }
    Ok(out)
}

/// Incoming links of a type, apiName asc, with fromType meta.
pub async fn incoming_links(
    db: &PgPool,
    type_id: &str,
) -> Result<Vec<(LinkTypeRow, Option<TypeMeta>)>, ApiErr> {
    let q =
        format!("SELECT {LINK_COLS} FROM link_types WHERE to_type_id = $1 ORDER BY api_name ASC");
    let links = sqlx::query_as::<_, LinkTypeRow>(&q)
        .bind(type_id)
        .fetch_all(db)
        .await?;
    let mut out = Vec::with_capacity(links.len());
    for l in links {
        out.push((l.clone(), type_meta(db, &l.from_type_id).await?));
    }
    Ok(out)
}

/// Actions of a type ordered by (createdAt asc, apiName asc).
pub async fn actions_for_type(db: &PgPool, type_id: &str) -> Result<Vec<ActionTypeRow>, ApiErr> {
    let q = format!(
        "SELECT {ACTION_COLS} FROM action_types WHERE object_type_id = $1 \
         ORDER BY created_at ASC, api_name ASC"
    );
    Ok(sqlx::query_as::<_, ActionTypeRow>(&q)
        .bind(type_id)
        .fetch_all(db)
        .await?)
}

/// Find an action type by apiName OR id (legacy lookup order).
pub async fn find_action_type(
    db: &PgPool,
    api_name_or_id: &str,
) -> Result<Option<ActionTypeRow>, ApiErr> {
    let q = format!("SELECT {ACTION_COLS} FROM action_types WHERE api_name = $1");
    if let Some(row) = sqlx::query_as::<_, ActionTypeRow>(&q)
        .bind(api_name_or_id)
        .fetch_optional(db)
        .await?
    {
        return Ok(Some(row));
    }
    let q = format!("SELECT {ACTION_COLS} FROM action_types WHERE id = $1");
    Ok(sqlx::query_as::<_, ActionTypeRow>(&q)
        .bind(api_name_or_id)
        .fetch_optional(db)
        .await?)
}

pub async fn object_type_by_id(db: &PgPool, id: &str) -> Result<Option<ObjectTypeRow>, ApiErr> {
    let q = format!("SELECT {OBJECT_TYPE_COLS} FROM object_types WHERE id = $1");
    Ok(sqlx::query_as::<_, ObjectTypeRow>(&q)
        .bind(id)
        .fetch_optional(db)
        .await?)
}

/// Shorthand alias used across route modules.
pub type ApiErr = mf_web::ApiError;
