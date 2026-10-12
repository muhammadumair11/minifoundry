-- compute schema (search_path = compute for this service)
-- Ports Prisma models: Transform, TransformRun (M4 code workbooks).
--
-- JSON storage: inputs_json / logs_json / manifest_json are JSONB. None of
-- them carry insertion-order-sensitive payloads on the wire: logs and the
-- manifest are ALWAYS re-serialized through typed structs (LogEntry /
-- TransformManifest) with a fixed field order, and inputs_json is an array
-- (JSONB preserves array order).

CREATE TABLE transforms (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL UNIQUE,
    description         TEXT,
    -- sql | javascript | python
    language            TEXT NOT NULL DEFAULT 'sql',
    source_code         TEXT NOT NULL,
    -- JSON: string[] — input dataset ids, in order
    inputs_json         JSONB NOT NULL DEFAULT '[]',
    -- result rows are written as a NEW version of the dataset with this name
    -- (created if missing) via the catalog internal API
    output_dataset_name TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE transform_runs (
    id                    TEXT PRIMARY KEY,
    transform_id          TEXT NOT NULL REFERENCES transforms(id) ON DELETE CASCADE,
    -- running | success | failed
    status                TEXT NOT NULL DEFAULT 'running',
    -- JSON: [{ ts, level: "info"|"warn"|"error"|"success", msg }]
    logs_json             JSONB NOT NULL DEFAULT '[]',
    duration_ms           INTEGER,
    row_count             INTEGER,
    output_dataset_id     TEXT,
    output_version_number INTEGER,
    error                 TEXT,
    -- Immutable code and input-version snapshot used for provenance and replay
    manifest_json         JSONB,
    replay_of_run_id      TEXT,
    started_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at           TIMESTAMPTZ
);
-- Prisma @@index([transformId, startedAt])
CREATE INDEX transform_runs_transform_id_started_at_idx
    ON transform_runs (transform_id, started_at);
