//! MiniFoundry — workspace seeder.
//!
//! Ports the legacy seed scripts:
//! - `scripts/seed-users-cli.ts` + `ensureSeedUsers()` (src/lib/seed.ts) —
//!   direct DB writes into auth.users.
//! - The UI seed valves (POST /api/seed, /api/ontology/seed-demo,
//!   /api/transforms/seed-demo, /api/governance/seed-demo) — replayed as
//!   HTTP calls THROUGH THE GATEWAY with the service token, so seeding uses
//!   each service's own implementation (single source of truth) instead of
//!   duplicating domain writes here.
//!
//! Runs as a one-shot container (`docker compose --profile tools run --rm seed all`)
//! or natively. Env: DATABASE_URL (postgres superuser or mf_seed role),
//! GATEWAY_URL (default http://gateway:8080), MF_SERVICE_TOKEN.

use clap::{Parser, Subcommand};
use sqlx::PgPool;

#[derive(Parser)]
#[command(name = "mf-seed", about = "Seed a MiniFoundry workspace")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Seed the three demo users (admin/editor/viewer, password '<redacted>').
    Users,
    /// Users + full demo workspace via the services' seed endpoints
    /// (datasets/pipelines, ontology, transforms, governance). Idempotent:
    /// "already seeded" responses are treated as success.
    All,
}

/// Password for every demo user (legacy DEMO_USER_PASSWORD).
const DEMO_USER_PASSWORD: &str = "<redacted>";

/// Legacy SEED_USERS — email/name/role of the demo trio.
const SEED_USERS: [(&str, &str, &str); 3] = [
    ("demo-admin@example.invalid", "Ada Admin", "admin"),
    ("demo-editor@example.invalid", "Eddie Editor", "editor"),
    ("demo-viewer@example.invalid", "Vera Viewer", "viewer"),
];

/// Seed valves in dependency order (datasets first — later domains reference
/// them). Each is a POST with an empty JSON body through the gateway.
const SEED_STAGES: [(&str, &str); 4] = [
    ("workspace", "/api/seed"),
    ("ontology", "/api/ontology/seed-demo"),
    ("transforms", "/api/transforms/seed-demo"),
    ("governance", "/api/governance/seed-demo"),
];

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_env_filter("info").init();
    let cli = Cli::parse();

    let url =
        std::env::var("DATABASE_URL").map_err(|_| anyhow::anyhow!("DATABASE_URL must be set"))?;
    let pool = mf_db::connect(&url, "public", 4).await?;

    match cli.command {
        Commands::Users => {
            let n = seed_users(&pool).await?;
            println!(r#"{{"ensured":{n}}}"#);
        }
        Commands::All => {
            let n = seed_users(&pool).await?;
            let mut failed: Vec<String> = Vec::new();
            println!(r#"{{"stage":"users","status":"ok","ensured":{n}}}"#);
            for (stage, path) in SEED_STAGES {
                match seed_via_gateway(path).await {
                    Ok(status) => {
                        println!(r#"{{"stage":"{stage}","status":"{status}"}}"#);
                    }
                    Err(e) => {
                        eprintln!(
                            r#"{{"stage":"{stage}","status":"failed","error":{}}}"#,
                            json_str(&e.to_string())
                        );
                        failed.push(stage.to_string());
                    }
                }
            }
            if !failed.is_empty() {
                anyhow::bail!("seed stages failed: {}", failed.join(", "));
            }
        }
    }
    Ok(())
}

fn json_str(s: &str) -> String {
    serde_json::Value::String(s.to_string()).to_string()
}

/// Idempotent user upsert by email — the update branch is EMPTY on purpose
/// (re-running never clobbers role changes / deactivations), matching the
/// legacy ensureSeedUsers().
async fn seed_users(pool: &PgPool) -> anyhow::Result<usize> {
    // The auth service owns this table and creates it via its migrations;
    // a fresh stack must boot auth (or run its migrations) before seeding.
    let mut ensured = 0;
    for (email, name, role) in SEED_USERS {
        let password_hash = mf_auth::hash_password(DEMO_USER_PASSWORD)
            .map_err(|e| anyhow::anyhow!("scrypt failed: {e}"))?;
        let result = sqlx::query(
            "INSERT INTO auth.users (id, email, name, role, password_hash) \
             VALUES ($1, $2, $3, $4, $5) \
             ON CONFLICT (email) DO NOTHING",
        )
        .bind(mf_db::new_id())
        .bind(email)
        .bind(name)
        .bind(role)
        .bind(&password_hash)
        .execute(pool)
        .await;
        match result {
            Ok(_) => ensured += 1,
            Err(e) => anyhow::bail!("seed user {email} failed (auth migrations applied?): {e}"),
        }
    }
    let total: i64 = sqlx::query_scalar("SELECT count(*) FROM auth.users")
        .fetch_one(pool)
        .await?;
    tracing::info!(ensured, total_users = total, "demo users seeded");
    Ok(ensured)
}

/// POST a service seed valve through the gateway with the service token.
/// Returns "ok" | "skipped (already seeded)". 4xx bodies whose `error`
/// message indicates existing data count as skipped; anything else fails.
async fn seed_via_gateway(path: &str) -> anyhow::Result<&'static str> {
    let base = std::env::var("GATEWAY_URL").unwrap_or_else(|_| "http://gateway:8080".to_string());
    let token = std::env::var("MF_SERVICE_TOKEN").unwrap_or_default();
    if token.is_empty() {
        anyhow::bail!("MF_SERVICE_TOKEN must be set for gateway seeding");
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()?;
    let resp = client
        .post(format!("{}{}", base.trim_end_matches('/'), path))
        .header("x-service-token", &token)
        .header("content-type", "application/json")
        .body("{}")
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("gateway unreachable at {base}{path}: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if status.is_success() {
        return Ok("ok");
    }
    let message = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(String::from))
        .unwrap_or(text);
    let lower = message.to_lowercase();
    if status.as_u16() == 400
        && (lower.contains("already") || lower.contains("exists") || lower.contains("seeded"))
    {
        return Ok("skipped (already seeded)");
    }
    anyhow::bail!("{path} → HTTP {status}: {message}")
}
