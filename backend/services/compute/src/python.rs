//! Port of `executePythonIsolated` (src/lib/isolated-runner.ts lines 168-239).
//!
//! Protocol (unchanged): a per-run temp dir holds `runner.py` (fixed harness)
//! and `user.py` (the workbook source). `python3 -I -B runner.py` runs with
//! cwd = temp dir and a minimal env {PATH, HOME=tempdir}; the input JSON goes
//! in on stdin, the result is written to `out.json`, user `print()` lines come
//! back on stdout (surfaced as run logs), tracebacks on stderr. The temp dir
//! is removed in all paths.
//!
//! Error strings (exact legacy):
//! - timeout          → `Python timed out after <ms>ms`
//! - non-zero exit    → `Python exited with code <code>:\n<last 5 stderr lines>`
//!   (no tail → `Python exited with code <code>`)
//! - missing out.json → `Python runner did not produce a result file`
//! - invalid JSON     → `Python runner produced invalid JSON output`
//! - spawn failure    → `Python exited with code <-errno>` (Node/libuv passes
//!   the negative errno as the close code when the child fails to spawn;
//!   ENOENT = -2 on Linux deployments)
//! - signal kill      → code renders as `null` (JS `null` exit code)
//!
//! Result rows go through the same `validateRunnerRows` port as the JS path.

use crate::validate::validate_runner_rows;
use mf_types::{Row, Value};
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::Mutex;

/// The fixed harness script (PYTHON_RUNNER in isolated-runner.ts, `.trim()`ed).
pub const PYTHON_RUNNER: &str = r#"import json, sys, importlib.util, os
spec = importlib.util.spec_from_file_location("user", os.path.join(os.path.dirname(__file__), "user.py"))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
data = json.load(sys.stdin)
result = mod.transform(data)
with open(os.path.join(os.path.dirname(__file__), "out.json"), "w") as f:
    json.dump(result, f)"#;

