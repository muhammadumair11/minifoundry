//! Concrete [`JsEngine`] built on **rquickjs** (QuickJS compiled from its own
//! C sources — no system dependencies).
//!
//! Sandboxing posture (ports isolated-runner.ts + execDerive guarantees):
//! - a FRESH `Runtime` + `Context` per call (nothing leaks between batches);
//! - no IO globals: QuickJS ships no fetch/require/console/process and we
//!   register none — `ctx.globals()` stays the standard intrinsic set;
//! - wall-clock timeout via the runtime interrupt handler (checked by QuickJS
//!   at loop back-edges/calls);
//! - hard memory limit via `Runtime::set_memory_limit` (default 64 MiB);
//! - `Runtime`/`Ctx` are `!Send` in practice for our use pattern, so the
//!   engine struct itself holds only limits and every method builds its own
//!   runtime — `QuickJsEngine` is trivially `Send + Sync` and cheap to create.
//!
//! Value conversion uses QuickJS' own JSON.parse/JSON.stringify so numeric
//! formatting matches JS exactly (whole floats print as `3`, not `3.0`;
//! NaN/Infinity serialize to `null` — the legacy `JSON.stringify` boundary).

use crate::{JsEngine, JsError, JsLimits};
use rquickjs::{Context, Ctx, Exception, FromJs, Function, Runtime, Value};
use serde_json::Value as Json;
use std::time::{Duration, Instant};

/// Default hard memory cap per evaluation runtime (bytes).
pub const DEFAULT_MEMORY_LIMIT: usize = 64 * 1024 * 1024;

/// rquickjs-backed engine. Construction is cheap (limit knobs only); each
/// `eval_*` call creates a fresh Runtime + Context internally.
#[derive(Debug, Clone)]
pub struct QuickJsEngine {
    memory_limit: usize,
    /// Generous wall-clock cap for a whole derive batch (legacy had none; see
    /// the JsEngine::eval_derive contract — timeouts degrade to per-row nulls).
    derive_timeout: Duration,
}

impl Default for QuickJsEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl QuickJsEngine {
    pub fn new() -> Self {
        Self {
            memory_limit: DEFAULT_MEMORY_LIMIT,
            derive_timeout: JsLimits::default().timeout,
        }
    }

    /// Override the limits (used by tests; production callers use [`new`]).
    pub fn with_limits(memory_limit: usize, derive_timeout: Duration) -> Self {
        Self {
            memory_limit,
            derive_timeout,
        }
    }

    fn runtime(&self) -> Result<Runtime, JsError> {
        let rt = Runtime::new()
            .map_err(|e| JsError::Unavailable(format!("cannot create QuickJS runtime: {e}")))?;
        rt.set_memory_limit(self.memory_limit);
        Ok(rt)
    }

    fn context(rt: &Runtime) -> Result<Context, JsError> {
        Context::full(rt)
            .map_err(|e| JsError::Unavailable(format!("cannot create QuickJS context: {e}")))
    }
}

/// Legacy identifier filter from execDerive: `/^[a-zA-Z_$][a-zA-Z0-9_$]*$/`.
fn is_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' || c == '$' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

/// Message of the pending JS exception (consumes/clears it via `ctx.catch()`).
fn exception_message(ctx: &Ctx<'_>) -> String {
    let value = ctx.catch();
    if value.is_null() {
        return "unknown error".to_string();
    }
    if let Ok(ex) = Exception::from_js(ctx, value.clone()) {
        if let Some(msg) = ex.message() {
            if !msg.is_empty() {
                return msg.to_string();
            }
        }
    }
    // `throw 'plain string'` (or any non-Error throw): stringify the value.
    if let Some(s) = value.as_string() {
        if let Ok(text) = s.to_string() {
            return text;
        }
    }
    format!("{value:?}")
}

/// Convert a JS value to serde_json using JSON.stringify semantics:
/// undefined/functions/symbols → `Null` (stringify yields undefined),
/// NaN/Infinity → `Null`, whole floats → integer JSON numbers (JS prints 3).
fn json_from_js<'js>(ctx: &Ctx<'js>, v: &Value<'js>) -> Result<Json, JsError> {
    if v.is_undefined() {
        return Ok(Json::Null);
    }
    let stringified = ctx.json_stringify(v.clone()).map_err(|_| {
        JsError::Runtime("script error: result is not JSON-serializable".to_string())
    })?;
    let Some(js_str) = stringified else {
        // JSON.stringify(undefined | function | symbol) === undefined
        return Ok(Json::Null);
    };
    let text = js_str
        .to_string()
        .map_err(|e| JsError::Runtime(format!("script error: {e}")))?;
    Ok(serde_json::from_str(&text).unwrap_or(Json::Null))
}

