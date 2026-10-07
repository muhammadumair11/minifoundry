//! Built-in supply-chain sample packs — port of src/lib/sample-data.ts.
//! All data is hand-authored and deterministic (no randomness, no external
//! fetch), so seeds produce identical datasets on every run. Row VALUES and
//! column orders must match the legacy generator bit-for-bit (the golden
//! fixtures were captured from a workspace seeded by this code).

use mf_types::{Row, Value};
use serde_json::Map;

use crate::jsval::{js_number_value, js_round};

pub struct SamplePack {
    pub key: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub rows: Vec<Row>,
}

/// JS `Math.round(n * 100) / 100` with exact IEEE op order.
fn round2(n: f64) -> Value {
    js_number_value(js_round(n * 100.0) as f64 / 100.0)
}

fn num(v: f64) -> Value {
    js_number_value(v)
}

fn suppliers() -> Vec<Row> {
    #[allow(clippy::type_complexity)]
    #[rustfmt::skip]
    const S: [(&str, &str, &str, &str, f64, i64, f64, &str, f64, f64); 12] = [
        ("SUP-001", "Nordwind Elektronik", "Germany", "EMEA", 4.6, 12, 97.2, "Munich", 48.14, 11.58),
        ("SUP-002", "Shenzhen BrightPath Electronics", "China", "APAC", 4.2, 21, 94.8, "Shenzhen", 22.54, 114.06),
        ("SUP-003", "Osaka Precision Parts", "Japan", "APAC", 4.8, 9, 98.6, "Osaka", 34.69, 135.5),
        ("SUP-004", "Austin Circuit Works", "United States", "NA", 4.1, 14, 95.1, "Austin", 30.27, -97.74),
        ("SUP-005", "Cheonan Display Co.", "South Korea", "APAC", 4.5, 11, 96.4, "Cheonan", 36.81, 127.11),
        ("SUP-006", "Penang MicroAssembly", "Malaysia", "APAC", 3.9, 18, 92.7, "Penang", 5.41, 100.34),
        ("SUP-007", "Torino Metalworks", "Italy", "EMEA", 3.7, 16, 90.3, "Torino", 45.07, 7.69),
        ("SUP-008", "Guadalajara Wiredev", "Mexico", "LATAM", 3.8, 15, 91.5, "Guadalajara", 20.67, -103.35),
        ("SUP-009", "Hanoi FlexTech", "Vietnam", "APAC", 3.6, 24, 88.9, "Hanoi", 21.03, 105.85),
        ("SUP-010", "Eindhoven Photonix", "Netherlands", "EMEA", 4.7, 10, 97.8, "Eindhoven", 51.44, 5.48),
        ("SUP-011", "Gdansk Cable Systems", "Poland", "EMEA", 4.0, 13, 93.4, "Gdansk", 54.35, 18.65),
        ("SUP-012", "Chennai VoltSource", "India", "APAC", 3.5, 26, 87.2, "Chennai", 13.08, 80.27),
    ];
    S.iter()
        .map(|(id, name, country, region, rating, lead, on_time, city, lat, lon)| {
            let mut m = Map::new();
            m.insert("id".into(), Value::String((*id).to_string()));
            m.insert("name".into(), Value::String((*name).to_string()));
            m.insert("country".into(), Value::String((*country).to_string()));
            m.insert("region".into(), Value::String((*region).to_string()));
            m.insert("rating".into(), num(*rating));
            m.insert("leadTimeDays".into(), Value::Number((*lead).into()));
            m.insert("onTimePct".into(), num(*on_time));
            m.insert("city".into(), Value::String((*city).to_string()));
            m.insert("latitude".into(), num(*lat));
            m.insert("longitude".into(), num(*lon));
            m
        })
        .collect()
}

fn warehouses() -> Vec<Row> {
    #[rustfmt::skip]
    const W: [(&str, &str, &str, &str, i64, f64, f64); 6] = [
        ("WH-01", "Rotterdam Hub", "Rotterdam", "Netherlands", 42000, 51.92, 4.48),
        ("WH-02", "Singapore Central", "Singapore", "Singapore", 58000, 1.35, 103.82),
        ("WH-03", "Chicago Midway DC", "Chicago", "United States", 51000, 41.88, -87.63),
        ("WH-04", "Hamburg Nord Depot", "Hamburg", "Germany", 36000, 53.55, 9.99),
        ("WH-05", "Shenzhen South Bonded", "Shenzhen", "China", 64000, 22.54, 114.06),
        ("WH-06", "Monterrey Crossdock", "Monterrey", "Mexico", 28000, 25.69, -100.32),
    ];
    W.iter()
        .map(|(id, name, city, country, capacity, lat, lon)| {
            let mut m = Map::new();
            m.insert("id".into(), Value::String((*id).to_string()));
            m.insert("name".into(), Value::String((*name).to_string()));
            m.insert("city".into(), Value::String((*city).to_string()));
            m.insert("country".into(), Value::String((*country).to_string()));
            m.insert("capacity".into(), Value::Number((*capacity).into()));
            m.insert("latitude".into(), num(*lat));
            m.insert("longitude".into(), num(*lon));
            m
        })
        .collect()
}

