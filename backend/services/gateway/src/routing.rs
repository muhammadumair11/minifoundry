//! Longest-prefix routing table: public API path → domain service base URL.
//! Mirrors the plan's gateway mapping; `/internal/*` is never routable here.

pub struct RouteRule {
    pub prefixes: Vec<&'static str>,
    pub base_url: String,
    pub service: &'static str,
}

fn rule(prefixes: &[&'static str], env_var: &str, default: &str, service: &'static str) -> RouteRule {
    RouteRule {
        prefixes: prefixes.to_vec(),
        base_url: std::env::var(env_var).unwrap_or_else(|_| default.to_string()),
        service,
    }
}

pub fn build_routes() -> Vec<RouteRule> {
    vec![
        rule(&["/api/foundry/v1"], "PUBLIC_API_INTERNAL_URL", "http://public-api:8087", "public-api"),
        rule(&["/api/auth", "/api/session", "/api/users", "/api/tokens"], "AUTH_INTERNAL_URL", "http://auth:8081", "auth"),
        rule(
            &["/api/projects", "/api/datasets", "/api/connectors", "/api/ingest", "/api/ingestions", "/api/lineage", "/api/seed"],
            "CATALOG_INTERNAL_URL", "http://catalog:8082", "catalog",
        ),
        rule(
            &["/api/pipelines", "/api/runs", "/api/execution-jobs", "/api/schedules", "/api/health"],
            "ORCHESTRATION_INTERNAL_URL", "http://orchestration:8083", "orchestration",
        ),
        rule(&["/api/transforms"], "COMPUTE_INTERNAL_URL", "http://compute:8084", "compute"),
        rule(
            &["/api/ontology", "/api/objects", "/api/actions", "/api/dashboards", "/api/applications"],
            "ONTOLOGY_INTERNAL_URL", "http://ontology:8085", "ontology",
        ),
        rule(
            &[
                "/api/markings", "/api/approvals", "/api/audit", "/api/acl", "/api/notifications",
                "/api/curriculum", "/api/settings", "/api/governance", "/api/search", "/api/stats",
            ],
            "GOVERNANCE_INTERNAL_URL", "http://governance:8086", "governance",
        ),
    ]
}

/// Longest-prefix match: `path == prefix || path.starts_with(prefix + "/")`.
pub fn resolve<'a>(path: &str, routes: &'a [RouteRule]) -> Option<&'a RouteRule> {
    let mut best: Option<(&'a RouteRule, usize)> = None;
    for rule in routes {
        for prefix in &rule.prefixes {
            let matched = path == *prefix
                || path.strip_prefix(prefix).map_or(false, |rest| rest.starts_with('/'));
            if matched && best.map_or(true, |(_, len)| prefix.len() > len) {
                best = Some((rule, prefix.len()));
            }
        }
    }
    best.map(|(rule, _)| rule)
}

/// Legacy middleware allowlist: reachable WITHOUT a session/service token in
/// shared mode (auth + session routes must stay open so users can sign in;
/// /api/health is a liveness probe; /api/foundry/v1 validates its own bearer
/// tokens).
const ALLOWED_PREFIXES: [&str; 4] = ["/api/auth", "/api/session", "/api/health", "/api/foundry/v1"];

pub fn is_allowlisted(path: &str) -> bool {
    ALLOWED_PREFIXES
        .iter()
        .any(|p| path == *p || path.strip_prefix(p).map_or(false, |rest| rest.starts_with('/')))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routing_table_covers_every_legacy_prefix() {
        let routes = build_routes();
        let cases = [
            ("/api/auth/login", "auth"),
            ("/api/session/role", "auth"),
            ("/api/users/abc", "auth"),
            ("/api/tokens/usage/seed", "auth"),
            ("/api/projects", "catalog"),
            ("/api/datasets/x/branches/y/commit", "catalog"),
            ("/api/connectors/x/ingest", "catalog"),
            ("/api/ingest", "catalog"),
            ("/api/ingestions", "catalog"),
            ("/api/lineage/impact", "catalog"),
            ("/api/seed", "catalog"),
            ("/api/pipelines/x/runs/y/output", "orchestration"),
            ("/api/runs/x/replay", "orchestration"),
            ("/api/execution-jobs/x", "orchestration"),
            ("/api/schedules/due", "orchestration"),
            ("/api/health", "orchestration"),
            ("/api/transforms/x/run", "compute"),
            ("/api/ontology/actions/x", "ontology"),
            ("/api/objects/views/x", "ontology"),
            ("/api/actions/logs", "ontology"),
            ("/api/dashboards/x/data", "ontology"),
            ("/api/applications/data", "ontology"),
            ("/api/markings/x/attach", "governance"),
            ("/api/approvals/x/decide", "governance"),
            ("/api/audit", "governance"),
            ("/api/acl/check", "governance"),
            ("/api/notifications/read-all", "governance"),
            ("/api/curriculum", "governance"),
            ("/api/settings/overview", "governance"),
            ("/api/governance/seed-demo", "governance"),
            ("/api/search", "governance"),
            ("/api/stats", "governance"),
            ("/api/foundry/v1/datasets/x/rows", "public-api"),
        ];
        for (path, service) in cases {
            let rule = resolve(path, &routes).unwrap_or_else(|| panic!("unrouted: {path}"));
            assert_eq!(rule.service, service, "wrong service for {path}");
        }
    }

    #[test]
    fn prefix_boundaries_are_slash_aware() {
        let routes = build_routes();
        // "/api/sessionxyz" must NOT match "/api/session"
        assert!(resolve("/api/sessionxyz", &routes).is_none());
        // "/api/seed" exact + "/api/seed/x" both hit catalog
        assert_eq!(resolve("/api/seed", &routes).unwrap().service, "catalog");
        assert_eq!(resolve("/api/seed/x", &routes).unwrap().service, "catalog");
    }

    #[test]
    fn allowlist_matches_legacy_middleware() {
        assert!(is_allowlisted("/api/auth/login"));
        assert!(is_allowlisted("/api/session"));
        assert!(is_allowlisted("/api/session/role"));
        assert!(is_allowlisted("/api/health"));
        assert!(is_allowlisted("/api/foundry/v1/whoami"));
        assert!(!is_allowlisted("/api/datasets"));
        assert!(!is_allowlisted("/api/tokens"));
        assert!(!is_allowlisted("/api/settings")); // NOT /api/session
    }
}
