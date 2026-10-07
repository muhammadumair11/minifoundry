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
//! Phase 0 defines the engine contract; the concrete V8 (deno_core) engine is
//! wired in Phase 3/4. If deno_core's build weight proves excessive the
//! `rquickjs` engine slots in behind the same trait with no contract change.

use serde_json::Value;
use std::time::Duration;

#[derive(Debug, thiserror::Error)]
pub enum JsError {
    #[error("compilation failed: {0}")]
    Compile(String),
    #[error("execution timed out")]
    Timeout,
    #[error("runtime error: {0}")]
    Runtime(String),
    #[error("result must be an array of plain objects with string|number|boolean|null values")]
    InvalidResult,
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
        Self { timeout: Duration::from_secs(2), max_rows: 50_000 }
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
    /// matching execDerive).
    fn eval_derive(
        &self,
        expression: &str,
        columns: &[String],
        rows: &[Value],
    ) -> Result<(Vec<Value>, usize), JsError>;

    /// Execute a workbook function body with `input` bound; returns the
    /// JSON-serialized result array (already row-shape validated).
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

/// Engine factory. Returns None until the concrete engine is wired (Phase 3);
/// callers surface the same "isolated runner not configured" behavior the old
/// shared mode had for code execution.
pub fn default_engine() -> Option<Box<dyn JsEngine>> {
    None
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
    fn engine_not_yet_configured() {
        assert!(default_engine().is_none());
    }
}
