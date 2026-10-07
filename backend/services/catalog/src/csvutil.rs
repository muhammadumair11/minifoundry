//! CSV helpers — exact port of src/lib/csv.ts (RFC4180 export) plus a
//! papaparse-compatible reader (header mode, skipEmptyLines, no dynamic
//! typing) for the ingestion parsers.

use mf_types::{Row, SchemaColumn, Value};
use serde_json::Map;

// ─── Export (csv.ts) ────────────────────────────────────────────────────

/// Render one CSV cell per RFC4180: quote when the value contains a comma,
/// double quote, newline or carriage return; double the quotes inside quotes.
/// null → empty cell; objects/arrays → compact JSON.
pub fn csv_cell(value: &Value) -> String {
    let mut s = match value {
        Value::Null => return String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => crate::jsval::js_number_string(n),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    if s.contains(['"', ',', '\n', '\r']) {
        s = format!("\"{}\"", s.replace('"', "\"\""));
    }
    s
}

/// Serialize rows to CSV text: header row from the schema column names, then
/// one row per record in schema column order (missing keys → empty cell,
/// extra keys dropped). Output always ends with a single newline.
pub fn rows_to_csv(schema: &[SchemaColumn], rows: &[Row]) -> String {
    let mut lines: Vec<String> = Vec::with_capacity(rows.len() + 1);
    lines.push(
        schema
            .iter()
            .map(|c| csv_cell(&Value::String(c.name.clone())))
            .collect::<Vec<_>>()
            .join(","),
    );
    for row in rows {
        lines.push(
            schema
                .iter()
                .map(|c| csv_cell(row.get(&c.name).unwrap_or(&Value::Null)))
                .collect::<Vec<_>>()
                .join(","),
        );
    }
    format!("{}\n", lines.join("\n"))
}

/// URL/filesystem-safe slug for export filenames.
pub fn slugify_name(name: &str) -> String {
    let re_invalid = regex::Regex::new(r"[^a-z0-9]+").unwrap();
    let re_edges = regex::Regex::new(r"^-+|-+$").unwrap();
    let slug = name.trim().to_lowercase();
    let slug = re_invalid.replace_all(&slug, "-");
    let slug = re_edges.replace_all(&slug, "");
    let slug: String = slug.chars().take(64).collect();
    if slug.is_empty() {
        "dataset".to_string()
    } else {
        slug
    }
}

// ─── Import (papaparse-compatible) ──────────────────────────────────────

/// Parse CSV text into row objects — papaparse with `{ header: true,
/// skipEmptyLines: true, dynamicTyping: false }`:
/// - first non-empty record holds the column names (kept verbatim);
/// - every value is a string; quoted fields may contain commas/newlines and
///   `""`-escaped quotes; \r\n, \n and \r all end records;
/// - records shorter than the header omit the missing keys; extra fields land
///   under `__parsed_extra` (string when one, array when several).
pub fn parse_csv_rows(text: &str) -> Vec<Row> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let all = split_csv_records(text);
    let kept: Vec<Vec<String>> = all
        .into_iter()
        .filter(|r| !(r.fields.len() == 1 && r.fields[0].is_empty() && !r.quoted_single))
        .map(|r| r.fields)
        .collect();
    let Some((headers, rest)) = kept.split_first() else {
        return Vec::new();
    };
    rest.iter()
        .map(|fields| {
            let mut row = Map::new();
            for (i, h) in headers.iter().enumerate() {
                if let Some(v) = fields.get(i) {
                    row.insert(h.clone(), Value::String(v.clone()));
                }
            }
            if fields.len() > headers.len() {
                let extras: Vec<String> = fields[headers.len()..].to_vec();
                let value = if extras.len() == 1 {
                    Value::String(extras[0].clone())
                } else {
                    Value::Array(extras.into_iter().map(Value::String).collect())
                };
                row.insert("__parsed_extra".to_string(), value);
            }
            row
        })
        .collect()
}

