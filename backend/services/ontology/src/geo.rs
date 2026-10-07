//! Offline geo helpers for Application maps — EXACT port of src/lib/geo.ts.
//!
//! Objects land on a map in two ways:
//!   1. GEO PROPERTIES — the backing row carries latitude/longitude columns
//!      (auto-detected by name, or picked explicitly in the map layer config).
//!   2. GEOCODE FALLBACK — rows without coordinates are placed through a
//!      built-in, fully offline centroid table: first a city match, then a
//!      country match, over the layer's fallback property (or any string
//!      property named city/country/location/address).
//!
//! Deterministic hash jitter spreads multiple objects that resolve to the same
//! centroid so they stay individually clickable. No network calls, ever.

use once_cell::sync::Lazy;
use regex::Regex;
use std::collections::HashMap;

use mf_types::{Row, Value};

/// How the coordinate was resolved — surfaced in map tooltips/legend.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GeoSource {
    Property,
    City,
    Country,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
pub struct GeoPoint {
    pub lat: f64,
    pub lng: f64,
    pub source: GeoSource,
}

// ─── Centroid tables (offline geocoding) ─────────────────────────────────

fn table(entries: &[(&'static str, f64, f64)]) -> HashMap<&'static str, (f64, f64)> {
    entries.iter().map(|(k, a, b)| (*k, (*a, *b))).collect()
}

/// Country centroids keyed by lowercase name; common aliases included.
pub static COUNTRY_CENTROIDS: Lazy<HashMap<&'static str, (f64, f64)>> = Lazy::new(|| {
    table(&[
        ("united states", 39.8, -98.6),
        ("usa", 39.8, -98.6),
        ("us", 39.8, -98.6),
        ("united states of america", 39.8, -98.6),
        ("germany", 51.1, 10.4),
        ("deutschland", 51.1, 10.4),
        ("japan", 36.2, 138.2),
        ("china", 35.0, 105.0),
        ("south korea", 36.5, 127.8),
        ("republic of korea", 36.5, 127.8),
        ("korea", 36.5, 127.8),
        ("malaysia", 4.2, 101.9),
        ("italy", 41.9, 12.5),
        ("italia", 41.9, 12.5),
        ("mexico", 23.6, -102.5),
        ("vietnam", 14.1, 108.3),
        ("netherlands", 52.1, 5.3),
        ("holland", 52.1, 5.3),
        ("poland", 51.9, 19.1),
        ("polska", 51.9, 19.1),
        ("india", 20.6, 79.0),
        ("singapore", 1.35, 103.82),
        ("united kingdom", 55.4, -3.4),
        ("uk", 55.4, -3.4),
        ("great britain", 55.4, -3.4),
        ("france", 46.2, 2.2),
        ("spain", 40.5, -3.7),
        ("espana", 40.5, -3.7),
        ("portugal", 39.4, -8.2),
        ("belgium", 50.5, 4.5),
        ("switzerland", 46.8, 8.2),
        ("austria", 47.5, 14.5),
        ("sweden", 60.1, 18.6),
        ("norway", 60.5, 8.5),
        ("denmark", 56.3, 10.6),
        ("finland", 61.9, 25.7),
        ("ireland", 53.4, -8.2),
        ("czechia", 49.8, 15.5),
        ("czech republic", 49.8, 15.5),
        ("romania", 45.9, 24.9),
        ("hungary", 47.2, 19.5),
        ("greece", 39.1, 21.8),
        ("turkey", 38.9, 35.2),
        ("turkiye", 38.9, 35.2),
        ("russia", 61.5, 105.3),
        ("ukraine", 48.4, 31.2),
        ("brazil", -14.2, -51.9),
        ("brasil", -14.2, -51.9),
        ("argentina", -38.4, -63.6),
        ("chile", -35.7, -71.5),
        ("colombia", 4.6, -74.3),
        ("peru", -9.2, -75.0),
        ("canada", 56.1, -106.3),
        ("australia", -25.3, 133.8),
        ("new zealand", -40.9, 174.9),
        ("indonesia", -0.8, 113.9),
        ("thailand", 15.9, 101.1),
        ("philippines", 12.9, 121.8),
        ("pakistan", 30.4, 69.3),
        ("bangladesh", 23.7, 90.4),
        ("saudi arabia", 23.9, 45.1),
        ("united arab emirates", 23.4, 53.8),
        ("uae", 23.4, 53.8),
        ("israel", 31.0, 34.9),
        ("egypt", 26.8, 30.8),
        ("nigeria", 9.1, 8.7),
        ("south africa", -30.6, 22.9),
        ("kenya", -0.02, 37.9),
        ("morocco", 31.8, -7.1),
    ])
});

/// City centroids — sample-data cities plus global logistics hubs.
pub static CITY_CENTROIDS: Lazy<HashMap<&'static str, (f64, f64)>> = Lazy::new(|| {
    table(&[
        ("rotterdam", 51.92, 4.48),
        ("singapore", 1.35, 103.82),
        ("chicago", 41.88, -87.63),
        ("hamburg", 53.55, 9.99),
        ("shenzhen", 22.54, 114.06),
        ("monterrey", 25.69, -100.32),
        ("munich", 48.14, 11.58),
        ("osaka", 34.69, 135.5),
        ("austin", 30.27, -97.74),
        ("cheonan", 36.81, 127.11),
        ("penang", 5.41, 100.34),
        ("george town", 5.41, 100.34),
        ("torino", 45.07, 7.69),
        ("turin", 45.07, 7.69),
        ("guadalajara", 20.67, -103.35),
        ("hanoi", 21.03, 105.85),
        ("eindhoven", 51.44, 5.48),
        ("gdansk", 54.35, 18.65),
        ("chennai", 13.08, 80.27),
        ("amsterdam", 52.37, 4.9),
        ("london", 51.51, -0.13),
        ("paris", 48.86, 2.35),
        ("berlin", 52.52, 13.4),
        ("madrid", 40.42, -3.7),
        ("milan", 45.46, 9.19),
        ("barcelona", 41.39, 2.17),
        ("warsaw", 52.23, 21.01),
        ("istanbul", 41.01, 28.98),
        ("dubai", 25.2, 55.27),
        ("mumbai", 19.08, 72.88),
        ("delhi", 28.61, 77.21),
        ("new delhi", 28.61, 77.21),
        ("bangalore", 12.97, 77.59),
        ("bengaluru", 12.97, 77.59),
        ("shanghai", 31.23, 121.47),
        ("beijing", 39.9, 116.4),
        ("tokyo", 35.68, 139.69),
        ("seoul", 37.57, 126.98),
        ("taipei", 25.03, 121.57),
        ("bangkok", 13.76, 100.5),
        ("ho chi minh city", 10.82, 106.63),
        ("saigon", 10.82, 106.63),
        ("jakarta", -6.21, 106.85),
        ("manila", 14.6, 120.98),
        ("sydney", -33.87, 151.21),
        ("melbourne", -37.81, 144.96),
        ("auckland", -36.85, 174.76),
        ("new york", 40.71, -74.01),
        ("new jersey", 40.72, -74.17),
        ("newark", 40.74, -74.17),
        ("los angeles", 34.05, -118.24),
        ("san francisco", 37.77, -122.42),
        ("seattle", 47.61, -122.33),
        ("dallas", 32.78, -96.8),
        ("houston", 29.76, -95.37),
        ("atlanta", 33.75, -84.39),
        ("miami", 25.76, -80.19),
        ("toronto", 43.65, -79.38),
        ("vancouver", 49.28, -123.12),
        ("panama city", 8.98, -79.52),
        ("santos", -23.96, -46.33),
        ("sao paulo", -23.55, -46.63),
        ("buenos aires", -34.6, -58.38),
        ("cape town", -33.92, 18.42),
        ("lagos", 6.52, 3.38),
        ("nairobi", -1.29, 36.82),
        ("cairo", 30.04, 31.24),
        ("antwerp", 51.26, 4.4),
        ("le havre", 49.49, 0.11),
        ("bremen", 53.08, 8.8),
        ("genoa", 44.41, 8.93),
        ("valencia", 39.47, -0.38),
        ("lisbon", 38.72, -9.14),
    ])
});

