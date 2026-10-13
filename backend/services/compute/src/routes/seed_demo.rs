//! POST /api/transforms/seed-demo — idempotent demo seeding for M4 workbooks
//! (port of src/app/api/transforms/seed-demo/route.ts).
//!
//! Resolves the three demo datasets BY NAME through the catalog internal API
//! ("Shipments", "Suppliers", "Active Shipments"); creates the SQL + JS +
//! Python demo transforms when absent. Editor+ role.

use axum::body::Bytes;
use axum::http::HeaderMap;
use axum::response::Response;
use mf_web::TenantState as State;
use mf_web::{actor_from_headers, json_ok, require_role, ApiError, ApiResult};
use sqlx::types::Json;

use crate::audit::{self, AuditOptions};
use crate::catalog;
use crate::routes::{as_object, parse_body};
use crate::state::AppState;

const SQL_SOURCE: &str = r#"-- Total spend per supplier from shipment line items
SELECT
  s.name  AS supplier,
  s.country,
  COUNT(*)               AS shipments,
  SUM(sh.quantity)       AS unitsShipped,
  ROUND(SUM(sh.quantity * sh.unitPrice), 2) AS totalSpend
FROM shipments sh
JOIN suppliers s ON s.id = sh.supplierId
GROUP BY s.name, s.country
ORDER BY totalSpend DESC"#;

const JS_SOURCE: &str = r#"// Risk-flag every active shipment with simple heuristics.
const out = input.rows.filter(function (r) { return r.status !== 'delivered' }).map(function (r) {
  const eta = Number(r.etaDays) || 0
  const value = Math.round((Number(r.quantity) || 0) * (Number(r.unitPrice) || 0) * 100) / 100
  const risk = r.status === 'delayed' ? 'high' : eta >= 10 ? 'medium' : 'low'
  return {
    shipmentId: r.id,
    productName: r.productName,
    category: r.category,
    status: r.status,
    etaDays: eta,
    value: value,
    riskLevel: risk,
  }
})
return out"#;

const PYTHON_SOURCE: &str = r#"# Score active shipments into a fulfillment priority list (urgency-adjusted value).
# transform(input) receives {"rows": first input, "datasets": {...}, "schemas": {...}}.
def transform(input):
    scored = []
    for r in input["rows"]:
        if r.get("status") == "delivered":
            continue
        eta = int(r.get("etaDays") or 0)
        qty = int(r.get("quantity") or 0)
        price = float(r.get("unitPrice") or 0.0)
        value = round(qty * price, 2)
        score = value / (eta + 1)  # urgency-adjusted value
        priority = "high" if eta <= 3 else "medium" if eta <= 8 else "low"
        scored.append({
            "shipmentId": r.get("id"),
            "productName": r.get("productName"),
            "category": r.get("category"),
            "etaDays": eta,
            "value": value,
            "priorityScore": round(score, 2),
            "priority": priority,
        })
    scored.sort(key=lambda s: -s["priorityScore"])
    return scored
"#;

struct DemoSpec {
    name: &'static str,
    description: &'static str,
    language: &'static str,
    input_names: &'static [&'static str],
    output_dataset_name: &'static str,
    source_code: &'static str,
}

const DEMOS: &[DemoSpec] = &[
    DemoSpec {
        name: "Supplier Spend Summary",
        description: "SQL workbook — aggregates shipment line items into total spend per supplier.",
        language: "sql",
        input_names: &["Shipments", "Suppliers"],
        output_dataset_name: "Supplier Spend Summary",
        source_code: SQL_SOURCE,
    },
    DemoSpec {
        name: "Shipment Risk Flags",
        description:
            "JavaScript workbook — risk-flags every active shipment with simple heuristics.",
        language: "javascript",
        input_names: &["Active Shipments"],
        output_dataset_name: "Shipment Risk Flags",
        source_code: JS_SOURCE,
    },
    DemoSpec {
        name: "Fulfillment Priority",
        description: "Python workbook — scores active shipments by urgency-adjusted value into a priority list.",
        language: "python",
        input_names: &["Active Shipments"],
        output_dataset_name: "Fulfillment Priority",
        source_code: PYTHON_SOURCE,
    },
];

pub async fn seed_demo(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    require_role(&actor, "editor")?;

    // Body is optional; when present it must be a JSON object.
    let text = String::from_utf8_lossy(&body);
    if !text.trim().is_empty() {
        let v = parse_body(&body)?;
        as_object(v)?;
    }

    // Resolve demo inputs BY NAME (unique, first-appearance order — the
    // legacy [...new Set(DEMOS.flatMap(...))] iteration order).
    let mut names: Vec<&str> = Vec::new();
    for demo in DEMOS {
        for n in demo.input_names {
            if !names.contains(n) {
                names.push(n);
            }
        }
    }
    let mut by_name: Vec<(&str, String)> = Vec::new();
    let mut missing: Vec<&str> = Vec::new();
    for name in &names {
        match catalog::get_dataset_by_name(&state.catalog, name).await {
            Ok(Some(ds)) => match ds.get("id").and_then(|v| v.as_str()) {
                Some(id) => by_name.push((name, id.to_string())),
                None => missing.push(name),
            },
            _ if *name == "Active Shipments" => {
                // The catalog sample pack contains Shipments; a derived
                // Active Shipments pipeline is optional. The demo code filters
                // delivered rows itself so either input has the same meaning.
                match catalog::get_dataset_by_name(&state.catalog, "Shipments").await {
                    Ok(Some(ds)) if ds.get("id").and_then(|v| v.as_str()).is_some() => {
                        by_name.push((name, ds["id"].as_str().unwrap().to_string()))
                    }
                    _ => missing.push("Shipments"),
                }
            }
            _ => missing.push(name),
        }
    }
    if !missing.is_empty() {
        return Err(ApiError::bad_request(format!(
            "Cannot seed demo transforms — missing datasets: {}",
            missing.join(", ")
        )));
    }

    let mut created: Vec<String> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    for demo in DEMOS {
        let existing: Option<(String,)> =
            sqlx::query_as("SELECT id FROM transforms WHERE name = $1")
                .bind(demo.name)
                .fetch_optional(&state.db)
                .await?;
        if existing.is_some() {
            skipped.push(demo.name.to_string());
            continue;
        }
        let input_ids: Vec<String> = demo
            .input_names
            .iter()
            .filter_map(|n| {
                by_name
                    .iter()
                    .find(|(name, _)| name == n)
                    .map(|(_, id)| id.clone())
            })
            .collect();
        let id = mf_db::new_id();
        let inputs_json = Json(
            serde_json::to_value(&input_ids)
                .unwrap_or_else(|_| serde_json::Value::Array(Vec::new())),
        );
        sqlx::query(
            "INSERT INTO transforms (id, name, description, language, source_code, inputs_json, \
             output_dataset_name) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(&id)
        .bind(demo.name)
        .bind(demo.description)
        .bind(demo.language)
        .bind(demo.source_code)
        .bind(inputs_json)
        .bind(demo.output_dataset_name)
        .execute(&state.db)
        .await?;

        audit::audit(
            &state,
            &actor,
            AuditOptions::new("transform.create", "transform")
                .resource_id(Some(&id))
                .resource_name(Some(demo.name))
                .detail(Some("seed-demo")),
        )
        .await;
        created.push(demo.name.to_string());
    }

    Ok(json_ok(serde_json::json!({
        "seeded": !created.is_empty(),
        "created": created,
        "skipped": skipped,
    })))
}
