//! ObjectTypeFull assembly — joins the part tables with catalog dataset
//! metadata (name + head rowCount) for serializeObjectType. A DOWN catalog
//! degrades to null sourceDatasetName/objectCount (metadata-only paths keep
//! working pre-integration) instead of failing the whole ontology list.

use std::collections::HashMap;

use mf_web::ApiError;

use crate::catalog::DatasetSummary;
use crate::serialize::{ObjectTypeFull, TypeMeta};
use crate::state::*;

/// id → summary map from catalog (empty + warn when catalog is unreachable).
pub async fn dataset_map(state: &AppState) -> HashMap<String, DatasetSummary> {
    match state.catalog.list_datasets().await {
        Ok(list) => list.into_iter().map(|d| (d.id.clone(), d)).collect(),
        Err(e) => {
            tracing::warn!(error = %e.message, "catalog dataset list unavailable; dataset metadata degrades to null");
            HashMap::new()
        }
    }
}

/// Assemble the full serializer input for ONE object type.
pub async fn full_for_one(
    state: &AppState,
    row: &ObjectTypeRow,
    datasets: &HashMap<String, DatasetSummary>,
) -> Result<ObjectTypeFull, ApiError> {
    let properties = crate::dbx::load_properties(&state.db, &row.id).await?;

    let mut links_out = Vec::new();
    for (l, meta) in crate::dbx::outgoing_links(&state.db, &row.id).await? {
        if let Some(m) = meta {
            links_out.push((l, m));
        }
    }
    let mut links_in = Vec::new();
    for (l, meta) in crate::dbx::incoming_links(&state.db, &row.id).await? {
        if let Some(m) = meta {
            links_in.push((l, m));
        }
    }
    let actions = crate::dbx::actions_for_type(&state.db, &row.id).await?;

    let source = row
        .source_dataset_id
        .as_ref()
        .and_then(|id| datasets.get(id));
    let mut link_dataset_names = HashMap::new();
    for (l, _) in &links_out {
        if let Some(id) = &l.link_dataset_id {
            if let Some(s) = datasets.get(id) {
                link_dataset_names.insert(id.clone(), s.name.clone());
            }
        }
    }

    Ok(ObjectTypeFull {
        source_dataset_name: source.map(|s| s.name.clone()),
        object_count: source.and_then(|s| s.row_count),
        link_dataset_names,
        row: row.clone(),
        properties,
        links_out,
        links_in,
        actions,
    })
}

/// Assemble fulls for the whole list (few bulk queries; legacy ordering:
/// types createdAt asc, properties id asc, links apiName asc, actions
/// createdAt+apiName asc).
pub async fn full_for_list(
    state: &AppState,
    rows: &[ObjectTypeRow],
    datasets: &HashMap<String, DatasetSummary>,
) -> Result<Vec<ObjectTypeFull>, ApiError> {
    let metas: HashMap<String, TypeMeta> = rows
        .iter()
        .map(|r| {
            (
                r.id.clone(),
                TypeMeta {
                    id: r.id.clone(),
                    api_name: r.api_name.clone(),
                    display_name: r.display_name.clone(),
                },
            )
        })
        .collect();

    // Bulk loads with legacy orderings.
    let all_props: Vec<PropertyRow> = sqlx::query_as(&format!(
        "SELECT {PROPERTY_COLS} FROM properties ORDER BY id ASC"
    ))
    .fetch_all(&state.db)
    .await?;
    let all_links: Vec<LinkTypeRow> = sqlx::query_as(&format!(
        "SELECT {LINK_COLS} FROM link_types ORDER BY api_name ASC"
    ))
    .fetch_all(&state.db)
    .await?;
    let all_actions: Vec<ActionTypeRow> = sqlx::query_as(&format!(
        "SELECT {ACTION_COLS} FROM action_types ORDER BY created_at ASC, api_name ASC"
    ))
    .fetch_all(&state.db)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let properties: Vec<PropertyRow> = all_props
            .iter()
            .filter(|p| p.object_type_id == row.id)
            .cloned()
            .collect();
        let links_out: Vec<(LinkTypeRow, TypeMeta)> = all_links
            .iter()
            .filter(|l| l.from_type_id == row.id)
            .filter_map(|l| metas.get(&l.to_type_id).map(|m| (l.clone(), clone_meta(m))))
            .collect();
        let links_in: Vec<(LinkTypeRow, TypeMeta)> = all_links
            .iter()
            .filter(|l| l.to_type_id == row.id)
            .filter_map(|l| metas.get(&l.from_type_id).map(|m| (l.clone(), clone_meta(m))))
            .collect();
        let actions: Vec<ActionTypeRow> = all_actions
            .iter()
            .filter(|a| a.object_type_id == row.id)
            .cloned()
            .collect();

        let source = row
            .source_dataset_id
            .as_ref()
            .and_then(|id| datasets.get(id));
        let mut link_dataset_names = HashMap::new();
        for (l, _) in &links_out {
            if let Some(id) = &l.link_dataset_id {
                if let Some(s) = datasets.get(id) {
                    link_dataset_names.insert(id.clone(), s.name.clone());
                }
            }
        }
        out.push(ObjectTypeFull {
            row: row.clone(),
            properties,
            links_out,
            links_in,
            actions,
            source_dataset_name: source.map(|s| s.name.clone()),
            object_count: source.and_then(|s| s.row_count),
            link_dataset_names,
        });
    }
    Ok(out)
}

fn clone_meta(m: &TypeMeta) -> TypeMeta {
    TypeMeta {
        id: m.id.clone(),
        api_name: m.api_name.clone(),
        display_name: m.display_name.clone(),
    }
}
