# MiniFoundry — internal service-to-service contract

All `/internal/*` endpoints live on the Docker internal network and are
**never routable through the gateway**. Every internal call:

- carries `x-service-token: <MF_SERVICE_TOKEN>` (callee rejects without it);
- forwards the originating caller's `X-Mf-Actor-*` headers when the result
  depends on identity (masking, ACL);
- returns the same JSON shapes/errors as the public API (`{ error }` envelope);
- uses plain HTTP (reqwest via `mf_internal::ServiceClient`) — sync reads and
  writes; NATS is reserved for async events (see `mf-events`).

Service discovery env vars (compose DNS defaults):

| Service | Env var | Default |
|---|---|---|
| auth | `AUTH_INTERNAL_URL` | `http://auth:8081` |
| catalog | `CATALOG_INTERNAL_URL` | `http://catalog:8082` |
| orchestration | `ORCHESTRATION_INTERNAL_URL` | `http://orchestration:8083` |
| compute | `COMPUTE_INTERNAL_URL` | `http://compute:8084` |
| ontology | `ONTOLOGY_INTERNAL_URL` | `http://ontology:8085` |
| governance | `GOVERNANCE_INTERNAL_URL` | `http://governance:8086` |
| public-api | `PUBLIC_API_INTERNAL_URL` | `http://public-api:8087` |

## auth (implemented)

| Endpoint | Purpose |
|---|---|
| `POST /internal/auth/refresh` `{refreshToken}` | Rotate refresh token; returns `{accessToken, refreshToken?, user}`. Gateway single-flights concurrent refreshes. |
| `POST /internal/tokens/verify` `{secret}` | Resolve a public-API bearer secret → `{token:{id,name,prefix,requestCount}}` or 401 `invalid or missing API token`. Touches usage counters fire-and-forget. |
| `POST /internal/tokens/rate-limit` `{tokenId}` | Sliding-window decision → `{allowed,remaining,resetMs,retryAfterSeconds}`. |

## catalog (Phase 2)

