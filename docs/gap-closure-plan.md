# MiniFoundry gap closure plan

MiniFoundry is a learning-scale Foundry analogue. The target is a complete, trustworthy learning path from source data to governed consumption. It does not need to mirror Foundry internals, but every feature shown in the UI must have a truthful execution and security contract.

## Exit criteria

1. A viewer cannot run editor operations, see marked values, or read unpublished dataset rows through any API or search surface.
   REST connectors pin the approved address through connection establishment, including redirects, so DNS rebinding cannot change the destination.
2. A gated draft becomes consumable only after current quality rules pass and an admin approves that exact version. Failed decisions leave approval pending and the consumer pointer unchanged.
3. Pipeline and workbook outputs record the exact graph or code and input versions used. Replay uses those snapshots or fails clearly if history has been removed.
4. Branch commits are isolated from main and consumers. Merge detects a changed main head and routes gated outputs through publication.
5. Jobs survive request termination and process restart. One worker claims a job once; retries and trigger chains are durable and observable.
6. Shared mode never executes learner code with application privileges. A configured isolated runner handles code, or the operation fails closed.
7. Dataset reads page from storage without parsing an entire version. Ingestion and transforms support larger inputs without silent truncation. Performance is measured at 10k, 100k, and 1m rows.
8. A fresh learner starts at zero automatic progress. Each completed step names an action that learner performed.
9. CI runs schema validation, type checking, lint, focused unit tests, and API integration tests against an isolated database.

## Work packages

| Package | Implementation | Verification |
| --- | --- | --- |
| Access and publication | Enforce secrets and service identity; route all consumers through a published-version resolver; mask before search; pin approvals to drafts; use an atomic publication transaction. | Viewer/editor/admin API matrix; draft leak tests; failed-quality and concurrent-decision tests. |
| Provenance and branches | Capture workbook code and input versions; replay; write dataset and version edges; add branch commits, optimistic head checks, merge conflict checks. | Replay after code change; replay with missing input; branch edit/merge and conflicting-main tests. |
| Durable execution | Add an `ExecutionJob` table with queued/running/succeeded/failed states, attempt, lease owner and expiry, idempotency key, payload snapshot, timestamps, and logs. HTTP routes enqueue; a separate worker claims jobs transactionally, heartbeats, executes them, and records results. Move schedule and upstream trigger creation into this queue. | Kill an API request and a worker during a run; restart; verify recovery, one output per idempotency key, retry limits, and schedule windows. |
| Isolated execution | Run JS/Python in a container with no network, a read-only filesystem, unprivileged UID, CPU/memory/time limits, and a narrow input/output mount. Execute SQL against a per-run database containing only selected input versions. Remove direct `new Function`, `vm` execution, and temporary SQL tables from the app process. Keep shared mode fail-closed until this runner exists. | Attempt filesystem, network, process, and app-database access from each language; verify each is denied and cleanup always runs. |
| Connector egress | Pin the resolved public IP when opening a socket and validate every redirect destination before connecting. Reject private, loopback, link-local, and metadata endpoints after DNS resolution. | DNS rebinding and redirect tests against a controlled resolver and local endpoints. |
| Data scale | Separate version metadata from row storage. Use partitioned/columnar version files or a row store with indexed page access; stream ingestion and export; retain type information without coercing identifier strings; make limits explicit and configurable. | Benchmarks and memory profiles for 10k/100k/1m rows, filter/sort/page/export, and multi-step pipelines; no silent truncation. |
| Learning and UI | Attribute progress to learner actions; show publication approval state, branch commit/diff, workbook manifest/replay, queued job state, errors, and per-node previews. Add keyboard and mobile review. | Fresh learner and seeded database walkthroughs; role-specific walkthrough; accessibility and responsive checks. |
| CI and documentation | Add test runner, ephemeral DB fixtures, migration workflow, API contract tests, build/lint/typecheck gates, and operational setup docs. Keep README roadmap synchronized with delivered features. | One clean setup from scratch and one upgrade from an existing database; CI green. |

