-- orchestration schema (search_path = orchestration for this service)
-- Ports Prisma models: Pipeline, PipelineVersion, PipelineRun, ExecutionJob, Schedule.
-- JSON columns are JSONB (legacy stored JSON strings in SQLite); ids are UUIDv7 text.

CREATE TABLE pipelines (
    id                   TEXT PRIMARY KEY,
    name                 TEXT NOT NULL,
    description          TEXT,
    -- { nodes: FoundryNode[], edges: FoundryEdge[] }
    graph_json           JSONB NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
    -- R14: "manual" | "upstream"
    trigger_mode         TEXT NOT NULL DEFAULT 'manual',
    -- JSON string[] of dataset ids watched for new versions
    upstream_dataset_ids JSONB NOT NULL DEFAULT '[]',
    -- R14: automatic retry policy for failed runs
    max_retries          INTEGER NOT NULL DEFAULT 0,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- M3.1: immutable graph snapshots; every graph save appends one version.
CREATE TABLE pipeline_versions (
    id             TEXT PRIMARY KEY,
    pipeline_id    TEXT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    graph_json     JSONB NOT NULL,
    node_count     INTEGER NOT NULL,
    note           TEXT,
    created_by     TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (pipeline_id, version_number)
);
CREATE INDEX pipeline_versions_pipeline_id_idx ON pipeline_versions (pipeline_id);

CREATE TABLE pipeline_runs (
    id                   TEXT PRIMARY KEY,
    pipeline_id          TEXT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
    -- running | success | failed
    status               TEXT NOT NULL DEFAULT 'running',
    -- [{ ts, level: info|warn|error|success, msg }]
    logs_json            JSONB NOT NULL DEFAULT '[]',
    -- M3.1: pipeline version this run executed (null for pre-versioning runs)
    version_number       INTEGER,
    -- R14: manual | schedule | upstream | retry | replay | cascade
    "trigger"            TEXT NOT NULL DEFAULT 'manual',
    attempt              INTEGER NOT NULL DEFAULT 1,
    -- Phase 1 RunManifest: { graphVersion, inputs, outputs, nodes }
    manifest_json        JSONB,
    duration_ms          INTEGER,
    failure_cause        TEXT,
    output_dataset_id    TEXT,
    output_version_number INTEGER,
    replayed_from_run_id TEXT,
    started_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at          TIMESTAMPTZ
);
CREATE INDEX pipeline_runs_pipeline_started_idx ON pipeline_runs (pipeline_id, started_at);
CREATE INDEX pipeline_runs_status_started_idx ON pipeline_runs (status, started_at);

-- Durable pipeline requests. A worker leases a row and records each attempt.
-- The unique event key dedupes repeated scheduler polls / version events.
-- NOTE: deliberately NO foreign key to pipelines — legacy kept job history for
-- deleted pipelines (the jobs list falls back to the raw pipelineId as name).
CREATE TABLE execution_jobs (
    id             TEXT PRIMARY KEY,
    pipeline_id    TEXT NOT NULL,
    version_number INTEGER NOT NULL,
    "trigger"      TEXT NOT NULL,
    schedule_id    TEXT,
    event_key      TEXT NOT NULL UNIQUE,
    -- { inputOverrides?, replayOfRunId?, parentRunId?, cascadeDepth? }
    payload_json   JSONB NOT NULL DEFAULT '{}',
    -- queued | running | succeeded | failed
    status         TEXT NOT NULL DEFAULT 'queued',
    attempt        INTEGER NOT NULL DEFAULT 0,
    max_attempts   INTEGER NOT NULL DEFAULT 1,
    available_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    lease_owner    TEXT,
    lease_until    TIMESTAMPTZ,
    last_run_id    TEXT,
    error          TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at    TIMESTAMPTZ
);
CREATE INDEX execution_jobs_status_available_idx ON execution_jobs (status, available_at);
CREATE INDEX execution_jobs_pipeline_status_idx ON execution_jobs (pipeline_id, status);

-- M5: interval schedules (the in-service scheduler task fires due windows).
CREATE TABLE schedules (
    id               TEXT PRIMARY KEY,
    pipeline_id      TEXT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    enabled          BOOLEAN NOT NULL DEFAULT TRUE,
    interval_minutes INTEGER NOT NULL DEFAULT 60,
    last_run_at      TIMESTAMPTZ,
    next_run_at      TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX schedules_due_idx ON schedules (enabled, next_run_at);
