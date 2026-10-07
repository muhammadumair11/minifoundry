//! MiniFoundry — workspace seeder.
//!
//! Ports the legacy seed scripts:
//! - `scripts/seed-users-cli.ts` + `ensureSeedUsers()` (src/lib/seed.ts)
//! - `scripts/seed-cli.ts` (demo workspace — lands with the catalog port)
//! - `scripts/seed-schedule-cli.ts` (schedules — lands with orchestration)
//!
//! Runs as a one-shot container (`docker compose --profile tools run --rm seed`)
//! or natively with DATABASE_URL pointing at Postgres. ALL tables are written
//! with schema-qualified names (the seeder may run as the superuser or as the
//! dedicated mf_seed role).

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
    /// Seed the full demo workspace (users + datasets + pipelines + ontology +
    /// governance). Domain parts land with their service phases; today this
    /// seeds users and reports what is not yet available.
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

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_env_filter("info").init();
    let cli = Cli::parse();

    let url = std::env::var("DATABASE_URL")
        .map_err(|_| anyhow::anyhow!("DATABASE_URL must be set"))?;
    let pool = mf_db::connect(&url, "public", 4).await?;

    match cli.command {
        Commands::Users => {
            let n = seed_users(&pool).await?;
            println!(r#"{{"ensured":{n}}}"#);
        }
        Commands::All => {
            let n = seed_users(&pool).await?;
            println!(r#"{{"ensured":{n},"note":"dataset/pipeline/ontology/governance seeding lands with the service ports"}}"#);
        }
    }
    Ok(())
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
