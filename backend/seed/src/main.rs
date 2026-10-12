//! MiniFoundry — workspace seeder.
//!
//! Ports the legacy seed scripts:
//! - `scripts/seed-users-cli.ts` + `ensureSeedUsers()` (src/lib/seed.ts) —
//!   direct DB writes into auth.users.
//! - The legacy `/api/seed` demo-pipeline creation (seed.ts lines 236-256 +
//!   sample-data.ts DEMO_PIPELINE) — direct DB write into
//!   orchestration.pipelines (the pipeline domain has no HTTP seed valve).
//! - The UI seed valves (POST /api/seed, /api/ontology/seed-demo,
//!   /api/transforms/seed-demo, /api/governance/seed-demo) — replayed as
//!   HTTP calls THROUGH THE GATEWAY with the service token, so seeding uses
//!   each service's own implementation (single source of truth).
//! - A demo-pipeline RUN between the workspace and transforms stages: the
//!   legacy demo workspace has the pipeline's output dataset ("Active
//!   Shipments") present, and transforms seed-demo requires it.
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
    /// Seed the full demo workspace in dependency order:
    /// users → datasets/connectors (/api/seed) → demo pipeline (DB) →
    /// run it (creates "Active Shipments") → ontology → transforms →
    /// governance. Idempotent: "already seeded" responses count as success.
    All,
    /// Truncate ALL tables in ALL service schemas (auth, catalog, orchestration, compute, ontology, governance).
    /// WARNING: This permanently deletes all data. Use with caution.
    Reset {
        /// Skip confirmation prompt (use with caution!)
        #[arg(long)]
        yes: bool,
    },
}

/// Password for every demo user (legacy DEMO_USER_PASSWORD).
const DEMO_USER_PASSWORD: &str = "<redacted>";

/// Legacy SEED_USERS — email/name/role of the demo trio.
const SEED_USERS: [(&str, &str, &str); 3] = [
    ("demo-admin@example.invalid", "Ada Admin", "admin"),
    ("demo-editor@example.invalid", "Eddie Editor", "editor"),
    ("demo-viewer@example.invalid", "Vera Viewer", "viewer"),
];

/// Legacy DEMO_PIPELINE (sample-data.ts) — graph with the __SHIPMENTS__
/// placeholder resolved at seed time.
const DEMO_PIPELINE_NAME: &str = "Shipment Overview";
const DEMO_PIPELINE_DESCRIPTION: &str =
    "Derive total value per shipment line, then filter out delivered shipments.";

fn demo_pipeline_graph(shipments_dataset_id: &str) -> serde_json::Value {
    serde_json::json!({
        "nodes": [
            {
                "id": "src-shipments",
                "type": "source",
                "data": { "datasetId": shipments_dataset_id },
                "position": { "x": 80, "y": 200 }
            },
            {
                "id": "derive-total-value",
                "type": "derive",
                "data": { "newColumn": "totalValue", "expression": "row.quantity * row.unitPrice" },
                "position": { "x": 360, "y": 200 }
            },
            {
                "id": "filter-not-delivered",
                "type": "filter",
                "data": { "column": "status", "operator": "neq", "value": "delivered" },
                "position": { "x": 640, "y": 200 }
            },
            {
                "id": "output-active-shipments",
                "type": "output",
                "data": { "name": "Active Shipments" },
                "position": { "x": 920, "y": 200 }
            }
        ],
        "edges": [
            { "id": "edge-1", "source": "src-shipments", "target": "derive-total-value" },
            { "id": "edge-2", "source": "derive-total-value", "target": "filter-not-delivered" },
            { "id": "edge-3", "source": "filter-not-delivered", "target": "output-active-shipments" }
        ]
    })
}

/// HTTP seed valves in dependency order. The pipeline stages (DB insert +
/// run) are interleaved between "workspace" and "ontology" in `all`.
const STAGE_ONTOLOGY: (&str, &str) = ("ontology", "/api/ontology/seed-demo");
const STAGE_TRANSFORMS: (&str, &str) = ("transforms", "/api/transforms/seed-demo");
const STAGE_GOVERNANCE: (&str, &str) = ("governance", "/api/governance/seed-demo");