/// Interpreter resolution: MF_PYTHON_BIN override, else `python` on Windows /
/// `python3` everywhere else (legacy platform switch).
pub fn python_bin() -> String {
    if let Ok(v) = std::env::var("MF_PYTHON_BIN") {
        let trimmed = v.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if cfg!(windows) {
        "python".to_string()
    } else {
        "python3".to_string()
    }
}

/// Split captured stdout into log lines (trailing '\r' stripped, empty lines
/// dropped — `print()` output becomes one info log entry per line).
pub fn stdout_lines(stdout: &str) -> Vec<String> {
    stdout
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .filter(|l| !l.is_empty())
        .map(String::from)
        .collect()
}

/// The last 5 non-empty lines of trimmed stderr (legacy tail for the error).
pub fn stderr_tail(stderr: &str) -> String {
    let lines: Vec<&str> = stderr
        .trim()
        .split('\n')
        .filter(|l| !l.is_empty())
        .collect();
    let start = lines.len().saturating_sub(5);
    lines[start..].join("\n")
}

/// Render an exit status the way the legacy `close` event code did:
/// Some(code) → the number; signal-killed / never-spawned → `null`.
fn exit_code_str(status: &Option<i32>) -> String {
    match status {
        Some(c) => c.to_string(),
        None => "null".to_string(),
    }
}

/// Execute a Python workbook. Returns `(outcome, stdout_log_lines)` — stdout
/// is surfaced even when the run failed (partial output before a crash).
pub async fn execute_python_isolated(
    code: &str,
    input: &Value,
    timeout_ms: u64,
    max_rows: usize,
) -> (Result<Vec<Row>, String>, Vec<String>) {
    let python = python_bin();
    let dir = std::env::temp_dir().join(format!("mf-py-iso-{}", mf_db::new_id()));

    let result = run_python(&python, &dir, code, input, timeout_ms, max_rows).await;

    // finally-block parity: the temp dir is removed in ALL paths.
    if let Err(e) = tokio::fs::remove_dir_all(&dir).await {
        tracing::debug!(dir = %dir.display(), error = %e, "python temp dir cleanup failed");
    }
    result
}

async fn run_python(
    python: &str,
    dir: &std::path::Path,
    code: &str,
    input: &Value,
    timeout_ms: u64,
    max_rows: usize,
) -> (Result<Vec<Row>, String>, Vec<String>) {
    if let Err(e) = tokio::fs::create_dir_all(dir).await {
        return (Err(format!("Python runner setup failed: {e}")), Vec::new());
    }
    if let Err(e) = tokio::fs::write(dir.join("runner.py"), PYTHON_RUNNER).await {
        return (Err(format!("Python runner setup failed: {e}")), Vec::new());
    }
    if let Err(e) = tokio::fs::write(dir.join("user.py"), code).await {
        return (Err(format!("Python runner setup failed: {e}")), Vec::new());
    }

    // env {PATH, HOME=tempdir} + -I -B (legacy spawn options).
    let mut cmd = Command::new(python);
    cmd.args(["-I", "-B", "runner.py"])
        .current_dir(dir)
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", dir)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            // Node/libuv surfaces spawn failures through the close event with
            // the negative errno as the exit code (ENOENT → -2 on Linux).
            let errno = e.raw_os_error().unwrap_or(2);
            return (
                Err(format!("Python exited with code {}", -errno)),
                Vec::new(),
            );
        }
    };

    // stdin: write the input JSON, then close (EPIPE ignored — Node's
    // child_process swallows stdin write errors the same way).
    if let Some(mut stdin) = child.stdin.take() {
        let payload = serde_json::to_vec(input).unwrap_or_default();
        tokio::spawn(async move {
            let _ = stdin.write_all(&payload).await;
            let _ = stdin.shutdown().await;
        });
    }

    // Accumulate stdout/stderr in background tasks (Node data-event parity;
    // partial output survives a timeout kill).
    let stdout_buf = Arc::new(Mutex::new(Vec::<u8>::new()));
    let stderr_buf = Arc::new(Mutex::new(Vec::<u8>::new()));
    let stdout_task = spawn_reader(child.stdout.take(), stdout_buf.clone());
    let stderr_task = spawn_reader(child.stderr.take(), stderr_buf.clone());

    let waited = tokio::time::timeout(
        std::time::Duration::from_millis(timeout_ms),
        child.wait(),
    )
    .await;

    let timed_out = waited.is_err();
    let status: Option<i32> = match waited {
        Ok(Ok(st)) => st.code(),
        Ok(Err(_)) => None,
        Err(_) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            None
        }
    };
    // Readers hit EOF once the child (and its killed pipes) are gone.
    let _ = stdout_task.await;
    let _ = stderr_task.await;

    let stdout = String::from_utf8_lossy(&stdout_buf.lock().await[..]).into_owned();
    let stderr = String::from_utf8_lossy(&stderr_buf.lock().await[..]).into_owned();
    let lines = stdout_lines(&stdout);

    if timed_out {
        return (Err(format!("Python timed out after {timeout_ms}ms")), lines);
    }

    let code = exit_code_str(&status);
    let Some(exit) = status else {
        // Signal-killed (close code null in Node) — same shape as legacy.
        let tail = stderr_tail(&stderr);
        let msg = if tail.is_empty() {
            format!("Python exited with code {code}")
        } else {
            format!("Python exited with code {code}:\n{tail}")
        };
        return (Err(msg), lines);
    };
    if exit != 0 {
        let tail = stderr_tail(&stderr);
        let msg = if tail.is_empty() {
            format!("Python exited with code {exit}")
        } else {
            format!("Python exited with code {exit}:\n{tail}")
        };
        return (Err(msg), lines);
    }

    let raw = match tokio::fs::read_to_string(dir.join("out.json")).await {
        Ok(r) => r,
        Err(_) => {
            return (
                Err("Python runner did not produce a result file".to_string()),
                lines,
            )
        }
    };
    let parsed: Value = match serde_json::from_str(&raw) {
        Ok(p) => p,
        Err(_) => {
            return (
                Err("Python runner produced invalid JSON output".to_string()),
                lines,
            )
        }
    };
    (validate_runner_rows(&parsed, max_rows), lines)
}

