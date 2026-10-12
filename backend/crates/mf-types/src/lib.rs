//! MiniFoundry — shared domain contracts.
//!
//! This crate is the Rust source of truth for the JSON shapes the frontend
//! consumes (originally specified by `frontend/src/lib/foundry-types.ts` and
//! the old Next.js `src/lib/api-utils.ts`). Every field name and casing here
//! MUST match the original contract exactly — golden-contract tests enforce it.
//!
//! Key conventions:
//! - Rows are insertion-ordered JSON objects (serde_json `preserve_order`).
//! - Timestamps serialize as ISO-8601 UTC with exactly 3 fraction digits + `Z`
//!   (`2026-02-12T03:04:05.123Z`) — byte-identical to `Date#toJSON()` output
//!   produced by the old Prisma/Next.js stack.
//! - Error bodies are `{ "error": "...", "detail"?: ... }` (see mf-web).

use serde::{Deserialize, Serialize};

pub use serde_json::{Map, Value};

/// A dataset row: insertion-ordered JSON object of column → value.
/// Values are `string | number | boolean | null` after sanitization.
pub type Row = Map<String, Value>;

/// Generic insertion-ordered JSON object (configs, payloads, layouts...).
pub type JsonObject = Map<String, Value>;

// ─── Timestamp serialization (Prisma/Date#toJSON compatible) ────────────

/// `#[serde(with = "mf_types::ts")]` on `DateTime<Utc>` fields.
pub mod ts {
    use chrono::{DateTime, SecondsFormat, Utc};
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S>(dt: &DateTime<Utc>, s: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        s.serialize_str(&dt.to_rfc3339_opts(SecondsFormat::Millis, true))
    }

    pub fn deserialize<'de, D>(d: D) -> Result<DateTime<Utc>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = String::deserialize(d)?;
        parse_ts(&raw).map_err(serde::de::Error::custom)
    }

    /// Accept anything `DateTime::parse_from_rfc3339` accepts (also space
    /// separator + naive fallback), normalizing to UTC.
    pub fn parse_ts(raw: &str) -> Result<DateTime<Utc>, String> {
        if let Ok(dt) = DateTime::parse_from_rfc3339(raw) {
            return Ok(dt.with_timezone(&Utc));
        }
        if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M:%S%.f") {
            return Ok(naive.and_utc());
        }
        Err(format!("invalid timestamp: {raw}"))
    }

    /// Format for API output: `2026-02-12T03:04:05.123Z`.
    pub fn format(dt: &DateTime<Utc>) -> String {
        dt.to_rfc3339_opts(SecondsFormat::Millis, true)
    }
}

/// `#[serde(with = "mf_types::ts_opt")]` on `Option<DateTime<Utc>>` fields.
pub mod ts_opt {
    use chrono::{DateTime, Utc};
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S>(dt: &Option<DateTime<Utc>>, s: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match dt {
            Some(dt) => super::ts::serialize(dt, s),
            None => s.serialize_none(),
        }
    }

    pub fn deserialize<'de, D>(d: D) -> Result<Option<DateTime<Utc>>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let opt = Option::<String>::deserialize(d)?;
        match opt {
            Some(raw) => super::ts::parse_ts(&raw)
                .map(Some)
                .map_err(serde::de::Error::custom),
            None => Ok(None),
        }
    }
}

// ─── Dataset schema ─────────────────────────────────────────────────────

/// Column type of a dataset schema entry. JSON: `"string" | "number" | "boolean"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ColumnType {
    String,
    Number,
    Boolean,
}

/// One dataset schema column. JSON contract: `{ "name": "...", "type": "string" }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SchemaColumn {
    pub name: String,
    #[serde(rename = "type")]
    pub column_type: ColumnType,
}

// ─── Run logs ───────────────────────────────────────────────────────────

/// Log level used by pipeline/transform run logs. JSON: lowercase strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Info,
    Warn,
    Error,
    Success,
}

