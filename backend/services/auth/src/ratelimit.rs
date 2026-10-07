//! In-memory sliding-window rate limiter for public API tokens.
//! Exact port of `src/lib/rate-limit.ts` (Map<tokenId, timestamps[]>,
//! 60s window, prune-on-check). State lives in the auth service so counters
//! are shared by all public-api replicas and survive its restarts.

use chrono::Utc;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;

pub const TOKEN_RATE_LIMIT: i64 = 60;
const WINDOW_MS: i64 = 60_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitResult {
    pub allowed: bool,
    /// Requests still available in the current window (0 when blocked).
    pub remaining: i64,
    /// Epoch ms when the oldest request in the window expires.
    pub reset_ms: i64,
    /// Seconds until the caller may retry (0 when allowed).
    pub retry_after_seconds: i64,
}

#[derive(Default)]
pub struct RateLimiter {
    hits: Mutex<HashMap<String, Vec<i64>>>,
}

impl RateLimiter {
    pub fn new() -> Self { Self::default() }

    /// Record one request for `token_id` and decide whether it fits the window.
    pub fn check(&self, token_id: &str, limit: i64) -> RateLimitResult {
        let now = Utc::now().timestamp_millis();
        let mut hits = self.hits.lock().unwrap();
        let entry = hits.entry(token_id.to_string()).or_default();
        entry.retain(|ts| now - *ts < WINDOW_MS);

        if entry.len() as i64 >= limit {
            let reset_ms = entry[0] + WINDOW_MS;
            return RateLimitResult {
                allowed: false,
                remaining: 0,
                reset_ms,
                retry_after_seconds: ((reset_ms - now) as f64 / 1000.0).ceil().max(1.0) as i64,
            };
        }

        entry.push(now);
        let reset_ms = entry[0] + WINDOW_MS;
        RateLimitResult {
            allowed: true,
            remaining: limit - entry.len() as i64,
            reset_ms,
            retry_after_seconds: 0,
        }
    }

    /// Drop all remembered timestamps for a token (used when revoked).
    pub fn reset(&self, token_id: &str) {
        self.hits.lock().unwrap().remove(token_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_up_to_limit_then_blocks() {
        let rl = RateLimiter::new();
        for i in 0..5 {
            let r = rl.check("t1", 5);
            assert!(r.allowed, "request {i} should pass");
            assert_eq!(r.remaining, 5 - (i + 1));
        }
        let blocked = rl.check("t1", 5);
        assert!(!blocked.allowed);
        assert_eq!(blocked.remaining, 0);
        assert!(blocked.retry_after_seconds >= 1 && blocked.retry_after_seconds <= 60);
        // other tokens unaffected
        assert!(rl.check("t2", 5).allowed);
    }

    #[test]
    fn reset_clears_window() {
        let rl = RateLimiter::new();
        for _ in 0..3 { rl.check("t3", 3); }
        assert!(!rl.check("t3", 3).allowed);
        rl.reset("t3");
        assert!(rl.check("t3", 3).allowed);
    }
}
