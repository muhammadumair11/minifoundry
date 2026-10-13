# MiniFoundry

A learning-scale data platform inspired by Palantir Foundry. Ingest data, build versioned datasets, orchestrate visual pipelines, model an ontology, and turn data into dashboards and applications.

MiniFoundry runs as a React application backed by Rust microservices, PostgreSQL and NATS JetStream, with Docker Compose for local setup.

## What you can explore

- CSV, JSON and REST ingestion; dataset previews, branches, versions and lineage.
- Visual pipelines with background jobs, schedules, upstream triggers and replay.
- SQL, JavaScript and Python workbooks with input bindings, execution logs and output previews in demo mode.
- Ontology object types, links and actions; dashboards and Workshop-style applications.
- Quality rules, publication approvals, markings, masking and audit trails.
- Organizations with Owner, Admin, Access Manager, Auditor, Editor and Viewer roles.
- A token-authenticated read API with an interactive explorer and usage metrics.

## Run locally

Install Docker with Compose. Copy the example environment file, then build and seed the demo:

```bash
cp .env.example .env
docker compose up -d --build
docker compose --profile tools run --rm seed all
```

In PowerShell, use `Copy-Item .env.example .env` for the first command.

Open [localhost:3000](http://localhost:3000). The seeded demo accounts are `demo-admin@example.invalid`, `demo-editor@example.invalid` and `demo-viewer@example.invalid`, all with password `<redacted>`. These are intentional local demo credentials.

Stop the stack with `docker compose down`. Data persists in Docker volumes.

## Runtime modes

The example environment enables **demo mode** (`MF_DEMO_MODE=true`): anonymous requests can explore the sandbox, and the role simulator is available.

**Shared mode** (`MF_DEMO_MODE=false`) requires sign-in and enforces active organization membership. Signup creates an organization; its Owner can invite users into the other roles. Domain resources, background jobs, API tokens and audit events carry organization scope. Workbook execution is disabled in shared mode; users with edit permission can still save code and input bindings. Configure signing and service secrets in `.env` for your deployment.

See the [role guide](docs/organization-roles.md) and [organization isolation design](docs/organization-isolation.md).

## Architecture

The frontend proxies `/api` to the gateway. The gateway authenticates requests and routes them to services, which own separate PostgreSQL schemas and exchange events through NATS.

| Service | Responsibility |
| --- | --- |
| Frontend | React 19, TypeScript, Vite, TanStack Router/Query/Table; served on port 3000 |
| Gateway | Authentication, request identity, routing and edge controls; port 8080 |
| Auth | Accounts, organizations, invitations, sessions and API tokens |
| Catalog | Projects, datasets, ingestion, branches, quality and lineage |
| Orchestration | Pipeline graphs, execution jobs, schedules and upstream triggers |
| Compute | SQL, JavaScript and Python workbooks |
| Ontology | Object types, links, actions, dashboards and applications |
| Governance | Approvals, markings, ACLs, audit, notifications and search |
| Public API | Token-authenticated `foundry/v1` read endpoints |

The [backend guide](backend/README.md) covers shared crates and service conventions.

## Development and testing

For frontend development, install [Bun](https://bun.sh), then run:

```bash
cd frontend
bun install
bun run dev
```

The Vite server proxies API requests to the gateway on port 8080. Stop the Compose frontend first if it already occupies port 3000.

For backend development, use Cargo or the Docker-backed PowerShell wrapper in `backend/`:

```powershell
cd backend
.\cargo.ps1 check --workspace
.\cargo.ps1 test --workspace
```

`docker-compose.dev.yml` exposes PostgreSQL and NATS for development; `scripts/dev-stack.ps1` starts selected backend services. See [testing](docs/testing.md) for unit tests, contract checks and the organization integration suite. GitHub Actions runs backend formatting, lint and tests, the frontend build, and a full-stack demo smoke gate on `main`.

MiniFoundry is an independent educational project, with no affiliation with Palantir.