/// One run-log line. JSON contract: `{ "ts": "...", "level": "info", "msg": "..." }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LogEntry {
    /// ISO-8601 UTC string (millis + Z), same as `new Date().toISOString()`.
    pub ts: String,
    pub level: LogLevel,
    pub msg: String,
}

impl LogEntry {
    pub fn new(level: LogLevel, msg: impl Into<String>) -> Self {
        Self {
            ts: ts::format(&chrono::Utc::now()),
            level,
            msg: msg.into(),
        }
    }
    pub fn info(msg: impl Into<String>) -> Self {
        Self::new(LogLevel::Info, msg)
    }
    pub fn warn(msg: impl Into<String>) -> Self {
        Self::new(LogLevel::Warn, msg)
    }
    pub fn error(msg: impl Into<String>) -> Self {
        Self::new(LogLevel::Error, msg)
    }
    pub fn success(msg: impl Into<String>) -> Self {
        Self::new(LogLevel::Success, msg)
    }
}

// ─── JSON boundary helpers ──────────────────────────────────────────────

/// Port of `parseJsonSafe` — parse a stored JSON value with a fallback.
pub fn parse_json_safe<T: serde::de::DeserializeOwned>(raw: Option<&str>, fallback: T) -> T {
    match raw {
        Some(s) if !s.is_empty() => serde_json::from_str(s).unwrap_or(fallback),
        _ => fallback,
    }
}

/// Cell sanitization shared by every row-producing path (SQL results,
/// ingestion parsers, engine outputs). The legacy `sanitizeCell` normalized
/// driver-specific types (bigint→number, Date→ISO string, blob→"(blob)",
/// object→JSON string); with serde_json values those cases are already
/// normalized at the conversion sites (see mf-sqlrun), so this is the
/// identity pass kept as the single seam where future quirks land.
pub fn sanitize_cell(v: Value) -> Value {
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};

    #[test]
    fn ts_format_matches_js_date_to_json() {
        let dt = Utc.with_ymd_and_hms(2026, 2, 12, 3, 4, 5).unwrap()
            + chrono::Duration::milliseconds(123);
        assert_eq!(ts::format(&dt), "2026-02-12T03:04:05.123Z");
        let dt0 = Utc.with_ymd_and_hms(2026, 2, 12, 3, 4, 5).unwrap();
        assert_eq!(ts::format(&dt0), "2026-02-12T03:04:05.000Z");
    }

    #[test]
    fn schema_column_round_trip() {
        let col = SchemaColumn {
            name: "id".into(),
            column_type: ColumnType::String,
        };
        assert_eq!(
            serde_json::to_string(&col).unwrap(),
            r#"{"name":"id","type":"string"}"#
        );
        let back: SchemaColumn = serde_json::from_str(r#"{"name":"n","type":"number"}"#).unwrap();
        assert_eq!(back.column_type, ColumnType::Number);
    }

    #[test]
    fn log_entry_shape() {
        let e = LogEntry::info("hello");
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["level"], "info");
        assert_eq!(v["msg"], "hello");
        assert!(v["ts"].as_str().unwrap().ends_with('Z'));
    }

    #[test]
    fn parse_json_safe_falls_back() {
        assert_eq!(
            parse_json_safe::<Vec<String>>(None, vec![]),
            Vec::<String>::new()
        );
        assert_eq!(
            parse_json_safe::<Vec<String>>(Some("not json"), vec!["fb".into()]),
            vec!["fb".to_string()]
        );
        assert_eq!(
            parse_json_safe::<Vec<String>>(Some(r#"["a"]"#), vec![]),
            vec!["a".to_string()]
        );
    }

    #[test]
    fn row_preserves_insertion_order() {
        let raw = r#"{"z":1,"a":2,"m":3}"#;
        let row: Row = serde_json::from_str(raw).unwrap();
        let keys: Vec<&String> = row.keys().collect();
        assert_eq!(keys, vec!["z", "a", "m"]);
    }
}