struct CsvRecord {
    fields: Vec<String>,
    /// True when the record was a single empty QUOTED field (`""`) — papaparse
    /// keeps those (skipEmptyLines only drops bare empty lines).
    quoted_single: bool,
}

/// RFC4180 record splitter with quote support.
fn split_csv_records(text: &str) -> Vec<CsvRecord> {
    let mut records = Vec::new();
    let mut fields: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut field_was_quoted = false;
    let mut any_quoted = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if in_quotes {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    current.push('"');
                } else {
                    in_quotes = false;
                }
            } else {
                current.push(c);
            }
            continue;
        }
        match c {
            '"' => {
                in_quotes = true;
                field_was_quoted = true;
                any_quoted = true;
            }
            ',' => {
                fields.push(std::mem::take(&mut current));
                field_was_quoted = false;
            }
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                fields.push(std::mem::take(&mut current));
                records.push(CsvRecord {
                    quoted_single: fields.len() == 1 && fields[0].is_empty() && any_quoted,
                    fields: std::mem::take(&mut fields),
                });
                any_quoted = false;
                field_was_quoted = false;
            }
            '\n' => {
                fields.push(std::mem::take(&mut current));
                records.push(CsvRecord {
                    quoted_single: fields.len() == 1 && fields[0].is_empty() && any_quoted,
                    fields: std::mem::take(&mut fields),
                });
                any_quoted = false;
                field_was_quoted = false;
            }
            _ => current.push(c),
        }
    }
    // trailing record (no final newline) — a quoted-empty final field counts
    if !current.is_empty() || !fields.is_empty() || field_was_quoted {
        fields.push(current);
        records.push(CsvRecord {
            quoted_single: fields.len() == 1 && fields[0].is_empty() && any_quoted,
            fields,
        });
    }
    records
}

#[cfg(test)]
mod tests {
    use super::*;
    use mf_types::ColumnType;
    use serde_json::json;

    fn schema(names: &[(&str, ColumnType)]) -> Vec<SchemaColumn> {
        names
            .iter()
            .map(|(n, t)| SchemaColumn {
                name: n.to_string(),
                column_type: *t,
            })
            .collect()
    }

    #[test]
    fn csv_cell_quoting_matches_rfc4180() {
        assert_eq!(csv_cell(&json!("plain")), "plain");
        assert_eq!(csv_cell(&json!("a,b")), "\"a,b\"");
        assert_eq!(csv_cell(&json!("say \"hi\"")), "\"say \"\"hi\"\"\"");
        assert_eq!(csv_cell(&json!("line\nbreak")), "\"line\nbreak\"");
        assert_eq!(csv_cell(&Value::Null), "");
        assert_eq!(csv_cell(&json!(true)), "true");
        assert_eq!(csv_cell(&json!(22)), "22");
        assert_eq!(csv_cell(&json!(97.2)), "97.2");
        // objects → compact JSON, then quoted (contains quotes) — like JS
        assert_eq!(csv_cell(&json!({"a":1})), "\"{\"\"a\"\":1}\"");
        assert_eq!(csv_cell(&json!([1, "x"])), "\"[1,\"\"x\"\"]\"");
    }

