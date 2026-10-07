# MiniFoundry

A learning-scale Palantir Foundry clone: ingest data, build versioned
datasets, author SQL/Python/JavaScript transforms, orchestrate visual
pipelines, model an Ontology with actions that write back, and explore
lineage, quality, governance, dashboards and Workshop-style applications —
now as **Rust microservices + PostgreSQL + NATS JetStream + a React SPA**,
all running in **Docker Compose**.

```
┌────────────┐   /api/*    ┌──────────┐
│  frontend  │────────────▶│ gateway  │  JWT/actor resolution, demo+shared
│ nginx+SPA  │  (proxy)    │  :8080   │  modes, rate-limit headers, routing
│   :3000    │             └────┬─────┘
└────────────┘                  │ X-Mf-Actor-* headers
        ┌───────────┬───────────┼────────────┬─────────────┬───────────┐
        ▼           ▼           ▼            ▼             ▼           ▼
    ┌───────┐  ┌─────────┐ ┌───────────┐ ┌────────┐ ┌──────────┐ ┌──────────┐
    │ auth  │  │ catalog │ │orchestra- │ │compute │ │ ontology │ │governance│
    │ :8081 │  │ :8082   │ │tion :8083 │ │ :8084  │ │ :8085    │ │ :8086    │
    └───┬───┘  └────┬────┘ └─────┬─────┘ └───┬────┘ └────┬─────┘ └────┬─────┘
        │           │            │           │           │            │        ┌────────────┐
        └───────────┴────────────┴───────────┴───────────┴────────────┴──────▶│ public-api │
                    PostgreSQL 17 (one schema per service)  +  NATS JetStream  │   :8087    │
                    auth · catalog · orchestration · compute · ontology ·      └────────────┘
                    governance          (events: versions, jobs, audit, notify, approvals)
```

## Quickstart

```bash
docker compose up -d --build                     # build + boot everything (~11 containers)
docker compose --profile tools run --rm seed all # seed the demo workspace
# app      → http://localhost:3000
# gateway  → http://localhost:8080/api
```

Demo login (seeded): `demo-admin@example.invalid` / `<redacted>`
(also `editor@` / `demo-viewer@example.invalid`, same password).

Stop everything: `docker compose down` (add `-v` to wipe database volumes).

## Services

| Service | Port | Owns |
|---|---|---|
| `frontend` | 3000 | Vite + React 19 + TanStack Router/Query/Table SPA (nginx; proxies `/api` to the gateway) |
| `gateway` | 8080 | routing, JWT validation + transparent refresh, demo/shared actor resolution, CORS, edge header hygiene |
| `auth` | 8081 | users, sessions (JWT + rotating refresh), role simulator/impersonation, public API tokens, usage observability |
| `catalog` | 8082 | projects, datasets + versions/branches, quality rules + publication gate, connectors + ingestion (CSV/JSON/REST w/ SSRF guards), lineage, masking authority |
| `orchestration` | 8083 | pipelines + graph engine (12 node types), execution jobs (Postgres leases + NATS wake), schedules, upstream triggers/cascades, replay/retry, platform health |
| `compute` | 8084 | code workbooks: SQL (ephemeral SQLite), JavaScript (QuickJS sandbox), Python (isolated subprocess) |
| `ontology` | 8085 | object types/links/actions (+write-back), saved views, dashboards, Workshop-style applications |
| `governance` | 8086 | markings, approvals, audit trail (NATS consumer), ACLs, notifications, curriculum, settings, search + stats fan-out |
| `public-api` | 8087 | `foundry/v1` token-authed read API (viewer-masked, per-token rate limits) |
| `seed` (profile `tools`) | — | one-shot workspace seeder (`mf-seed users|all`) |

Shared crates: `mf-types` (wire contracts), `mf-db`, `mf-auth`, `mf-web`,
`mf-events` (NATS), `mf-internal` (service clients), `mf-js` (QuickJS),
`mf-sqlrun` (ephemeral SQLite). Details: [backend/README.md](backend/README.md).

## Runtime modes

| | `demo` (default) | `shared` (`MF_DEMO_MODE=false`) |
|---|---|---|
| anonymous callers | resolve to `admin` (sandbox explorability) | `anonymous` — every role-guarded route 403s; the gateway's auth wall 401s unauthenticated `/api/*` outside the allowlist |
| role simulator cookie | honored (`foundry-role`) | ignored |
| machine callers | optional | must send `x-service-token: <MF_SERVICE_TOKEN>` |
| secrets | dev fallback (warns) | `AUTH_SECRET` required (gateway + auth fail fast without it) |

Configure via `.env` (see `.env.example`).

## Development

```bash
# infra only (postgres :5432, nats :4222 published)
docker compose -f docker-compose.dev.yml up -d

# backend — host has no MSVC linker requirement: builds run in Docker
cd backend
.\cargo.ps1 check --workspace      # also: test / clippy / build -p <crate>

# run services natively-in-docker against dev infra (one command):
..\scripts\dev-stack.ps1 -Services all

# frontend
cd frontend && bun install && bun run dev   # :3000, proxies /api → :8080
```

## Verification suite

| Harness | What it proves |
|---|---|
| `node scripts/e2e-phase1.mjs` | auth + gateway flows (login, sessions, impersonation, tokens, guards) — 27 checks |
| `node scripts/verify-contracts.mjs` | replays captured golden fixtures from the legacy Next.js API against the new stack (strict on deterministic surfaces, shape-mode on history-dependent ones) — 70 checks |
| `bash scripts/smoke.sh` | full cross-service journey: seed → datasets/branches/quality/publish → pipeline run+replay → SQL/JS/Python transforms → ontology → governance → v1 API rate limits → masking matrix → SPA — ~94 checks |
| `scripts/integrate.ps1` | runs all of the above as one gate |
| `cargo test --workspace` | 335+ unit tests (engine nodes, link resolution, masking, quality rules, JS/Python runners, egress SSRF tables, …) |

Golden-contract fixtures and the internal service API contract live in
[backend/contracts/](backend/contracts/). CI: `.github/workflows/verify.yml`.

## Project history

This repo was ported from a Next.js 16 + Prisma/SQLite monolith (113 API
routes, ~18.5K lines of TS backend) to the current architecture on branch
`feat/rust-microservices`; the legacy app remains in git history (`main`).
Migration log: [MIGRATION.md](MIGRATION.md) · cutover checklist:
[CUTOVER.md](CUTOVER.md) · historical worklog: [worklog.md](worklog.md).