// ─── Property detection ───────────────────────────────────────────────────

static LAT_NAME: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^(lat|latitude|y|geo_?lat)(itude)?$").unwrap());
static LNG_NAME: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)^(lng|lon|long|longitude|x|geo_?l(n)?g|geo_?lon)(itude)?$").unwrap()
});
static CITY_NAME: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)^(city|town|municipality)$").unwrap());
static COUNTRY_NAME: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)^(country|nation)$").unwrap());
static LOCATION_NAME: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^(location|place|address|geo|coordinates?)$").unwrap());

/// Property descriptor used for detection ({ apiName, dataType }).
pub struct PropertyLike<'a> {
    pub api_name: &'a str,
    pub data_type: &'a str,
}

/// Detected coordinate columns (either side may be absent).
#[derive(Debug, Default, PartialEq)]
pub struct LatLngProps {
    pub lat: Option<String>,
    pub lng: Option<String>,
}

/// Auto-detect coordinate columns on an object type: explicit latitude/
/// longitude-named NUMBER properties win; absent sides fall back to centroid
/// geocoding.
pub fn detect_lat_lng_properties(properties: &[PropertyLike<'_>]) -> LatLngProps {
    let numeric: Vec<&PropertyLike> = properties
        .iter()
        .filter(|p| p.data_type == "number")
        .collect();
    LatLngProps {
        lat: numeric
            .iter()
            .find(|p| LAT_NAME.is_match(p.api_name))
            .map(|p| p.api_name.to_string()),
        lng: numeric
            .iter()
            .find(|p| LNG_NAME.is_match(p.api_name))
            .map(|p| p.api_name.to_string()),
    }
}

/// Default fallback property for centroid geocoding: city beats country
/// beats location-ish names.
pub fn detect_fallback_property(properties: &[PropertyLike<'_>]) -> Option<String> {
    let strings: Vec<&str> = properties
        .iter()
        .filter(|p| p.data_type == "string")
        .map(|p| p.api_name)
        .collect();
    strings
        .iter()
        .find(|n| CITY_NAME.is_match(n))
        .or_else(|| strings.iter().find(|n| COUNTRY_NAME.is_match(n)))
        .or_else(|| strings.iter().find(|n| LOCATION_NAME.is_match(n)))
        .map(|s| s.to_string())
}

// ─── Coordinate resolution ────────────────────────────────────────────────

fn to_finite_number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64().filter(|f| f.is_finite()),
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                None
            } else {
                t.parse::<f64>().ok().filter(|f| f.is_finite())
            }
        }
        _ => None,
    }
}

