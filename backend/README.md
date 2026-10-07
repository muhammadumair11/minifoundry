# MiniFoundry backend (Rust microservices)

Cargo workspace: 8 Axum services + shared crates + seed CLI, PostgreSQL
(schema-per-service, sqlx) and NATS JetStream, all orchestrated by Docker
Compose from the repository root.

```
backend/
├── crates/
│   ├── mf-types/      # wire contracts (Row, SchemaColumn, LogEntry, ISO-8601 ts)
│   ├── mf-db/         # pool + search_path, UUIDv7 ids, migrations
│   ├── mf-auth/       # roles, actors, JWT, scrypt, runtime modes, header codec
│   ├── mf-web/        # axum glue: { error } envelope, role guards, cookies, tracing
│   ├── mf-events/     # NATS JetStream: subjects, streams, typed events
│   ├── mf-internal/   # service-to-service HTTP clients (/internal/*)
│   ├── mf-js/         # sandboxed JS evaluation (derive + workbooks)
│   └── mf-sqlrun/     # ephemeral SQLite executor for SQL workbooks
├── services/
│   ├── gateway/       # :8080 edge — routing, JWT/actor resolution, auth wall
│   ├── auth/          # :8081 users, sessions, refresh, API tokens, usage
│   ├── catalog/       # :8082 projects, datasets, versions, branches, quality,
│   │                  #       connectors, ingestion, lineage
│   ├── orchestration/ # :8083 pipelines, engine, runs, jobs, schedules
│   ├── compute/       # :8084 SQL/JS/Python transform workbooks
│   ├── ontology/      # :8085 object types, links, actions, views, dashboards, apps
│   ├── governance/    # :8086 markings, approvals, audit, ACL, notifications,
│   │                  #       curriculum, settings, search, stats
│   └── public-api/    # :8087 foundry/v1 token-authed read API
├── seed/              # mf-seed CLI (demo users + workspace)
└── contracts/         # golden fixtures captured from the legacy Next.js API
```

## Running

Full stack (from repo root):

```bash
docker compose up -d --build                      # everything
docker compose --profile tools run --rm seed all  # seed demo workspace
# app → http://localhost:3000   gateway → http://localhost:8080
```

Native dev (fast iteration; infra in Docker):

```bash
docker compose -f docker-compose.dev.yml up -d    # postgres :5432, nats :4222
cd backend
DATABASE_URL=postgres://mf_auth:<redacted>@localhost:5432/minifoundry \
  NATS_URL=nats://localhost:4222 PORT=8081 \
  MF_SERVICE_TOKEN=<redacted> \
  cargo run -p mf-auth-service
# ...one shell per service; gateway needs AUTH_SECRET set to the same value.
cd ../frontend && bun dev                          # vite on :3000 → gateway :8080
```

## Conventions

- **Contracts are law.** Every public route reproduces the legacy JSON shape
  pinned in `contracts/` (see `contracts/README.md`); internal endpoints are
  specified in `contracts/INTERNAL_API.md`.
- **Ids** are UUIDv7 text (legacy cuids are opaque to clients; fixtures treat
  ids as volatile).
- **Timestamps** serialize as ISO-8601 UTC millis + `Z` (`mf_types::ts`).
- **Errors** are `{ "error": "...", "detail"?: ... }`; role guards use the
  exact legacy message `requires <min> role (current: <role>)`.
- **Actors** arrive as gateway-injected `X-Mf-Actor-*` headers (email/name
  base64url-encoded); services re-enforce `require_role` and trust
  `X-Mf-Service: 1` only from the gateway network.
- **Migrations** live per service (`services/<name>/migrations/`) and run
  idempotently at boot.
- **Events** are fire-and-forget (`publish_json_quiet`) for audit/notify —
  a dead consumer must never break a request (legacy semantics).

## Testing

```bash
cargo test --workspace                # unit + contract tests
cargo clippy --workspace --all-targets
# integration tests need infra:
docker compose -f docker-compose.dev.yml up -d
```

Contract tests replay `contracts/*.meta.json` requests against the service
(seeded ephemeral Postgres) and assert structural equality with the fixture
bodies, exact error strings, and status codes.