| Endpoint | Purpose |
|---|---|
| `GET /internal/datasets` | All dataset summaries (list contract = public `GET /api/datasets`). |
| `GET /internal/datasets/{id}` | Dataset detail (meta + versions head info). |
| `GET /internal/datasets/by-name/{name}` | Lookup for compute output datasets (`ensureDatasetByName`). |
| `POST /internal/datasets` `{name, description?, tags?, projectId?}` | Create dataset → summary. |
| `GET /internal/datasets/{id}/versions/{n}` | Version meta `{schema, rowCount, ...}`; `n=head` resolves the consumer version (gate-aware). |
| `GET /internal/datasets/{id}/versions/{n}/rows?offset=&limit=&role=<r>` | Paged rows. `n=head` resolves the consumer version (gate-aware). **Masking is opt-in via the `role` query param**: absent → RAW rows; `role=viewer\|editor\|admin` → markings fetched from governance and applied at that role level (values below a marking's minRole become `"------"`). Parity map: orchestration engine passes `role=viewer` in SHARED mode and nothing in demo mode (legacy `engine.ts`: `isDemoMode() ? rawRows : applyMasking(..., 'viewer')`); compute passes nothing (legacy transform-engine never masked); ontology/public-api pass the caller's effective role / `viewer`. |
| `GET /internal/datasets/{id}/versions/{n}/rows/all?role=<r>` | Full rows, same `role` masking semantics as above. Response MUST include `versionNumber` (the resolved version — orchestration's run-manifest capture reads it) alongside `rows` (a bare array is tolerated by consumers but deprecated). A 404 / absent published version on `n=head` means "no rows" to consumers. |
| `POST /internal/datasets/{id}/versions` | Append a new version: `{rows?, schema?, createdBy, branch?, lifecycle?, outputJobId?, inputs?: [{datasetId, versionNumber}], runId?, pipelineId?, transformRunId?, transformId?, source?, cascadeParentRunId?, cascadeDepth?}` → `{datasetId, versionNumber, rowCount}`. Catalog centrally: infers schema when absent, enforces `outputJobId` uniqueness (on conflict return the existing version), writes row storage + version lineage edges, runs quality auto-evaluation, and emits `mf.dataset.version.created` (only when consumable) — copying `source`/`cascadeParentRunId`/`cascadeDepth` into the event when provided (orchestration's upstream-trigger consumer needs them for the legacy self-trigger guard + cascade propagation). THIS is the single write path for engine output, transform output, and ontology write-back. |
| `DELETE /internal/datasets/{id}/versions/{n}` | Remove one version's rows/storage (orchestration `DELETE /api/pipelines/{id}/runs/{runId}/output` cleanup, mode=version). Idempotent; 404 when absent. |
| `DELETE /internal/datasets/{id}` | Delete a dataset (same cleanup route, mode=dataset). Idempotent. |
| `POST /internal/datasets/{id}/publish-approved` `{versionNumber}` | Governance→catalog after an approval decision: flip lifecycle draft→published + emit the version event. Idempotent. |
| `GET /internal/lineage/dataset/{id}` | `{edges:[{fromDatasetId,toDatasetId,pipelineId?}]}` for impact analysis fan-out. |
| `GET /internal/health/datasets` | Freshness list for platform health: `[{id,name,rowCount,updatedAt,freshnessMinutes}]`. |
| `GET /internal/search?q=` | Dataset/project/connector matches (governance search fan-out). |
| `GET /internal/stats` | `{projects, datasets, datasetVersions, connectors, ingestions}` counts. |
| `GET /internal/curriculum-state` | Flags/counts the curriculum auto-verifier needs (datasets created, versions published, branches, quality rules, comments, watchers...). |
| `POST /internal/reset` | Truncate catalog tables (governance settings/reset). |

## orchestration (Phase 3)

| Endpoint | Purpose |
|---|---|
| `GET /internal/pipelines` | Pipeline list (public contract). |
| `GET /internal/pipelines/{id}` | Pipeline detail incl. current graph (public-api). |
| `GET /internal/runs?limit=&status=` | Recent runs (stats/health/curriculum). |
| `GET /internal/health/runs` | Run aggregates for `GET /api/health` (successRatePct, avgDurationMs, runs7d, failed7d, failingPipelines) — orchestration merges with catalog's `/internal/health/datasets` to serve the public route. |
| `GET /internal/search?q=` | Pipeline matches. |
| `GET /internal/stats` | `{pipelines, runs, runsSuccess, runsFailed, schedules, jobsQueued, jobsRunning}`. |
| `GET /internal/curriculum-state` | Flags (pipeline created, run succeeded, schedule exists, replay used...). |
| `POST /internal/reset` | Truncate orchestration tables. |

## compute (Phase 4)

| Endpoint | Purpose |
|---|---|
| `GET /internal/transforms` | Transform list. |
| `GET /internal/search?q=` | Transform/workbook matches. |
| `GET /internal/stats` | `{transforms, transformRuns}`. |
| `GET /internal/curriculum-state` | Flags (workbook run, sql/js/python used...). |
| `POST /internal/reset` | Truncate compute tables. |

## ontology (Phase 5)

| Endpoint | Purpose |
|---|---|
| `GET /internal/ontology` | Object types + links (public-api `/v1/ontology`). |
| `GET /internal/objects/{type}?q=&limit=` | Object rows (public-api + governance search). Masking via forwarded actor role. |
| `GET /internal/search?q=` | Object type / dashboard / application matches. |
| `GET /internal/stats` | `{objectTypes, linkTypes, actionTypes, dashboards, applications}`. |
| `GET /internal/curriculum-state` | Flags (object type created, action applied...). |
| `POST /internal/reset` | Truncate ontology tables. |

## governance (Phase 6)

| Endpoint | Purpose |
|---|---|
| `GET /internal/markings/dataset/{id}` | `[{columnName, markingName, minRole, color}]` — used by catalog rows endpoint for masking. |
| `GET /internal/acl/check?resourceType=&resourceId=&email=` | `{level: viewer\|editor\|owner\|null}` — per-resource elevation. |
| `POST /internal/approvals` `{kind, targetId, versionNumber?, targetName, requestedBy, note?}` | Create approval request → `{id, status:'pending'}` (catalog publish gate). |
| `GET /internal/stats` | `{markings, approvals, approvalsPending, auditEntries, notifications}`. |
| `POST /internal/reset` | Truncate governance tables (except users — auth owns those; reset flow calls every service). |

## Events (NATS JetStream — `mf-events` crate is the source of truth)

| Subject | Producer → Consumer | Payload |
|---|---|---|
| `mf.dataset.version.created` | catalog → orchestration | `VersionCreatedEvent` (upstream triggers; emitted only for consumable versions) |
| `mf.notify` | any → governance | `NotifyEvent` (persisted as Notification rows) |
| `mf.audit` | any → governance | `AuditEvent` (persisted as AuditEntry rows) |
| `mf.approval.decided` | governance → catalog | `ApprovalDecidedEvent` (retry/fallback for the sync publish-approved call) |
| `mf.markings.changed` | governance → catalog | `MarkingsChangedEvent` |
| `mf.apiusage` | public-api → auth | `ApiUsageEvent` (persisted as ApiRequestLog rows) |
| `mf.jobs.pipeline.run` | orchestration → orchestration workers | `JobWake { jobId }` (Postgres lease remains the correctness authority) |

Consumers are durable with explicit acks, `max_deliver=5`, DLQ `mf.dlq.>`.

## Cross-cutting rules

1. **Masking lives in catalog's internal rows endpoints, opt-in via `role`
   query param** (see above for the per-consumer parity map). Public row
   egress (catalog `/api/datasets/{id}/rows|diff|export`) always masks at the
   CALLER's role. Ontology object/dashboard/application data masks at the
   caller's role via the `role` param. Public-api always uses `role=viewer`.
2. **Version writes go through exactly one door**: catalog's
   `POST /internal/datasets/{id}/versions` (idempotent via `outputJobId`).
3. **Audit/notify are fire-and-forget events** — a broken consumer can never
   break a request (legacy semantics).
4. **Reset** is admin-only, orchestrated by governance calling every
   service's `/internal/reset` (auth users are NOT reset — parity with
   legacy settings/reset which preserved users).