struct CatalogEntry {
    sku: &'static str,
    product_name: &'static str,
    category: &'static str,
    base_price: f64,
}

fn catalog() -> Vec<CatalogEntry> {
    #[rustfmt::skip]
    const C: [(&str, &str, &str, f64); 15] = [
        ("SKU-1001", "Microcontroller MCU-32", "Electronics", 12.4),
        ("SKU-1002", "OLED Display 2.4in", "Electronics", 23.9),
        ("SKU-1003", "LiPo Battery 3000mAh", "Electronics", 18.75),
        ("SKU-1004", "WiFi Module X2", "Electronics", 9.6),
        ("SKU-1005", "GPS Sensor Patch", "Electronics", 15.2),
        ("SKU-2001", "Ceramic Capacitor C1206", "Components", 0.42),
        ("SKU-2002", "Resistor Array 10K", "Components", 0.18),
        ("SKU-2003", "PCB Substrate 4L", "Components", 3.85),
        ("SKU-2004", "Ribbon Cable 20P", "Components", 2.3),
        ("SKU-2005", "Crystal Osc 16MHz", "Components", 0.65),
        ("SKU-3001", "Aluminum Sheet 1mm", "Materials", 8.9),
        ("SKU-3002", "Copper Wire 0.5mm", "Materials", 12.4),
        ("SKU-3003", "ABS Pellets FR", "Materials", 4.15),
        ("SKU-3004", "Thermal Paste GX", "Materials", 6.3),
        ("SKU-3005", "Steel Casing Frame", "Materials", 19.8),
    ];
    C.iter()
        .map(|(sku, product_name, category, base_price)| CatalogEntry {
            sku,
            product_name,
            category,
            base_price: *base_price,
        })
        .collect()
}

const STATUS_CYCLE: [&str; 10] = [
    "delivered",
    "in_transit",
    "delivered",
    "delayed",
    "in_transit",
    "delivered",
    "customs",
    "delivered",
    "in_transit",
    "delayed",
];

fn shipments() -> Vec<Row> {
    let suppliers = suppliers();
    let warehouses = warehouses();
    let catalog = catalog();
    let base = chrono::NaiveDate::from_ymd_opt(2024, 11, 4).unwrap();
    (0..60)
        .map(|i: i64| {
            let supplier_idx = ((i * 7 + 3) % 12) as usize;
            let warehouse_idx = ((i * 3 + 1) % 6) as usize;
            let entry = &catalog[(i % catalog.len() as i64) as usize];
            let quantity = 40 + ((i * 137) % 1960);
            let price_factor = 1.0 + (((i % 5) - 2) as f64 * 0.03);
            let ship_date = base
                .checked_add_signed(chrono::Duration::days(i))
                .unwrap()
                .format("%Y-%m-%d")
                .to_string();
            let mut m = Map::new();
            m.insert("id".into(), Value::String(format!("SHP-{:04}", i + 1)));
            m.insert(
                "supplierId".into(),
                suppliers[supplier_idx].get("id").unwrap().clone(),
            );
            m.insert(
                "warehouseId".into(),
                warehouses[warehouse_idx].get("id").unwrap().clone(),
            );
            m.insert("sku".into(), Value::String(entry.sku.to_string()));
            m.insert(
                "productName".into(),
                Value::String(entry.product_name.to_string()),
            );
            m.insert("category".into(), Value::String(entry.category.to_string()));
            m.insert("quantity".into(), Value::Number(quantity.into()));
            m.insert("unitPrice".into(), round2(entry.base_price * price_factor));
            m.insert(
                "status".into(),
                Value::String(STATUS_CYCLE[(i % 10) as usize].to_string()),
            );
            m.insert("shipDate".into(), Value::String(ship_date));
            m.insert("etaDays".into(), Value::Number((3 + ((i * 5) % 28)).into()));
            m
        })
        .collect()
}

fn inventory() -> Vec<Row> {
    let warehouses = warehouses();
    let catalog = catalog();
    (0..40)
        .map(|i: i64| {
            let warehouse_idx = (i % 6) as usize;
            let entry_idx = (((i / 6) * 2 + (i % 2)) % catalog.len() as i64) as usize;
            let entry = &catalog[entry_idx];
            let stock = 120 + ((i * 211) % 2400);
            let reorder_point = 50 + ((i * 97) % 400);
            let cost_factor = 0.8 + (i % 4) as f64 * 0.05;
            let mut m = Map::new();
            m.insert("sku".into(), Value::String(entry.sku.to_string()));
            m.insert(
                "productName".into(),
                Value::String(entry.product_name.to_string()),
            );
            m.insert(
                "warehouseId".into(),
                warehouses[warehouse_idx].get("id").unwrap().clone(),
            );
            m.insert("stock".into(), Value::Number(stock.into()));
            m.insert("reorderPoint".into(), Value::Number(reorder_point.into()));
            m.insert("unitCost".into(), round2(entry.base_price * cost_factor));
            m
        })
        .collect()
}