/// Deterministic 32-bit string hash (FNV-1a over UTF-16 code units, as JS)
/// → [0, 1).
fn hash01(key: &str) -> f64 {
    let mut h: u32 = 0x811c_9dc5;
    for unit in key.encode_utf16() {
        h ^= unit as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    ((h % 100000) as f64) / 100000.0
}

/// JS `Math.round(x * 10000) / 10000` (half-up toward +∞).
fn round4(x: f64) -> f64 {
    let scaled = x * 10000.0;
    (scaled.floor() + if scaled - scaled.floor() >= 0.5 { 1.0 } else { 0.0 }) / 10000.0
}

/// Deterministic jitter (±0.7° lat, ±0.9° lng scaled by cosine) so multiple
/// objects sharing a centroid stay individually clickable.
pub fn jitter_point(seed: &str, lat: f64, lng: f64) -> (f64, f64) {
    let a = hash01(&format!("{seed}|lat"));
    let b = hash01(&format!("{seed}|lng"));
    let cos = (0.2f64).max((lat * std::f64::consts::PI / 180.0).cos());
    (
        round4(lat + (a - 0.5) * 1.4),
        round4(lng + ((b - 0.5) * 1.8) / cos),
    )
}

fn lookup(table: &HashMap<&'static str, (f64, f64)>, raw: &Value) -> Option<(f64, f64)> {
    let Value::String(s) = raw else { return None };
    // "Rotterdam, Netherlands" / "Rotterdam 3011" — progressively shorter heads.
    let cleaned = s.trim().to_lowercase();
    if cleaned.is_empty() {
        return None;
    }
    if let Some(hit) = table.get(cleaned.as_str()) {
        return Some(*hit);
    }
    let head = cleaned
        .split([',', ';', '|'])
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if !head.is_empty() {
        if let Some(hit) = table.get(head.as_str()) {
            return Some(*hit);
        }
    }
    let words: Vec<&str> = head.split_whitespace().collect();
    if words.len() > 1 {
        if let Some(hit) = table.get(words[0]) {
            return Some(*hit);
        }
    }
    None
}

/// Options for resolve_geo_point.
pub struct ResolveGeoOptions<'a> {
    pub lat_property: Option<&'a str>,
    pub lng_property: Option<&'a str>,
    /// String property scanned for city/country names (e.g. 'city').
    pub fallback_property: Option<&'a str>,
    /// Object primary key — jitter seed.
    pub pk: &'a str,
    /// When false, skip deterministic jitter on centroid-resolved points.
    pub jitter: bool,
}

