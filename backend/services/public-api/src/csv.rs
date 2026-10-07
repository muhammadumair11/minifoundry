//! M10 CSV export helpers (RFC4180) — port of src/lib/csv.ts, shared by the
//! v1 export route (the session export route lives in catalog).

use serde_json::Value;

/// JS `String(value)` for cell rendering: null → empty; objects/arrays →
/// compact JSON; strings as-is; numbers/bools via serde Display.
fn cell_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Object(_) | Value::Array(_) => value.to_string(),
        other => other.to_string(),
    }
}

/// One CSV cell per RFC4180: quote when the value contains a comma, double
/// quote, newline or carriage return; double the quotes inside quotes.
pub fn csv_cell(value: &Value) -> String {
    let mut s = cell_text(value);
    if s.contains(['"', ',', '\n', '\r']) {
        s = format!("\"{}\"", s.replace('"', "\"\""));
    }
    s
}

/// Serialize rows to CSV text: header row from the schema column names, then
/// one row per record in schema column order (missing keys → empty cell,
/// extra keys dropped). Empty rows → header only. Always ends with '\n'.
pub fn rows_to_csv(schema: &[Value], rows: &[Value]) -> String {
    let names: Vec<String> = schema
        .iter()
        .map(|c| {
            c.get("name")
                .and_then(|n| n.as_str())
                .unwrap_or_default()
                .to_string()
        })
        .collect();
    let mut lines: Vec<String> = Vec::with_capacity(rows.len() + 1);
    lines.push(
        names
            .iter()
            .map(|n| csv_cell(&Value::String(n.clone())))
            .collect::<Vec<_>>()
            .join(","),
    );
    for row in rows {
        lines.push(
            names
                .iter()
                .map(|n| csv_cell(row.get(n).unwrap_or(&Value::Null)))
                .collect::<Vec<_>>()
                .join(","),
        );
    }
    format!("{}\n", lines.join("\n"))
}

/// URL/filesystem-safe slug for export filenames
/// ("Active Shipments" → "active-shipments"). Port of `slugifyName`.
pub fn slugify_name(name: &str) -> String {
    let lower = name.trim().to_lowercase();
    let mut slug = String::with_capacity(lower.len());
    let mut prev_dash = false;
    for c in lower.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            slug.push(c);
            prev_dash = false;
        } else if !prev_dash {
            slug.push('-');
            prev_dash = true;
        }
    }
    let trimmed = slug.trim_matches('-');
    let truncated: String = trimmed.chars().take(64).collect();
    if truncated.is_empty() {
        "dataset".to_string()
    } else {
        truncated
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn col(name: &str) -> Value {
        json!({ "name": name, "type": "string" })
    }

    #[test]
    fn csv_matches_legacy_rules() {
        let schema = vec![col("a"), col("b"), col("c")];
        let rows = vec![
            json!({ "a": "plain", "b": 22, "c": null }),
            json!({ "a": "has,comma", "b": "quo\"te", "c": true }),
            json!({ "a": "line\nbreak", "b": 1.5, "extra": "dropped" }),
            json!({ "b": "missing a and c" }),
        ];
        let csv = rows_to_csv(&schema, &rows);
        assert_eq!(
            csv,
            "a,b,c\n\
             plain,22,\n\
             \"has,comma\",\"quo\"\"te\",true\n\
             \"line\nbreak\",1.5,\n\
             ,missing a and c,\n"
        );
    }

    #[test]
    fn empty_rows_emit_header_only() {
        assert_eq!(rows_to_csv(&[col("x")], &[]), "x\n");
        assert_eq!(rows_to_csv(&[], &[]), "\n");
    }

    #[test]
    fn slugify_matches_legacy() {
        assert_eq!(slugify_name("Active Shipments"), "active-shipments");
        assert_eq!(slugify_name("  Supplier Risk Scores  "), "supplier-risk-scores");
        assert_eq!(slugify_name("Ünïcödé — Name"), "n-c-d-name");
        assert_eq!(slugify_name("!!!"), "dataset");
        assert_eq!(slugify_name(""), "dataset");
        let long = "a".repeat(80);
        assert_eq!(slugify_name(&long).chars().count(), 64);
    }
}