/// SAMPLE_PACKS registry — iteration order matters (seed creates datasets in
/// this order): suppliers, warehouses, shipments, inventory.
pub fn sample_packs() -> Vec<SamplePack> {
    vec![
        SamplePack {
            key: "suppliers",
            name: "Suppliers",
            description: "Global supplier master with ratings, lead times and on-time delivery %.",
            rows: suppliers(),
        },
        SamplePack {
            key: "warehouses",
            name: "Warehouses",
            description: "Warehouse master with locations and storage capacity.",
            rows: warehouses(),
        },
        SamplePack {
            key: "shipments",
            name: "Shipments",
            description: "Shipment line items with supplier, warehouse, SKU, status and ETA.",
            rows: shipments(),
        },
        SamplePack {
            key: "inventory",
            name: "Inventory",
            description: "Stock levels per SKU and warehouse with reorder points and unit cost.",
            rows: inventory(),
        },
    ]
}

/// Available pack keys in registry order (for the unknown-key error message).
pub fn sample_pack_keys() -> Vec<&'static str> {
    vec!["suppliers", "warehouses", "shipments", "inventory"]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pack_sizes_match_legacy() {
        let packs = sample_packs();
        assert_eq!(packs.len(), 4);
        assert_eq!(packs[0].rows.len(), 12);
        assert_eq!(packs[1].rows.len(), 6);
        assert_eq!(packs[2].rows.len(), 60);
        assert_eq!(packs[3].rows.len(), 40);
    }

    #[test]
    fn supplier_row_exact() {
        let packs = sample_packs();
        let first = &packs[0].rows[0];
        assert_eq!(
            serde_json::to_value(first).unwrap(),
            json!({
                "id": "SUP-001",
                "name": "Nordwind Elektronik",
                "country": "Germany",
                "region": "EMEA",
                "rating": 4.6,
                "leadTimeDays": 12,
                "onTimePct": 97.2,
                "city": "Munich",
                "latitude": 48.14,
                "longitude": 11.58
            })
        );
        // key ORDER matters for row storage/export
        let keys: Vec<&String> = first.keys().collect();
        assert_eq!(
            keys,
            vec!["id", "name", "country", "region", "rating", "leadTimeDays", "onTimePct", "city", "latitude", "longitude"]
        );
        // integer-valued floats render like JS (4.0 → 4)
        let sup11 = &packs[0].rows[10];
        assert_eq!(serde_json::to_string(&sup11["rating"]).unwrap(), "4");
    }

    #[test]
    fn shipment_row_exact() {
        let packs = sample_packs();
        let s0 = &packs[2].rows[0];
        assert_eq!(s0["id"], json!("SHP-0001"));
        assert_eq!(s0["supplierId"], json!("SUP-004")); // (0*7+3)%12 = 3 → SUP-004
        assert_eq!(s0["warehouseId"], json!("WH-02")); // (0*3+1)%6 = 1
        assert_eq!(s0["sku"], json!("SKU-1001"));
        assert_eq!(s0["quantity"], json!(40));
        // 12.4 * 0.94 = 11.656 → round2 → 11.66
        assert_eq!(s0["unitPrice"], json!(11.66));
        assert_eq!(s0["status"], json!("delivered"));
        assert_eq!(s0["shipDate"], json!("2024-11-04"));
        assert_eq!(s0["etaDays"], json!(3));
        // date overflow into January
        let s59 = &packs[2].rows[59];
        assert_eq!(s59["id"], json!("SHP-0060"));
        assert_eq!(s59["shipDate"], json!("2025-01-02"));
    }

    #[test]
    fn inventory_row_exact() {
        let packs = sample_packs();
        let i0 = &packs[3].rows[0];
        assert_eq!(
            serde_json::to_value(i0).unwrap(),
            json!({
                "sku": "SKU-1001",
                "productName": "Microcontroller MCU-32",
                "warehouseId": "WH-01",
                "stock": 120,
                "reorderPoint": 50,
                "unitCost": 9.92
            })
        );
    }

    #[test]
    fn round2_matches_js_math_round() {
        assert_eq!(round2(11.656), json!(11.66));
        assert_eq!(round2(12.0), json!(12));
        assert_eq!(round2(0.4326), json!(0.43));
        // JS: 2.675*100 === 267.5 (f64), Math.round(267.5) = 268 → 2.68
        assert_eq!(round2(2.675), json!(2.68));
    }
}