/// Resolve a row to a map coordinate: explicit lat/lng properties first,
/// then city centroids, then country centroids (fallback property first,
/// then any city/country/location-named string property on the row).
pub fn resolve_geo_point(values: &Row, opts: &ResolveGeoOptions<'_>) -> Option<GeoPoint> {
    let lat = opts
        .lat_property
        .and_then(|p| values.get(p))
        .and_then(to_finite_number);
    let lng = opts
        .lng_property
        .and_then(|p| values.get(p))
        .and_then(to_finite_number);
    if let (Some(lat), Some(lng)) = (lat, lng) {
        if lat.abs() <= 90.0 && lng.abs() <= 180.0 {
            return Some(GeoPoint {
                lat,
                lng,
                source: GeoSource::Property,
            });
        }
    }

    let mut candidates: Vec<&Value> = Vec::new();
    if let Some(fp) = opts.fallback_property {
        if let Some(v) = values.get(fp) {
            candidates.push(v);
        }
    }
    for (name, value) in values {
        if Some(name.as_str()) == opts.fallback_property {
            continue;
        }
        if CITY_NAME.is_match(name) || COUNTRY_NAME.is_match(name) || LOCATION_NAME.is_match(name) {
            candidates.push(value);
        }
    }

    for candidate in &candidates {
        if let Some((lat, lng)) = lookup(&CITY_CENTROIDS, candidate) {
            let (jlat, jlng) = if opts.jitter {
                jitter_point(opts.pk, lat, lng)
            } else {
                (lat, lng)
            };
            return Some(GeoPoint {
                lat: jlat,
                lng: jlng,
                source: GeoSource::City,
            });
        }
    }
    for candidate in &candidates {
        if let Some((lat, lng)) = lookup(&COUNTRY_CENTROIDS, candidate) {
            let (jlat, jlng) = if opts.jitter {
                jitter_point(opts.pk, lat, lng)
            } else {
                (lat, lng)
            };
            return Some(GeoPoint {
                lat: jlat,
                lng: jlng,
                source: GeoSource::Country,
            });
        }
    }
    None
}

// ─── Styling helpers shared by map layers ─────────────────────────────────