/// Truncate application tables in all service schemas.
/// This is a destructive operation that removes ALL application data, but it
/// deliberately preserves SQLx's migration ledger. Removing that ledger makes
/// services replay their initial migrations against existing tables on restart.
async fn reset_database(pool: &PgPool, yes: bool) -> anyhow::Result<()> {
    if !yes {
        eprint!("⚠️  This will PERMANENTLY DELETE ALL DATA in all service schemas (auth, catalog, orchestration, compute, ontology, governance).\nType 'yes' to confirm: ");
        use std::io::{self, Write};
        io::stdout().flush()?;
        let mut input = String::new();
        io::stdin().read_line(&mut input)?;
        if input.trim() != "yes" {
            anyhow::bail!("Reset cancelled");
        }
    }

    let schemas = [
        "auth",
        "catalog",
        "orchestration",
        "compute",
        "ontology",
        "governance",
    ];

    for schema in schemas {
        // Get all tables in the schema
        let tables: Vec<(String,)> =
            sqlx::query_as(
                "SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename <> '_sqlx_migrations'",
            )
                .bind(schema)
                .fetch_all(pool)
                .await?;

        if tables.is_empty() {
            println!("Schema '{}' has no tables", schema);
            continue;
        }

        // Disable triggers and truncate all tables
        for (table,) in tables {
            let full_table = format!("{}.{}", schema, table);
            println!("Truncating {}", full_table);
            sqlx::query(&format!(
                "TRUNCATE TABLE {} RESTART IDENTITY CASCADE",
                full_table
            ))
            .execute(pool)
            .await?;
        }
    }

    println!("✅ All service schemas truncated successfully");
    Ok(())
}

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
        Commands::Reset { yes } => {
            reset_database(&pool, yes).await?;
        }
        Commands::All => {
            let mut failed: Vec<String> = Vec::new();
            let mut stage = |name: &str, res: Result<String, String>| match res {
                Ok(status) => println!(r#"{{"stage":"{name}","status":"{status}"}}"#),
                Err(e) => {
                    eprintln!(
                        r#"{{"stage":"{name}","status":"failed","error":{}}}"#,
                        json_str(&e)
                    );
                    failed.push(name.to_string());
                }
            };

            match seed_users(&pool).await {
                Ok(n) => stage("users", Ok(format!("ok (ensured {n})"))),
                Err(e) => stage("users", Err(e.to_string())),
            }
            stage(
                "workspace",
                seed_via_gateway("/api/seed")
                    .await
                    .map(str_to_owned)
                    .map_err(|e| e.to_string()),
            );
            match seed_demo_pipeline(&pool).await {
                Ok(status) => stage("pipeline", Ok(status)),
                Err(e) => stage("pipeline", Err(e.to_string())),
            }
            match run_demo_pipeline().await {
                Ok(status) => stage("pipeline-run", Ok(status)),
                Err(e) => stage("pipeline-run", Err(e.to_string())),
            }
            for (name, path) in [STAGE_ONTOLOGY, STAGE_TRANSFORMS, STAGE_GOVERNANCE] {
                match seed_via_gateway(path).await {
                    Ok(status) => stage(name, Ok(status.to_string())),
                    Err(e) => stage(name, Err(e.to_string())),
                }
            }

            if !failed.is_empty() {
                anyhow::bail!("seed stages failed: {}", failed.join(", "));
            }
        }
    }
    Ok(())
}

fn str_to_owned(s: &'static str) -> String {
    s.to_string()
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
        sqlx::query(
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
        .await
        .map_err(|e| anyhow::anyhow!("seed user {email} failed (auth migrations applied?): {e}"))?;
        ensured += 1;
    }
    let total: i64 = sqlx::query_scalar("SELECT count(*) FROM auth.users")
        .fetch_one(pool)
        .await?;
    tracing::info!(ensured, total_users = total, "demo users seeded");
    Ok(ensured)
}