/// JS `typeof` label for a value (legacy validation messages use it verbatim).
fn js_typeof(v: &Value<'_>) -> &'static str {
    if v.is_undefined() {
        "undefined"
    } else if v.is_bool() {
        "boolean"
    } else if v.is_number() {
        "number"
    } else if v.is_string() {
        "string"
    } else if v.is_function() {
        "function"
    } else if v.is_symbol() {
        "symbol"
    } else if v.as_big_int().is_some() {
        "bigint"
    } else {
        "object"
    }
}

/// serde_json → JS value via QuickJS' own JSON.parse (exact JSON semantics,
/// insertion order preserved by both sides).
fn js_from_json<'js>(ctx: &Ctx<'js>, v: &Json) -> Result<Value<'js>, JsError> {
    let bytes = serde_json::to_vec(v).unwrap_or_else(|_| b"null".to_vec());
    ctx.json_parse(bytes)
        .map_err(|_| JsError::Runtime("script error: input is not JSON-serializable".to_string()))
}

/// Convert a validated workbook cell (string|number|boolean|null) to JSON.
/// NaN/Infinity become Null (the legacy JSON.stringify-at-storage boundary).
fn cell_to_json(v: &Value<'_>) -> Json {
    if v.is_null() || v.is_undefined() {
        return Json::Null;
    }
    if let Some(b) = v.as_bool() {
        return Json::Bool(b);
    }
    if let Some(s) = v.as_string() {
        return match s.to_string() {
            Ok(text) => Json::String(text),
            Err(_) => Json::Null,
        };
    }
    if let Some(n) = v.as_number() {
        if !n.is_finite() {
            return Json::Null;
        }
        if n == n.trunc() && n.abs() < 2.0f64.powi(53) {
            return Json::from(n as i64);
        }
        return serde_json::Number::from_f64(n)
            .map(Json::Number)
            .unwrap_or(Json::Null);
    }
    Json::Null
}

/// Port of isolated-runner.ts `validateRunnerRows` — exact error messages.
fn validate_rows<'js>(
    ctx: &Ctx<'js>,
    result: &Value<'js>,
    max_rows: usize,
) -> Result<Vec<Json>, JsError> {
    let Some(array) = result.as_array() else {
        let got = if result.is_null() {
            "null"
        } else {
            js_typeof(result)
        };
        return Err(JsError::InvalidResult(format!(
            "transform must return an array of row objects (got {got})"
        )));
    };
    let len = array.len();
    if len > max_rows {
        return Err(JsError::InvalidResult(format!(
            "transform returned {len} rows; limit is {max_rows}"
        )));
    }
    let mut out = Vec::with_capacity(len);
    for i in 0..len {
        let el: Value<'js> = array
            .get(i)
            .map_err(|e| JsError::Runtime(format!("script error: {e}")))?;
        let Some(obj) = el.as_object() else {
            let got = if el.is_null() { "null" } else { js_typeof(&el) };
            return Err(JsError::InvalidResult(format!(
                "row {i}: expected a plain object (got {got})"
            )));
        };
        if obj.is_array() {
            return Err(JsError::InvalidResult(format!(
                "row {i}: expected a plain object (got array)"
            )));
        }
        let mut row = serde_json::Map::new();
        for prop in obj.props() {
            let (key, value): (Value<'js>, Value<'js>) =
                prop.map_err(|e| JsError::Runtime(format!("script error: {e}")))?;
            // Object.entries() only sees string keys — symbols are skipped.
            let Some(key_str) = key.as_string() else {
                continue;
            };
            let Ok(name) = key_str.to_string() else {
                continue;
            };
            let ok = value.is_string() || value.is_number() || value.is_bool() || value.is_null();
            if !ok {
                return Err(JsError::InvalidResult(format!(
                    "row {i} column \"{name}\": value must be string|number|boolean|null (got {})",
                    js_typeof(&value)
                )));
            }
            row.insert(name, cell_to_json(&value));
        }
        out.push(Json::Object(row));
    }
    let _ = ctx; // reserved for future ctx-aware validation paths
    Ok(out)
}

