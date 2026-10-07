# MiniFoundry migration status (feat/rust-microservices)

Live status of the Next.js → Rust microservices port. Plan of record:
8 Axum services + Vite/TanStack SPA + Postgres (schema-per-service) + NATS
JetStream + custom gateway, all in Docker Compose, 100% route parity
(113 legacy routes, see `backend/contracts/ROUTE_INVENTORY.txt`).

## Phases

| Phase | Scope | Status |
|---|---|---|
| 0 | Branch, Cargo workspace + shared crates, compose infra (pg/nats), CI skeleton, golden-contract capture (~80 fixtures), internal-API contract | ✅ done |
| 1 | auth-service (users/JWT/refresh/tokens/usage), gateway (routing/actor/demo-mode/auth wall/transparent refresh), SPA conversion (Vite + TanStack Router; vite build + tsc green; proxy chain verified) — E2E 27/27; frontend Docker image verified (SPA + nginx /api proxy + deep-link fallback) | ✅ done |
| 2 | catalog service (28 routes, datasets/versions/branches/quality/publish, connectors/ingest/egress, lineage, /api/seed) | ✅ committed (6be59de, 76 tests); agent finishing live verification + spec addendum (cascade passthrough, versionNumber in rows, internal DELETEs) |
| 3 | orchestration (19 routes, engine 12 node types, jobs/leases, scheduler, triggers, replay/retry, /api/health) + mf-js (rquickjs) | ✅ COMPLETE (2b802c1; 68 tests; live E2E vs catalog: pipeline run/replay/retry/cascade/upstream/scheduler/output all verified) |
| 4 | compute (transforms SQL/JS/Python + replay + seed-demo) | ✅ COMPLETE (ed6eb0a; clippy clean, 23/23 tests, all 3 languages live-verified on :8084; catalog-dependent E2E flows deferred to integration) |
| 5 | ontology (objects/links/actions/write-back/views, dashboards, applications) | ✅ committed (c09ef0f, 82 tests); amending action-apply path to RAW rows (legacy-verified masking map) |
| 6 | governance (markings/approvals/audit/ACL/notifications/curriculum/settings/search/stats) + public-api (foundry/v1) | 🔨 agent finishing (governance committed; public-api container observed booting) |
| 7 | full smoke (`scripts/integrate.ps1` gate), compose hardening, README rewrite, DELETE legacy Next.js app (see CUTOVER.md), final CI | ⏳ pending agent completions |

## Resume point (if continuing in a later session)

Five durable subagent workers ported the services (compute committed; others
finishing compile/verify cycles — check `git log` and their reports first).
Integration sequence once services are committed:

1. `cd backend; .\cargo.ps1 build --workspace` (fix any cross-service breakage)
2. `.\scripts\dev-stack.ps1 -Services all` (builds + boots every service
   container against docker-compose.dev.yml infra with host-reachable URLs)
3. `docker run --rm -v mf-cargo-target:/t:ro -e DATABASE_URL=postgres://postgres:<redacted>@host.docker.internal:5432/minifoundry -e GATEWAY_URL=http://host.docker.internal:8080 -e MF_SERVICE_TOKEN=<redacted> debian:bookworm-slim /t/debug/mf-seed all`
4. `node scripts/e2e-phase1.mjs --base http://localhost:8080`
   `node scripts/verify-contracts.mjs --base http://localhost:8080`
   `bash scripts/smoke.sh http://localhost:8080`
5. Fix seams → commit → `docker compose up -d --build` full-stack pass →
   CUTOVER.md checklist → final CI + README.

## How to run (current partial stack)

```bash
# infra
docker compose -f docker-compose.dev.yml up -d          # postgres :5432, nats :4222

# backend builds (host has no MSVC linker — everything goes through Docker)
cd backend
.\cargo.ps1 check --workspace
.\cargo.ps1 test --workspace
.\cargo.ps1 build -p mf-auth-service -p mf-gateway -p mf-seed

# run services (see backend/README.md for env details) — containers read
# binaries from the mf-cargo-target volume:
docker run -d --name mf-auth -p 8081:8081 -v mf-cargo-target:/t:ro -e PORT=8081 \
  -e DATABASE_URL='postgres://mf_auth:<redacted>@host.docker.internal:5432/minifoundry' \
  -e NATS_URL='nats://host.docker.internal:4222' -e MF_DEMO_MODE=true \
  -e MF_SERVICE_TOKEN='<redacted>' \
  -e AUTH_SECRET='<redacted>' -e MF_COOKIE_SECURE=0 \
  debian:bookworm-slim /t/debug/mf-auth-service
# gateway: same pattern, -p 8080:8080, + AUTH_INTERNAL_URL=http://host.docker.internal:8081

# seed demo users
docker run --rm -v mf-cargo-target:/t:ro \
  -e DATABASE_URL='postgres://postgres:<redacted>@host.docker.internal:5432/minifoundry' \
  debian:bookworm-slim /t/debug/mf-seed users

# frontend
cd frontend && bun install && bun run dev               # :3000 → proxies /api to :8080

# verification
node scripts/e2e-phase1.mjs --base http://localhost:8080        # phase-1 flows (27 checks)
node scripts/verify-contracts.mjs --base http://localhost:8080  # golden-contract replay (grows per phase)
```

Full `docker compose up` (prod-like, all containers) becomes the default entry
point at Phase 7; until then services are validated with the container-run
pattern above.

## Key decisions log

- JWT HS256 (shared AUTH_SECRET) access 15min + rotating refresh 7d, gateway
  single-flight transparent refresh — replaces legacy 7d HMAC cookie at the
  wire level; cookie names/flows unchanged for the SPA.
- Actor identity via gateway-injected `X-Mf-Actor-*` headers (email/name
  base64url); services re-enforce role guards; `X-Mf-Service:1` bypasses
  guards exactly like the legacy service token.
- Masking computed once in catalog's internal rows endpoints (governance
  markings + forwarded actor role) — consumers never see unmasked rows.
- Single version-write door: catalog `POST /internal/datasets/{id}/versions`
  (outputJobId idempotency, quality auto-eval, then `mf.dataset.version.created`).
- Job correctness stays in the Postgres lease (CAS + heartbeat + sweep);
  NATS `mf.jobs.pipeline.run` is a wake-up to remove polling latency.
- mf-js uses rquickjs (QuickJS) instead of deno_core — approved plan fallback,
  chosen for build weight/network reliability; trait kept engine-swappable.
- SQL workbooks run on ephemeral in-memory SQLite (rusqlite, bundled) —
  exact parity with legacy node:sqlite semantics (all-TEXT materialization,
  JS cell mapping incl. whole-REAL → integer and BLOB → comma-joined bytes).
- Rust toolchain: host rustup 1.99 (via rsproxy mirror); ALL builds run in
  `rust:1-bookworm` containers (backend/cargo.ps1) — host lacks MSVC linker.
- crates.io routed through rsproxy.cn mirror (~/.cargo/config.toml) due to
  poor direct-CDN throughput on this network.