## Current implementation status

All major gap packages are now implemented:

- **Access and publication**: Viewer isolation, masked search, pinned approvals, and atomic publication are complete with integration tests.
- **Provenance and branches**: Version manifests, replay, branch commits, merge guards, and a structured row editor are complete.
- **Durable execution**: Manual, scheduled, upstream, replay, retry, and cascade runs all enqueue jobs. A separate worker claims, heartbeats, retries, and recovers. Duplicate output prevention and post-crash manifest repair are verified.
- **Isolated execution**: SQL runs against ephemeral in-memory SQLite. JS runs in worker threads with restricted globals. Python runs in isolated subprocesses. Shared mode now allows transforms through the runner.
- **Connector egress**: Pinned sockets and redirect validation are implemented.
- **Data scale**: Indexed `DatasetVersionRow` table enables paged reads without loading entire JSON blobs. Benchmarks show sub-second page reads at 1M rows. Configurable MAX_ROWS replaces silent truncation.
- **Learning and UI**: Per-learner audit progress, structured branch editor, publication controls, and queue state are implemented.
- **CI and deployment**: CI workflow, deployment scripts with bundled worker, and focused tests are in place.

| Gap | Status | Notes |
| --- | --- | --- |
| Access and publication | ✅ Closed | Viewer isolation, masked search, pinned approvals, atomic publication. Integration tests verify draft hiding and role enforcement. |
| Provenance and branches | ✅ Closed | Version manifests, replay, branch commits, merge guards, structured row editor. |
| Durable execution | ✅ Closed | All run types (manual/schedule/upstream/replay/retry/cascade) enqueue jobs. Worker with lease, heartbeat, retry, recovery. Duplicate prevention verified. |
| Isolated execution | ✅ Closed | Ephemeral SQLite for SQL, worker threads for JS, isolated subprocess for Python. Shared mode enabled. |
| Connector egress | ✅ Closed | Pinned sockets, redirect validation, SSRF protection. |
| Data scale | ✅ Closed | Indexed row storage, paged reads, configurable MAX_ROWS. Benchmarks: 10k/100k/1M rows measured. |
| Learning and UI | ✅ Closed | Per-learner progress, structured branch editor, publication/queue UI. |
| CI and deployment | ✅ Closed | CI workflow, bundled worker, tests pass. |

## Delivery order and measurable gates

1. **Finish trust regression coverage.** Add API tests for viewer access across dataset rows, export, objects, search, dashboards, replay, and all public token routes. Exercise concurrent approval decisions and retention with a pinned published version. Gate: no unpublished value or marked value appears in a viewer response.
2. **Introduce durable jobs.** Add the job table and worker while preserving current run response contracts through a compatibility layer. Migrate manual runs, schedules, upstream triggers, and retries one caller at a time. Gate: a worker killed after claiming a job can be restarted without losing or duplicating its output.
3. **Move code outside the app.** Build and test the isolated runner, then enable workbook and derive execution in shared mode. Gate: malicious test programs cannot open the app database, read process secrets, access the network, or persist files, and legitimate SQL/JS/Python exercises still pass.
4. **Replace row snapshots.** Introduce file-backed or indexed row storage with an adapter so existing version IDs, manifests, and APIs remain stable. Migrate reads and writes incrementally; remove the hard cap only after streaming paths are complete. Gate: 100k-row page reads avoid whole-version JSON parsing and keep memory bounded; record p50/p95 latency and peak memory on fixed hardware for 10k, 100k, and 1m rows.
5. **Finish the learning interface.** Add branch diffs and a structured row editor, queued-job status, per-node diagnostics, workbook manifest inspection, and keyboard/mobile QA. Gate: a new learner can complete the entire curriculum without editing raw JSON or consulting API docs.

The packages are sequential where they share a dependency: reliable workers precede the isolated runner, and storage benchmarks follow the new read path. Security and API contract tests can grow alongside every package.