impl JsEngine for QuickJsEngine {
    fn eval_derive(
        &self,
        expression: &str,
        columns: &[String],
        rows: &[Json],
    ) -> Result<(Vec<Json>, usize), JsError> {
        let rt = self.runtime()?;
        let ctx = Self::context(&rt)?;
        let deadline = Instant::now() + self.derive_timeout;
        rt.set_interrupt_handler(Some(Box::new(move || Instant::now() >= deadline)));

        ctx.with(|ctx| {
            // Legacy two-step compile: destructured bare identifiers first,
            // then the row-only fallback; Compile carries the FIRST error
            // (`compileError ?? fallbackError` in execDerive).
            let ident_cols: Vec<&str> = columns
                .iter()
                .map(|s| s.as_str())
                .filter(|s| is_identifier(s))
                .collect();
            let mut first_error: Option<String> = None;
            let mut func: Option<Function<'_>> = None;
            if !ident_cols.is_empty() {
                let src = format!(
                    "(function __f(row){{ var {{{}}} = row; return ({expression}); }})",
                    ident_cols.join(", ")
                );
                match ctx.eval::<Function<'_>, _>(src) {
                    Ok(f) => func = Some(f),
                    Err(_) => first_error = Some(exception_message(&ctx)),
                }
            }
            if func.is_none() {
                let src = format!("(function __f(row){{ return ({expression}); }})");
                match ctx.eval::<Function<'_>, _>(src) {
                    Ok(f) => func = Some(f),
                    Err(_) => {
                        let msg = first_error.unwrap_or_else(|| exception_message(&ctx));
                        return Err(JsError::Compile(msg));
                    }
                }
            }
            let func = func.expect("compiled function");

            let mut values = Vec::with_capacity(rows.len());
            let mut failed = 0usize;
            for row in rows {
                // Timeout degrades to per-row failure (see the trait contract).
                if Instant::now() >= deadline {
                    failed += 1;
                    values.push(Json::Null);
                    continue;
                }
                let evaluated = (|| -> Result<Json, ()> {
                    let arg = js_from_json(&ctx, row).map_err(|_| ())?;
                    let out: Value<'_> = func.call((arg,)).map_err(|_| ())?;
                    if out.is_undefined() {
                        return Ok(Json::Null);
                    }
                    json_from_js(&ctx, &out).map_err(|_| ())
                })();
                match evaluated {
                    Ok(v) => values.push(v),
                    Err(()) => {
                        // Clear any pending exception so the next row starts clean.
                        let _ = ctx.catch();
                        failed += 1;
                        values.push(Json::Null);
                    }
                }
            }
            Ok((values, failed))
        })
    }

    fn eval_workbook(
        &self,
        source: &str,
        input: &Json,
        limits: &JsLimits,
    ) -> Result<Vec<Json>, JsError> {
        let timeout_ms = limits.timeout.as_millis();
        let rt = self.runtime()?;
        let ctx = Self::context(&rt)?;
        let deadline = Instant::now() + limits.timeout;
        rt.set_interrupt_handler(Some(Box::new(move || Instant::now() >= deadline)));

        ctx.with(|ctx| {
            // The source is a function BODY receiving `input` (legacy wrapped
            // it as `(function(input){\n<source>\n})(input)` inside
            // `new Function('input', ...)` — same scope, same semantics).
            let wrapped = format!("(function __wb(input){{\n{source}\n}})");
            let func: Function<'_> = match ctx.eval(wrapped) {
                Ok(f) => f,
                Err(_) => {
                    let msg = exception_message(&ctx);
                    return Err(JsError::Runtime(format!("script error: {msg}")));
                }
            };
            let arg = js_from_json(&ctx, input)?;
            let result: Value<'_> = match func.call((arg,)) {
                Ok(v) => v,
                Err(rquickjs::Error::Exception) => {
                    if Instant::now() >= deadline {
                        let _ = ctx.catch();
                        return Err(JsError::Timeout(format!(
                            "JavaScript execution timed out after {timeout_ms}ms"
                        )));
                    }
                    let msg = exception_message(&ctx);
                    return Err(JsError::Runtime(format!("script error: {msg}")));
                }
                Err(e) => return Err(JsError::Runtime(format!("script error: {e}"))),
            };
            validate_rows(&ctx, &result, limits.max_rows)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn limits(timeout: Duration, max_rows: usize) -> JsLimits {
        JsLimits { timeout, max_rows }
    }

    // ─── derive ─────────────────────────────────────────────────────────

    #[test]
    fn derive_arithmetic_with_bare_identifiers() {
        let engine = QuickJsEngine::new();
        let rows = vec![json!({"a": 2, "b": 3}), json!({"a": 10, "b": 0.5})];
        let (values, failed) = engine
            .eval_derive("a * b + 1", &["a".into(), "b".into()], &rows)
            .unwrap();
        assert_eq!(failed, 0);
        assert_eq!(values, vec![json!(7), json!(6)]);
    }

    #[test]
    fn derive_string_and_ternary() {
        let engine = QuickJsEngine::new();
        let rows = vec![
            json!({"status": "ok", "name": "x"}),
            json!({"status": "bad", "name": "y"}),
        ];
        let (values, failed) = engine
            .eval_derive(
                "status === 'ok' ? 'green:' + name : 'red'",
                &["status".into(), "name".into()],
                &rows,
            )
            .unwrap();
        assert_eq!(failed, 0);
        assert_eq!(values, vec![json!("green:x"), json!("red")]);
    }

    #[test]
    fn derive_row_dot_access_fallback() {
        let engine = QuickJsEngine::new();
        // no columns → only the `row.col` fallback compiles (legacy behavior)
        let rows = vec![json!({"a": 1, "b": 2})];
        let (values, failed) = engine.eval_derive("row.a + row.b", &[], &rows).unwrap();
        assert_eq!(failed, 0);
        assert_eq!(values, vec![json!(3)]);
        // unknown bare identifier with no destructuring → per-row ReferenceError → null
        let (values, failed) = engine.eval_derive("a + b", &[], &rows).unwrap();
        assert_eq!(failed, 1);
        assert_eq!(values, vec![json!(null)]);
    }

    #[test]
    fn derive_destructure_failure_falls_back_to_row_scope() {
        let engine = QuickJsEngine::new();
        // `class` is a reserved word → the destructuring compile fails, the
        // fallback (row.col only) is used; legacy keeps the FIRST compile error
        // when the fallback also fails, but here the fallback succeeds.
        let rows = vec![json!({"class": "A", "n": 2})];
        let (values, failed) = engine
            .eval_derive("row.n * 3", &["class".into(), "n".into()], &rows)
            .unwrap();
        assert_eq!(failed, 0);
        assert_eq!(values, vec![json!(6)]);
    }

    #[test]
    fn derive_per_row_failure_yields_null() {
        let engine = QuickJsEngine::new();
        let rows = vec![json!({"a": {"b": 1}}), json!({"a": null}), json!({})];
        let (values, failed) = engine.eval_derive("a.b.c", &["a".into()], &rows).unwrap();
        // row 0: (1).c === undefined in JS → null WITHOUT counting as failure
        // (legacy: value === undefined → null); row 1: null.b → TypeError;
        // row 2: undefined.b → TypeError.
        assert_eq!(failed, 2);
        assert_eq!(values, vec![json!(null), json!(null), json!(null)]);
    }

    #[test]
    fn derive_undefined_result_is_null_not_failure() {
        let engine = QuickJsEngine::new();
        let rows = vec![json!({"a": 1})];
        let (values, failed) = engine
            .eval_derive("row.missing", &["a".into()], &rows)
            .unwrap();
        assert_eq!(failed, 0);
        assert_eq!(values, vec![json!(null)]);
    }

    #[test]
    fn derive_compile_error_surfaces_message() {
        let engine = QuickJsEngine::new();
        let rows = vec![json!({"a": 1})];
        let err = engine.eval_derive("a +", &["a".into()], &rows).unwrap_err();
        match err {
            JsError::Compile(msg) => assert!(!msg.is_empty()),
            other => panic!("expected Compile, got {other:?}"),
        }
    }

    #[test]
    fn derive_nan_and_whole_float_json_semantics() {
        let engine = QuickJsEngine::new();
        let rows = vec![json!({"a": 0})];
        // NaN → null (JSON.stringify semantics), whole floats → integers
        let (values, failed) = engine.eval_derive("1 / a", &["a".into()], &rows).unwrap();
        assert_eq!(failed, 0);
        assert_eq!(values, vec![json!(null)]);
        let (values, _) = engine.eval_derive("6.0 / 2", &[], &rows).unwrap();
        assert_eq!(values, vec![json!(3)]);
        let (values, _) = engine.eval_derive("1.5", &[], &rows).unwrap();
        assert_eq!(values, vec![json!(1.5)]);
    }

    #[test]
    fn derive_timeout_is_per_row_failure() {
        // Legacy derive had no timeout; we bound runaway expressions but keep
        // the per-row failure contract (null + failed count, no batch error).
        let engine = QuickJsEngine::with_limits(DEFAULT_MEMORY_LIMIT, Duration::from_millis(300));
        let rows = vec![json!({"a": 1}), json!({"a": 2})];
        let started = Instant::now();
        let (values, failed) = engine
            .eval_derive("(() => { while (true) {} })()", &[], &rows)
            .unwrap();
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(failed, 2);
        assert_eq!(values, vec![json!(null), json!(null)]);
    }

    #[test]
    fn derive_no_io_globals_exposed() {
        let engine = QuickJsEngine::new();
        let rows = vec![json!({})];
        let (values, failed) = engine
            .eval_derive(
                "typeof fetch === 'undefined' && typeof process === 'undefined' && typeof require === 'undefined' && typeof console === 'undefined'",
                &[],
                &rows,
            )
            .unwrap();
        assert_eq!(failed, 0);
        assert_eq!(values, vec![json!(true)]);
        // referencing fetch directly → ReferenceError → per-row null
        let (values, failed) = engine.eval_derive("fetch", &[], &rows).unwrap();
        assert_eq!(failed, 1);
        assert_eq!(values, vec![json!(null)]);
    }

    // ─── workbook ───────────────────────────────────────────────────────

    #[test]
    fn workbook_returns_rows() {
        let engine = QuickJsEngine::new();
        let input = json!({
            "rows": [{"name": "a", "n": 2}, {"name": "b", "n": 3}],
            "datasets": {},
            "schemas": {},
        });
        let out = engine
            .eval_workbook(
                "return input.rows.map(function (r) { return { name: r.name, doubled: r.n * 2, ok: true }; })",
                &input,
                &limits(Duration::from_secs(2), 100),
            )
            .unwrap();
        assert_eq!(
            out,
            vec![
                json!({"name": "a", "doubled": 4, "ok": true}),
                json!({"name": "b", "doubled": 6, "ok": true}),
            ]
        );
    }

    #[test]
    fn workbook_non_array_result_exact_message() {
        let engine = QuickJsEngine::new();
        let err = engine
            .eval_workbook(
                "return 42",
                &json!({}),
                &limits(Duration::from_secs(2), 100),
            )
            .unwrap_err();
        assert_eq!(
            err.to_string(),
            "transform must return an array of row objects (got number)"
        );
        let err = engine
            .eval_workbook(
                "return null",
                &json!({}),
                &limits(Duration::from_secs(2), 100),
            )
            .unwrap_err();
        assert_eq!(
            err.to_string(),
            "transform must return an array of row objects (got null)"
        );
        let err = engine
            .eval_workbook(
                "var x = 1",
                &json!({}),
                &limits(Duration::from_secs(2), 100),
            )
            .unwrap_err();
        assert_eq!(
            err.to_string(),
            "transform must return an array of row objects (got undefined)"
        );
    }

    #[test]
    fn workbook_row_cap_exact_message() {
        let engine = QuickJsEngine::new();
        let err = engine
            .eval_workbook(
                "return [{a:1},{a:2},{a:3}]",
                &json!({}),
                &limits(Duration::from_secs(2), 2),
            )
            .unwrap_err();
        assert_eq!(err.to_string(), "transform returned 3 rows; limit is 2");
    }

    #[test]
    fn workbook_non_object_element_exact_messages() {
        let engine = QuickJsEngine::new();
        let l = limits(Duration::from_secs(2), 100);
        let err = engine
            .eval_workbook("return [1, 2]", &json!({}), &l)
            .unwrap_err();
        assert_eq!(
            err.to_string(),
            "row 0: expected a plain object (got number)"
        );
        let err = engine
            .eval_workbook("return [{a:1}, [2]]", &json!({}), &l)
            .unwrap_err();
        assert_eq!(
            err.to_string(),
            "row 1: expected a plain object (got array)"
        );
        let err = engine
            .eval_workbook("return [null]", &json!({}), &l)
            .unwrap_err();
        assert_eq!(err.to_string(), "row 0: expected a plain object (got null)");
    }

    #[test]
    fn workbook_bad_cell_exact_message() {
        let engine = QuickJsEngine::new();
        let l = limits(Duration::from_secs(2), 100);
        let err = engine
            .eval_workbook("return [{ a: { b: 1 } }]", &json!({}), &l)
            .unwrap_err();
        assert_eq!(
            err.to_string(),
            "row 0 column \"a\": value must be string|number|boolean|null (got object)"
        );
        let err = engine
            .eval_workbook("return [{ ok: 1, bad: undefined }]", &json!({}), &l)
            .unwrap_err();
        assert_eq!(
            err.to_string(),
            "row 0 column \"bad\": value must be string|number|boolean|null (got undefined)"
        );
    }

    #[test]
    fn workbook_nan_cells_become_null() {
        // NaN passes validation (typeof number) and serializes to null at the
        // JSON boundary — exactly the legacy JSON.stringify-at-storage behavior.
        let engine = QuickJsEngine::new();
        let out = engine
            .eval_workbook(
                "return [{ n: NaN, inf: Infinity, neg: -Infinity }]",
                &json!({}),
                &limits(Duration::from_secs(2), 100),
            )
            .unwrap();
        assert_eq!(out, vec![json!({"n": null, "inf": null, "neg": null})]);
    }

    #[test]
    fn workbook_runtime_exception_exact_surface() {
        let engine = QuickJsEngine::new();
        let err = engine
            .eval_workbook(
                "throw new Error('boom')",
                &json!({}),
                &limits(Duration::from_secs(2), 100),
            )
            .unwrap_err();
        assert_eq!(err.to_string(), "script error: boom");
        // non-Error throws keep their string form
        let err = engine
            .eval_workbook(
                "throw 'plain'",
                &json!({}),
                &limits(Duration::from_secs(2), 100),
            )
            .unwrap_err();
        assert_eq!(err.to_string(), "script error: plain");
    }

    #[test]
    fn workbook_syntax_error_surfaces_as_script_error() {
        let engine = QuickJsEngine::new();
        let err = engine
            .eval_workbook("return (", &json!({}), &limits(Duration::from_secs(2), 100))
            .unwrap_err();
        assert!(err.to_string().starts_with("script error: "), "got {err}");
    }

    #[test]
    fn workbook_timeout_exact_message() {
        let engine = QuickJsEngine::new();
        let started = Instant::now();
        let err = engine
            .eval_workbook(
                "while (true) {}",
                &json!({}),
                &limits(Duration::from_millis(300), 100),
            )
            .unwrap_err();
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(
            err.to_string(),
            "JavaScript execution timed out after 300ms"
        );
    }

    #[test]
    fn workbook_has_no_io_globals() {
        let engine = QuickJsEngine::new();
        let out = engine
            .eval_workbook(
                "if (typeof process !== 'undefined' || typeof require !== 'undefined' || typeof fetch !== 'undefined') { throw new Error('IO global exposed'); } return [{ safe: true }]",
                &json!({}),
                &limits(Duration::from_secs(2), 100),
            )
            .unwrap();
        assert_eq!(out, vec![json!({"safe": true})]);
    }

    #[test]
    fn workbook_input_round_trips() {
        let engine = QuickJsEngine::new();
        let input = json!({
            "rows": [{"id": 1, "label": "x"}],
            "datasets": {"orders": [{"id": 1}]},
            "schemas": {"orders": [{"name": "id", "type": "number"}]},
        });
        let out = engine
            .eval_workbook(
                "return [{ count: input.rows.length, first: input.datasets.orders[0].id, col: input.schemas.orders[0].name, label: input.rows[0].label }]",
                &input,
                &limits(Duration::from_secs(2), 100),
            )
            .unwrap();
        assert_eq!(
            out,
            vec![json!({"count": 1, "first": 1, "col": "id", "label": "x"})]
        );
    }

    #[test]
    fn workbook_state_does_not_leak_between_calls() {
        let engine = QuickJsEngine::new();
        let l = limits(Duration::from_secs(2), 100);
        engine
            .eval_workbook("globalThis.__leak = 'x'; return []", &json!({}), &l)
            .unwrap();
        let out = engine
            .eval_workbook(
                "return [{ leaked: typeof globalThis.__leak }]",
                &json!({}),
                &l,
            )
            .unwrap();
        assert_eq!(out, vec![json!({"leaked": "undefined"})]);
    }
}