    #[test]
    fn rows_to_csv_matches_fixture_export() {
        // Golden: contracts/reads/dataset-export.json
        let s = schema(&[
            ("supplier", ColumnType::String),
            ("region", ColumnType::String),
            ("risk_score", ColumnType::Number),
            ("tier", ColumnType::String),
        ]);
        let rows: Vec<Row> = vec![
            serde_json::from_str(
                r#"{"supplier":"Northline Foods","region":"EMEA","risk_score":22,"tier":"A"}"#,
            )
            .unwrap(),
            serde_json::from_str(
                r#"{"supplier":"Pacific Metals","region":"APAC","risk_score":58,"tier":"B"}"#,
            )
            .unwrap(),
            serde_json::from_str(
                r#"{"supplier":"Andes Textiles","region":"LATAM","risk_score":41,"tier":"B"}"#,
            )
            .unwrap(),
            serde_json::from_str(
                r#"{"supplier":"Gulf Plastics","region":"EMEA","risk_score":140,"tier":"C"}"#,
            )
            .unwrap(),
            serde_json::from_str(
                r#"{"supplier":"Baltic Grain Co","region":"EMEA","risk_score":15,"tier":"A"}"#,
            )
            .unwrap(),
        ];
        let expected = "supplier,region,risk_score,tier\n\
             Northline Foods,EMEA,22,A\n\
             Pacific Metals,APAC,58,B\n\
             Andes Textiles,LATAM,41,B\n\
             Gulf Plastics,EMEA,140,C\n\
             Baltic Grain Co,EMEA,15,A\n";
        assert_eq!(rows_to_csv(&s, &rows), expected);
    }

    #[test]
    fn rows_to_csv_schema_order_and_missing_keys() {
        let s = schema(&[("b", ColumnType::String), ("a", ColumnType::String)]);
        let rows: Vec<Row> = vec![serde_json::from_str(r#"{"a":"1","c":"x"}"#).unwrap()];
        // header order follows schema; missing b → empty; extra c dropped
        assert_eq!(rows_to_csv(&s, &rows), "b,a\n,1\n");
        // no rows → header only, still newline-terminated
        assert_eq!(rows_to_csv(&s, &[]), "b,a\n");
    }

    #[test]
    fn slugify_matches_legacy() {
        assert_eq!(slugify_name("Active Shipments"), "active-shipments");
        assert_eq!(
            slugify_name("  Supplier Risk Scores  "),
            "supplier-risk-scores"
        );
        assert_eq!(slugify_name("--x--"), "x");
        assert_eq!(slugify_name("!!!"), "dataset");
        assert_eq!(slugify_name("a_b.c-d"), "a-b-c-d");
    }

    #[test]
    fn csv_parse_basic() {
        let rows = parse_csv_rows("a,b\n1,x\n2,y\n");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["a"], json!("1"));
        assert_eq!(rows[1]["b"], json!("y"));
    }

    #[test]
    fn csv_parse_quotes_commas_newlines_crlf() {
        let rows =
            parse_csv_rows("name,note\r\n\"Doe, John\",\"line1\nline2\"\r\n\"say \"\"hi\"\"\",x\n");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["name"], json!("Doe, John"));
        assert_eq!(rows[0]["note"], json!("line1\nline2"));
        assert_eq!(rows[1]["name"], json!("say \"hi\""));
    }

    #[test]
    fn csv_parse_skips_empty_lines_keeps_quoted_empty() {
        let rows = parse_csv_rows("a\n1\n\n2\n");
        assert_eq!(rows.len(), 2);
        // a single "" record is NOT an empty line
        let rows = parse_csv_rows("a\n\"\"\n");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["a"], json!(""));
    }

    #[test]
    fn csv_parse_short_and_long_records() {
        let rows = parse_csv_rows("a,b,c\n1,2\n3,4,5,6\n");
        assert_eq!(rows.len(), 2);
        assert!(rows[0].get("c").is_none()); // short row omits missing keys
        assert_eq!(rows[0]["a"], json!("1"));
        assert_eq!(rows[1]["__parsed_extra"], json!("6")); // single extra → string
        let rows = parse_csv_rows("a\n1,2,3\n");
        assert_eq!(rows[1 - 1]["__parsed_extra"], json!(["2", "3"]));
    }

    #[test]
    fn csv_parse_bom_and_no_trailing_newline() {
        let rows = parse_csv_rows("\u{feff}a,b\n1,2");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["b"], json!("2"));
    }

    #[test]
    fn csv_parse_empty_input() {
        assert!(parse_csv_rows("").is_empty());
        assert!(parse_csv_rows("\n\n").is_empty());
    }
}