/// Ontology accent key → map marker hex.
pub static OBJECT_COLOR_HEX: Lazy<HashMap<&'static str, &'static str>> = Lazy::new(|| {
    HashMap::from([
        ("emerald", "#10b981"),
        ("teal", "#14b8a6"),
        ("amber", "#f59e0b"),
        ("rose", "#f43f5e"),
        ("orange", "#f97316"),
        ("zinc", "#71717a"),
    ])
});

/// Categorical palette for colorBy legends (Tableau-10-ish, dark-mode safe).
pub const CATEGORY_PALETTE: [&str; 10] = [
    "#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc948", "#b07aa1", "#ff9da7",
    "#9c755f", "#bab0ac",
];

/// Stable category → palette color assignment (sorted unique keys; sort
/// approximates JS localeCompare with case-insensitive primary order).
pub fn category_colors<'a, I: IntoIterator<Item = &'a String>>(values: I) -> Vec<(String, &'static str)> {
    let mut unique: Vec<&String> = values.into_iter().collect();
    unique.sort_by(|a, b| {
        a.to_lowercase()
            .cmp(&b.to_lowercase())
            .then_with(|| a.cmp(b))
    });
    unique.dedup();
    unique
        .into_iter()
        .enumerate()
        .map(|(i, v)| (v.clone(), CATEGORY_PALETTE[i % CATEGORY_PALETTE.len()]))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row(v: Value) -> Row {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn explicit_coords_win() {
        let values = row(json!({"lat": 51.92, "lng": 4.48, "city": "Rotterdam"}));
        let p = resolve_geo_point(
            &values,
            &ResolveGeoOptions {
                lat_property: Some("lat"),
                lng_property: Some("lng"),
                fallback_property: Some("city"),
                pk: "W1",
                jitter: true,
            },
        )
        .unwrap();
        assert_eq!(p.lat, 51.92);
        assert_eq!(p.lng, 4.48);
        assert_eq!(p.source, GeoSource::Property);
    }

    #[test]
    fn out_of_range_coords_fall_through_to_centroid() {
        let values = row(json!({"lat": 555, "lng": 4.48, "city": "Rotterdam"}));
        let p = resolve_geo_point(
            &values,
            &ResolveGeoOptions {
                lat_property: Some("lat"),
                lng_property: Some("lng"),
                fallback_property: Some("city"),
                pk: "W1",
                jitter: false,
            },
        )
        .unwrap();
        assert_eq!(p.source, GeoSource::City);
        assert_eq!((p.lat, p.lng), (51.92, 4.48));
    }

    #[test]
    fn string_coords_accepted() {
        let values = row(json!({"latitude": "48.86", "longitude": "2.35"}));
        let p = resolve_geo_point(
            &values,
            &ResolveGeoOptions {
                lat_property: Some("latitude"),
                lng_property: Some("longitude"),
                fallback_property: None,
                pk: "X",
                jitter: true,
            },
        )
        .unwrap();
        assert_eq!(p.source, GeoSource::Property);
        assert_eq!(p.lat, 48.86);
    }

    #[test]
    fn detect_lat_lng_by_name() {
        let props = vec![
            PropertyLike { api_name: "geoLat", data_type: "number" },
            PropertyLike { api_name: "lon", data_type: "number" },
            PropertyLike { api_name: "lat", data_type: "string" }, // non-numeric ignored
        ];
        let d = detect_lat_lng_properties(&props);
        assert_eq!(d.lat.as_deref(), Some("geoLat"));
        assert_eq!(d.lng.as_deref(), Some("lon"));
        let none = detect_lat_lng_properties(&[PropertyLike { api_name: "x1", data_type: "number" }]);
        assert_eq!(none, LatLngProps::default());
        // 'x'/'y' are coordinate names
        let xy = detect_lat_lng_properties(&[
            PropertyLike { api_name: "y", data_type: "number" },
            PropertyLike { api_name: "x", data_type: "number" },
        ]);
        assert_eq!(xy.lat.as_deref(), Some("y"));
        assert_eq!(xy.lng.as_deref(), Some("x"));
    }

    #[test]
    fn fallback_detection_city_beats_country() {
        let props = vec![
            PropertyLike { api_name: "country", data_type: "string" },
            PropertyLike { api_name: "city", data_type: "string" },
            PropertyLike { api_name: "address", data_type: "string" },
        ];
        assert_eq!(detect_fallback_property(&props).as_deref(), Some("city"));
        let only_country = vec![
            PropertyLike { api_name: "nation", data_type: "string" },
            PropertyLike { api_name: "address", data_type: "string" },
        ];
        assert_eq!(detect_fallback_property(&only_country).as_deref(), Some("nation"));
        let only_loc = vec![PropertyLike { api_name: "location", data_type: "string" }];
        assert_eq!(detect_fallback_property(&only_loc).as_deref(), Some("location"));
        let none: Vec<PropertyLike> = vec![];
        assert_eq!(detect_fallback_property(&none), None);
    }

    #[test]
    fn city_centroid_with_composite_value() {
        // fallback property missing → auto-scan finds 'city'
        let values = row(json!({"city": "Rotterdam, Netherlands"}));
        let p = resolve_geo_point(
            &values,
            &ResolveGeoOptions {
                lat_property: None,
                lng_property: None,
                fallback_property: None,
                pk: "W2",
                jitter: false,
            },
        )
        .unwrap();
        assert_eq!(p.source, GeoSource::City);
        assert_eq!((p.lat, p.lng), (51.92, 4.48));
    }

    #[test]
    fn country_centroid_after_city_miss() {
        let values = row(json!({"city": "Nowhere", "country": "Germany"}));
        let p = resolve_geo_point(
            &values,
            &ResolveGeoOptions {
                lat_property: None,
                lng_property: None,
                fallback_property: Some("city"),
                pk: "S1",
                jitter: false,
            },
        )
        .unwrap();
        assert_eq!(p.source, GeoSource::Country);
        assert_eq!((p.lat, p.lng), (51.1, 10.4));
    }

    #[test]
    fn unresolved_returns_none() {
        let values = row(json!({"city": "Atlantis", "name": "x"}));
        assert!(resolve_geo_point(
            &values,
            &ResolveGeoOptions {
                lat_property: None,
                lng_property: None,
                fallback_property: Some("city"),
                pk: "S1",
                jitter: true,
            }
        )
        .is_none());
    }

    #[test]
    fn jitter_is_deterministic_and_bounded() {
        let (a1, o1) = jitter_point("W1", 51.92, 4.48);
        let (a2, o2) = jitter_point("W1", 51.92, 4.48);
        assert_eq!((a1, o1), (a2, o2));
        assert!((a1 - 51.92).abs() <= 0.71);
        assert!((o1 - 4.48).abs() <= 1.5); // lng spread is cosine-scaled
        let (a3, _) = jitter_point("W2", 51.92, 4.48);
        assert_ne!(a1, a3);
        // rounded to 4 decimals
        assert_eq!(a1, round4(a1));
    }

    #[test]
    fn hash01_in_unit_interval() {
        for s in ["a", "abc|lat", "SHP-0001|lng", ""] {
            let h = hash01(s);
            assert!((0.0..1.0).contains(&h), "{s} -> {h}");
        }
    }

    #[test]
    fn category_colors_stable_assignment() {
        let values = ["NA".to_string(), "EMEA".to_string(), "NA".to_string(), "APAC".to_string()];
        let colors = category_colors(values.iter());
        assert_eq!(
            colors,
            vec![
                ("APAC".to_string(), CATEGORY_PALETTE[0]),
                ("EMEA".to_string(), CATEGORY_PALETTE[1]),
                ("NA".to_string(), CATEGORY_PALETTE[2]),
            ]
        );
    }
}