fn spawn_reader<R>(src: Option<R>, buf: Arc<Mutex<Vec<u8>>>) -> tokio::task::JoinHandle<()>
where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut src = match src {
            Some(s) => s,
            None => return,
        };
        let mut chunk = [0u8; 8192];
        loop {
            match src.read(&mut chunk).await {
                Ok(0) => break,
                Ok(n) => buf.lock().await.extend_from_slice(&chunk[..n]),
                Err(_) => break,
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn runner_script_matches_legacy_trimmed_template() {
        assert!(PYTHON_RUNNER.starts_with("import json, sys, importlib.util, os"));
        assert!(PYTHON_RUNNER.ends_with("json.dump(result, f)"));
        assert!(PYTHON_RUNNER.contains("mod.transform(data)"));
    }

    #[test]
    fn stderr_tail_is_last_five_nonempty_lines() {
        let stderr = "l1\n\nl2\nl3\nl4\nl5\nl6\nl7\n";
        assert_eq!(stderr_tail(stderr), "l3\nl4\nl5\nl6\nl7");
        assert_eq!(stderr_tail("  \n "), "");
        assert_eq!(stderr_tail("only\n"), "only");
    }

    #[test]
    fn stdout_line_splitting() {
        assert_eq!(stdout_lines("a\nb\n"), vec!["a", "b"]);
        assert_eq!(stdout_lines("a\r\nb\r\n"), vec!["a", "b"]);
        assert_eq!(stdout_lines(""), Vec::<String>::new());
    }

    /// True when a python interpreter is reachable in this environment.
    fn interpreter_available() -> Option<String> {
        let bin = python_bin();
        for candidate in [bin.as_str(), "python3", "python"] {
            if std::process::Command::new(candidate)
                .arg("--version")
                .output()
                .is_ok_and(|o| o.status.success())
            {
                return Some(candidate.to_string());
            }
        }
        None
    }

    fn input() -> Value {
        json!({"rows": [{"a": 1, "b": "x"}, {"a": 2, "b": "y"}], "datasets": {}, "schemas": {}})
    }

    #[tokio::test]
    async fn python_roundtrip_maps_rows_and_stdout() {
        let Some(_bin) = interpreter_available() else {
            eprintln!("skipping: no python interpreter in this environment");
            return;
        };
        let code = r#"
import sys
def transform(input):
    print("hello from python")
    return [{"a": r["a"], "double": r["a"] * 2} for r in input["rows"]]
"#;
        let (outcome, lines) =
            execute_python_isolated(code, &input(), 10_000, 50_000).await;
        let rows = outcome.expect("python run ok");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].get("double"), Some(&json!(2)));
        assert_eq!(lines, vec!["hello from python".to_string()]);
    }

    #[tokio::test]
    async fn python_error_tail_message() {
        let Some(_bin) = interpreter_available() else {
            eprintln!("skipping: no python interpreter in this environment");
            return;
        };
        let code = "def transform(input):\n    raise ValueError('boom')\n";
        let (outcome, _lines) =
            execute_python_isolated(code, &input(), 10_000, 50_000).await;
        let err = outcome.unwrap_err();
        assert!(err.starts_with("Python exited with code 1:\n"), "got {err}");
        assert!(err.contains("ValueError: boom"), "got {err}");
    }

    #[tokio::test]
    async fn python_invalid_result_shape_is_validated() {
        let Some(_bin) = interpreter_available() else {
            eprintln!("skipping: no python interpreter in this environment");
            return;
        };
        let code = "def transform(input):\n    return 42\n";
        let (outcome, _) = execute_python_isolated(code, &input(), 10_000, 50_000).await;
        assert_eq!(
            outcome.unwrap_err(),
            "transform must return an array of row objects (got number)"
        );
    }

    #[tokio::test]
    async fn python_timeout_message() {
        let Some(_bin) = interpreter_available() else {
            eprintln!("skipping: no python interpreter in this environment");
            return;
        };
        let code = "import time\ndef transform(input):\n    time.sleep(5)\n    return []\n";
        let (outcome, _) = execute_python_isolated(code, &input(), 300, 50_000).await;
        assert_eq!(outcome.unwrap_err(), "Python timed out after 300ms");
    }

    #[tokio::test]
    async fn python_spawn_failure_is_legacy_style_error() {
        // MF_PYTHON_BIN pointing at a nonexistent binary → spawn ENOENT.
        // (Env mutation is process-global; tests run in threads, so this uses
        // the run_python path with an explicit bogus interpreter instead.)
        let dir = std::env::temp_dir().join(format!("mf-py-iso-{}", mf_db::new_id()));
        let (outcome, lines) = run_python(
            "definitely-not-a-real-python-bin-xyz",
            &dir,
            "def transform(input):\n    return []\n",
            &input(),
            1_000,
            50_000,
        )
        .await;
        let _ = tokio::fs::remove_dir_all(&dir).await;
        let err = outcome.unwrap_err();
        assert!(err.starts_with("Python exited with code -"), "got {err}");
        assert!(lines.is_empty());
    }
}
