//! MiniFoundry — sandboxed JavaScript evaluation.
//!
//! Two call sites (ported semantics):
//! 1. **Derive expressions** (orchestration, `engine.ts#execDerive`): compile
//!    `(row) => (<expression>)` with bare column identifiers destructured from
//!    the first row; per-row evaluation failure yields `null`. Dangerous
//!    identifiers (process/require/import/eval/Function/globalThis/global/
//!    window/document/fetch/child_process/fs/net/http) are rejected up front.
//! 2. **JS workbooks** (compute, `isolated-runner.ts#executeJsIsolated`): the
//!    source is a function BODY receiving `input` ({ rows, datasets, schemas })
//!    and returning an array of plain objects; no require/process/console;
//!    hard timeout.
//!
//! The concrete engine is [`QuickJsEngine`] (rquickjs — QuickJS compiled from
//! its own C sources, no system deps). Every evaluation builds a FRESH
//! `Runtime` + `Context` inside the call: no globals beyond the QuickJS
//! standard intrinsics (no fetch/require/console/process — QuickJS ships none
//! and we register none), a wall-clock interrupt handler, and a memory limit.
//!
//! Error-message contract (exact legacy strings — callers persist `e.to_string()`):
//! - [`JsError::Compile`] carries the raw engine syntax-error message; derive
//!   callers wrap it as `derive node '<id>': invalid expression — <msg>`.
//! - [`JsError::Runtime`] Display is the legacy workbook surface
//!   `script error: <msg>` (isolated-runner.ts rejects with exactly that).
//! - [`JsError::Timeout`] Display is `JavaScript execution timed out after <ms>ms`.
//! - [`JsError::InvalidResult`] Display is the exact validateRunnerRows message.

use serde_json::Value;
use std::time::Duration;

pub mod quickjs;

pub use quickjs::QuickJsEngine;

#[derive(Debug, thiserror::Error)]
pub enum JsError {
    /// Compilation failed; `{0}` is the raw engine syntax-error message.
    #[error("{0}")]
    Compile(String),
    /// Wall-clock timeout; `{0}` is the exact legacy message
    /// `JavaScript execution timed out after <ms>ms`.
    #[error("{0}")]
    Timeout(String),
    /// A JS exception (runtime throw OR workbook compile failure — legacy
    /// surfaces both identically); `{0}` is `script error: <msg>`.
    #[error("{0}")]
    Runtime(String),
    /// Workbook result shape/value validation; `{0}` is the exact legacy
    /// validateRunnerRows message.
    #[error("{0}")]
    InvalidResult(String),
    #[error("engine unavailable: {0}")]
    Unavailable(String),
}

#[derive(Debug, Clone)]
pub struct JsLimits {
    /// Wall-clock timeout per evaluation batch (workbooks: 2s default,
    /// matching the old vm timeout; configurable via env).
    pub timeout: Duration,
    /// Max rows accepted in a workbook result (old DEFAULT_MAX_ROWS).
    pub max_rows: usize,
}

impl Default for JsLimits {
    fn default() -> Self {
        // isolated-runner.ts: DEFAULT_TIMEOUT_MS = 10_000, DEFAULT_MAX_ROWS = 50_000.
        // (Callers may pass tighter limits — check the legacy call sites in
        // transform-engine.ts when porting.)
        Self { timeout: Duration::from_secs(10), max_rows: 50_000 }
    }
}

/// A JS engine able to evaluate derive expressions and workbook bodies.
/// Implementations MUST deny all IO (no fetch/fs/net/console/process) and
/// enforce the given limits.
pub trait JsEngine: Send + Sync {
    /// Evaluate a derive `expression` per row. The engine compiles
    /// `var {<columns...>} = row; return (<expression>)` once (falling back to
    /// `return (<expression>)` with only `row` in scope when compilation with
    /// destructuring fails) and maps it over `rows`.
    ///
    /// Returns `(values, failed_count)`; per-row failures yield
    /// `Value::Null` in the output vec (the caller adds the warn log entry,
    /// matching execDerive). Legacy derive evaluation had NO timeout (plain
    /// `new Function`); implementations SHOULD still enforce a generous
    /// wall-clock interrupt (JsLimits::default().timeout over the whole batch)
    /// and treat a timeout as a PER-ROW failure (null + failed count), never a
    /// whole-batch error — closest to legacy behavior while bounding runaway
    /// expressions.
    fn eval_derive(
        &self,
        expression: &str,
        columns: &[String],
        rows: &[Value],
    ) -> Result<(Vec<Value>, usize), JsError>;

    /// Execute a workbook function body with `input` bound; returns the
    /// JSON-serialized result array (already row-shape validated with the
    /// exact validateRunnerRows messages). Error Displays are the exact legacy
    /// strings (`script error: ...`, `JavaScript execution timed out after
    /// <ms>ms`, validation messages) so callers can persist `e.to_string()`.
    fn eval_workbook(&self, source: &str, input: &Value, limits: &JsLimits) -> Result<Vec<Value>, JsError>;
}

/// The dangerous-identifier guard from execDerive (regex ported 1:1).
pub const DERIVE_DANGEROUS_PATTERN: &str =
    r"\b(process|require|import|eval|Function|globalThis|global|window|document|fetch|child_process|fs|net|http)\b";

/// True when a derive expression must be rejected before evaluation.
pub fn derive_expression_is_dangerous(expression: &str) -> bool {
    use std::sync::OnceLock;
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(DERIVE_DANGEROUS_PATTERN).unwrap());
    re.is_match(expression)
}

/// Engine factory. The rquickjs engine is cheap to construct (it holds only
/// limit knobs); every evaluation call creates its own Runtime + Context.
pub fn default_engine() -> Option<Box<dyn JsEngine>> {
    Some(Box::new(QuickJsEngine::new()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dangerous_patterns_match_legacy_list() {
        assert!(derive_expression_is_dangerous("process.exit(1)"));
        assert!(derive_expression_is_dangerous("require('fs')"));
        assert!(derive_expression_is_dangerous("fetch('http://x')"));
        assert!(derive_expression_is_dangerous("window.alert(1)"));
        assert!(derive_expression_is_dangerous("new Function('x')"));
        // word-boundary: identifiers containing the words are fine
        assert!(!derive_expression_is_dangerous("processId + 1"));
        assert!(!derive_expression_is_dangerous("a.fetchCount * 2"));
        assert!(!derive_expression_is_dangerous("price * quantity"));
    }

    #[test]
    fn default_engine_is_available() {
        let engine = default_engine().expect("rquickjs engine must be available");
        // smoke: 1 + 1 through the boxed trait object
        let (values, failed) = engine
            .eval_derive("a + 1", &["a".to_string()], &[serde_json::json!({"a": 1})])
            .expect("eval ok");
        assert_eq!(failed, 0);
        assert_eq!(values, vec![serde_json::json!(2)]);
    }
}
