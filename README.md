# MiniFoundry

A learning-scale Palantir Foundry: ingest data, build versioned datasets,
author SQL/Python/JavaScript transforms, orchestrate visual pipelines, model an
Ontology with actions that write back, and explore lineage, quality, governance,
dashboards and Workshop-style applications (live maps over Ontology objects) —
all in one Next.js app with a SQLite database.

MiniFoundry is optimized for a **trustworthy end-to-end learning experience**,
not a feature-for-feature Foundry clone. A learner should be able to build a
pipeline, break it, diagnose it, fix it, publish it, and explain how each step
differs from real Foundry.

## Quickstart

```bash
bun install
bun run db:push      # create/update the SQLite schema
bun run dev          # Next.js on http://localhost:3000
bun run jobs:worker  # separate terminal: execute manual, scheduled, and upstream jobs
```

For a local Windows checkout, set `DATABASE_URL=file:../db/custom.db` in your
environment before running Prisma or the app. The bundled `.env` may still
contain a path from the original Linux workspace.

For everyday local use, run `npm run local` from the project root. It builds
the app when needed, then starts the production app, job worker, and scheduler
together at `http://127.0.0.1:3000`. Press Ctrl+C to stop all three. The
launcher uses `db/custom.db` automatically, so no environment setup is needed.
It requires Node.js 22.5+ for the app's `node:sqlite` support and Bun for the
worker and scheduler.
Stop `npm run dev` first because both use port 3000. Use
`npm run local:rebuild` to force a fresh build.

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
| session secret | dev fallback (warns) | `AUTH_SECRET` required; startup fails without it |
| code execution | local learning sandbox | code workbooks and free-form derive expressions disabled until an isolated runner is configured |

Run shared mode like this:

```bash
# app
MF_DEMO_MODE=false AUTH_SECRET=<32+ random chars> MF_SERVICE_TOKEN=<secret> bun run dev
# scheduler (same token)
MF_SERVICE_TOKEN=<same secret> bun run dev
```

**Never expose demo mode to more than one person.** Its anonymous-admin
fallback is a deliberate learning affordance, not a security model.
In shared mode, pipeline sources read values with viewer-level masking so a
pipeline output cannot declassify a marked column through an unmarked dataset.

## Architecture

```
CSV / JSON / REST / sample data ─▶ ingestion routes ─▶ SQLite dataset versions (JSON snapshots)
                                                          │
                    visual pipeline engine ◀──────────────┤──▶ SQL / Python / JS workbooks
                    (DAG, retries, triggers)              │
                                                          ▼
                              Ontology objects + actions (writeback)
                                                          │
                                    applications (maps) · dashboards · lineage · token API
mini-services/scheduler-service ──polls──▶ /api/schedules/due ─▶ execution jobs
job worker ──leases jobs──▶ pinned pipeline versions ─▶ pipeline runs
```

- **Next.js 16 (App Router) + TypeScript** — UI, REST API, execution engines
  (`src/lib/engine.ts`, `transform-engine.ts`, `dataset-service.ts`).
- **Prisma + SQLite** — metadata AND row snapshots (`prisma/schema.prisma`).
- **Scheduler mini-service (Bun)** — polls for due schedules every 30s
  (`mini-services/scheduler-service`).
- **Job worker (Bun)** — leases queued schedule and upstream events
  (`scripts/job-worker.ts`).
- **Gateway** — one exposed port; cross-service calls use `?XTransformPort=`.

## Quality gates

```bash
bun run lint        # ESLint (must stay clean)
bun run test        # focused security tests
bunx tsc --noEmit   # TypeScript gate — the build FAILS on type errors
```

Ad-hoc API smoke checks (demo mode, no cookies needed):

```bash
curl -s localhost:3000/api/health | head -c 300
curl -s localhost:3000/api/settings/overview | head -c 300
```

## Create Ontology links

Open **Ontology → Links → New link** after creating the object types. For **Order → Customer**, choose **many to one** and the `customer_id` foreign key on Order; it matches Customer's primary key. One to many uses a foreign key on the target type, one to one can use either side, and many to many uses a relationship dataset with columns for both primary keys. Links are resolved from the consumer-visible dataset versions and appear on object details in both directions. Editors can change or remove a link from its menu; deleting a link leaves the object types and datasets intact.

When updating an existing installation, run `bun run db:push` to add the optional foreign key side and relationship key columns before starting the app. Older one to many links retain their target-side foreign key mapping; older many to many links continue to read the relationship dataset's first two columns until edited.

## Deliberate learning-scale simplifications

These differ from real Foundry **on purpose** — they are teaching moments:

- Dataset versions are JSON snapshots with a 5,000-row limit. Larger writes
  fail with an error and do not discard trailing rows.
- Manual, scheduled, and upstream pipeline runs use SQLite job records and a
  separate worker. A unique output job ID prevents a recovered worker from
  committing a second output version. Downstream cascades, replay, and retries
  still execute synchronously. A crash immediately after the output commit can
  leave its manifest or downstream notifications incomplete. The worker must
  be deployed as an additional process; packaged startup scripts do not yet
  launch it.
- Branches support isolated row commits and copy the branch head into main at
  merge. Foundry's dataset branches do not merge; pipeline-logic branches are
  a separate concept.
- Gated datasets keep drafts out of consumer reads until the current rules
  pass and an admin approves the exact draft. Workbooks and pipelines consume
  the published pointer.
- User code runs in-process: SQL against the same SQLite file, JS via
  `node:vm`, Python as a `python3 -I -B` child (`python` on Windows, or set
  `MF_PYTHON_BIN`) with a **scrubbed environment**
  and 5s timeout. `node:vm` is NOT a security boundary — don't run untrusted
  users' code in a shared deployment. Shared mode blocks these operations
  while an isolated runner is being built.
- REST connectors enforce SSRF egress controls (public http(s) targets only,
  all DNS-resolved addresses checked, pinned destination sockets, and at most
  three re-validated redirects).
- Applications render up to 200 objects per map layer/table page (the objects
  API page cap). Maps use MapLibre GL with OpenStreetMap raster tiles (needs
  internet at view time); objects without latitude/longitude columns are placed
  through a built-in offline city/country centroid table with deterministic
  jitter — coarse by design, no external geocoder is ever called.

## Roadmap (delivery order)

0. **Foundation** ✅ — explicit demo/shared modes, service-token scheduler,
   consistent masking on dashboards, egress guard, TS gate, this README.
1. **Reproducible builds** — pipeline and workbook manifests, version-level lineage, replay.
2. **Trust workflow** — quality evaluation and exact-draft approval before publication.
3. **Guided curriculum** — learner-attributed action evidence and checkpoints.
4. **Collaboration & UI** — isolated branch commits and merge conflict detection; builder polish remains.
5. **Durable execution, isolated code, scale** — open architectural packages. See [gap closure plan](docs/gap-closure-plan.md).