/// Insert the legacy demo pipeline directly into orchestration.pipelines
/// (idempotent by name), resolving the __SHIPMENTS__ placeholder against
/// catalog.datasets — the exact legacy seed.ts behavior.
async fn seed_demo_pipeline(pool: &PgPool) -> anyhow::Result<String> {
    let existing: Option<(String,)> =
        sqlx::query_as("SELECT id FROM orchestration.pipelines WHERE name = $1")
            .bind(DEMO_PIPELINE_NAME)
            .fetch_optional(pool)
            .await?;
    if let Some((id,)) = existing {
        return Ok(format!("skipped (already seeded {id})"));
    }

    let shipments: Option<(String,)> =
        sqlx::query_as("SELECT id FROM catalog.datasets WHERE name = 'Shipments' LIMIT 1")
            .fetch_optional(pool)
            .await?;
    let (shipments_id,) = shipments.ok_or_else(|| {
        anyhow::anyhow!(
            "Seed error: Shipments dataset was not created (run the workspace stage first)"
        )
    })?;

    let graph = demo_pipeline_graph(&shipments_id);
    let id = mf_db::new_id();
    sqlx::query(
        "INSERT INTO orchestration.pipelines (id, name, description, graph_json) \
         VALUES ($1, $2, $3, $4)",
    )
    .bind(&id)
    .bind(DEMO_PIPELINE_NAME)
    .bind(DEMO_PIPELINE_DESCRIPTION)
    .bind(sqlx::types::Json(graph))
    .execute(pool)
    .await?;
    tracing::info!(id, "demo pipeline seeded");
    Ok(format!("ok ({id})"))
}

/// Run the demo pipeline through the gateway (service actor) and wait for the
/// job to settle, so "Active Shipments" exists for the transforms seed —
/// reproducing the legacy demo-workspace state.
async fn run_demo_pipeline() -> anyhow::Result<String> {
    let base = gateway_url();
    let token = std::env::var("MF_SERVICE_TOKEN").unwrap_or_default();
    if token.is_empty() {
        anyhow::bail!("MF_SERVICE_TOKEN must be set for the pipeline-run stage");
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()?;

    // Find the pipeline id.
    let pipelines: serde_json::Value = client
        .get(format!("{base}/api/pipelines"))
        .header("x-service-token", &token)
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("gateway unreachable: {e}"))?
        .error_for_status()
        .map_err(|e| anyhow::anyhow!("GET /api/pipelines: {e}"))?
        .json()
        .await?;
    let id = pipelines
        .get("pipelines")
        .and_then(|p| p.as_array())
        .and_then(|arr| {
            arr.iter()
                .find(|p| p.get("name").and_then(|n| n.as_str()) == Some(DEMO_PIPELINE_NAME))
        })
        .and_then(|p| p.get("id"))
        .and_then(|i| i.as_str())
        .ok_or_else(|| anyhow::anyhow!("demo pipeline '{DEMO_PIPELINE_NAME}' not found"))?
        .to_string();

    // Enqueue a run.
    let run: serde_json::Value = client
        .post(format!("{base}/api/pipelines/{id}/run"))
        .header("x-service-token", &token)
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("run enqueue failed: {e}"))?
        .error_for_status()
        .map_err(|e| anyhow::anyhow!("POST run: {e}"))?
        .json()
        .await?;
    let job_id = run
        .pointer("/job/id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("run response has no job id"))?
        .to_string();

    // Poll until the job settles (worker lease + engine; generous timeout).
    for _ in 0..60 {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        let job: serde_json::Value = match client
            .get(format!("{base}/api/execution-jobs/{job_id}"))
            .header("x-service-token", &token)
            .send()
            .await
        {
            Ok(r) => match r.json().await {
                Ok(v) => v,
                Err(_) => continue,
            },
            Err(_) => continue,
        };
        let status = job
            .pointer("/job/status")
            .and_then(|s| s.as_str())
            .unwrap_or("");
        match status {
            "succeeded" => return Ok(format!("ok (job {job_id} succeeded)")),
            "failed" => {
                let err = job
                    .pointer("/job/error")
                    .and_then(|e| e.as_str())
                    .unwrap_or("unknown");
                anyhow::bail!("demo pipeline run failed: {err}");
            }
            _ => {}
        }
    }
    anyhow::bail!("demo pipeline run did not settle within 60s (job {job_id})")
}

fn gateway_url() -> String {
    std::env::var("GATEWAY_URL").unwrap_or_else(|_| "http://gateway:8080".to_string())
}

/// POST a service seed valve through the gateway with the service token.
/// Returns "ok" | "skipped (already seeded)". 4xx bodies whose `error`
/// message indicates existing data count as skipped; anything else fails.
async fn seed_via_gateway(path: &str) -> anyhow::Result<&'static str> {
    let base = gateway_url();
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
