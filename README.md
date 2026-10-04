# MiniFoundry

A learning-scale Palantir Foundry: ingest data, build versioned datasets,
author SQL/Python/JavaScript transforms, orchestrate visual pipelines, model an
Ontology with actions that write back, and explore lineage, quality, governance
and dashboards — all in one Next.js app with a SQLite database.

MiniFoundry is optimized for a **trustworthy end-to-end learning experience**,
not a feature-for-feature Foundry clone. A learner should be able to build a
pipeline, break it, diagnose it, fix it, publish it, and explain how each step
differs from real Foundry.

## Quickstart

```bash
bun install
bun run db:push      # create/update the SQLite schema
bun run dev          # Next.js on http://localhost:3000
```

The scheduler mini-service (optional, enables recurring schedules):

```bash
cd mini-services/scheduler-service && bun install && bun run dev   # :3030
```

Demo login (seeded): `demo-admin@example.invalid` / `<redacted>` — or use the
role simulator from the app's Settings page in demo mode.

## Runtime modes (important)

| | `demo` (default) | `shared` |
|---|---|---|
| env | `MF_DEMO_MODE` unset/`true` | `MF_DEMO_MODE=false` |
| anonymous requests | resolve to `admin` (sandbox explorability) | resolve to `anonymous` — every role-guarded API 403s |
| role simulator cookie | honored | **ignored** (escalation vector) |
| machine callers (scheduler, curl) | no token needed | must send `x-service-token: <MF_SERVICE_TOKEN>` |
| session secret | dev fallback (warns) | `AUTH_SECRET` required (fallback still warns) |

Run shared mode like this:

```bash
# app
MF_DEMO_MODE=false AUTH_SECRET=<32+ random chars> MF_SERVICE_TOKEN=<secret> bun run dev
# scheduler (same token)
MF_SERVICE_TOKEN=<same secret> bun run dev
```

**Never expose demo mode to more than one person.** Its anonymous-admin
fallback is a deliberate learning affordance, not a security model.

## Architecture

```
CSV / JSON / REST / sample data ─▶ ingestion routes ─▶ SQLite dataset versions (JSON snapshots)
                                                          │
                    visual pipeline engine ◀──────────────┤──▶ SQL / Python / JS workbooks
                    (DAG, retries, triggers)              │
                                                          ▼
                              Ontology objects + actions (writeback)
                                                          │
                                          dashboards · lineage · token API
mini-services/scheduler-service ──polls──▶ /api/schedules/due ─▶ pipeline runs
```

- **Next.js 16 (App Router) + TypeScript** — UI, REST API, execution engines
  (`src/lib/engine.ts`, `transform-engine.ts`, `dataset-service.ts`).
- **Prisma + SQLite** — metadata AND row snapshots (`prisma/schema.prisma`).
- **Scheduler mini-service (Bun)** — polls for due schedules every 30s
  (`mini-services/scheduler-service`).
- **Gateway** — one exposed port; cross-service calls use `?XTransformPort=`.

## Quality gates

```bash
bun run lint        # ESLint (must stay clean)
bunx tsc --noEmit   # TypeScript gate — the build FAILS on type errors
```

Ad-hoc API smoke checks (demo mode, no cookies needed):

```bash
curl -s localhost:3000/api/health | head -c 300
curl -s localhost:3000/api/settings/overview | head -c 300
```

## Deliberate learning-scale simplifications

These differ from real Foundry **on purpose** — they are teaching moments:

- Dataset versions are JSON snapshots (≤ 5,000 rows), not Parquet files.
- Pipeline runs execute synchronously in-process; no durable worker queue.
- Branches merge by copying the head version (Foundry's dataset branches do
  not merge at all — pipeline-logic branches are a separate concept).
- Quality rules are expectation checks, not a published-data gate (Phase 2
  roadmap: preview → validate → approve → publish).
- User code runs in-process: SQL against the same SQLite file, JS via
  `node:vm`, Python as a `python3 -I -B` child with a **scrubbed environment**
  and 5s timeout. `node:vm` is NOT a security boundary — don't run untrusted
  users' code in a shared deployment.
- REST connectors enforce SSRF egress controls (public http(s) targets only,
  all DNS-resolved addresses checked, ≤ 3 re-validated redirects). A DNS
  rebinding TOCTOU window remains; that requires socket-level pinning.

## Roadmap (delivery order)

0. **Foundation** ✅ — explicit demo/shared modes, service-token scheduler,
   consistent masking on dashboards, egress guard, TS gate, this README.
1. **Reproducible builds** — run manifest pinning graph/code + input versions.
2. **Trust workflow** — quality as a publication gate + version-level lineage.
3. **Guided curriculum** — executable exercises with checkpoints.
4. **Collaboration & UI** — real branch experimentation, builder polish.
5. **Scale track (optional)** — file-backed datasets, indexed previews.
