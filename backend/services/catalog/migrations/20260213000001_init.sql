-- catalog schema (search_path = catalog for this service)
-- Ports Prisma models: Project, Connector, Ingestion, Dataset, DatasetVersion,
-- DatasetVersionRow, DatasetBranch, QualityRule, QualityResult, DatasetComment,
-- DatasetWatcher, LineageEdge, VersionLineageEdge.
--
-- JSON storage rules:
--   * row payloads (data_json / row_data) and connector config stay TEXT —
--     PostgreSQL JSONB reorders object keys, and the legacy contracts require
--     insertion-ordered row objects (serde_json preserve_order round-trip).
--   * order-insensitive JSON (tags, schema_json, quality_summary_json) is JSONB.

CREATE TABLE projects (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE connectors (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    -- csv_upload | json_upload | rest_url | sample
    type       TEXT NOT NULL,
    -- JSON text: { url?, format?, dataPath?, sampleKey?, description? }
    config     TEXT NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ingestions (
    id            TEXT PRIMARY KEY,
    -- Prisma optional relation → SET NULL when the connector is deleted
    connector_id  TEXT REFERENCES connectors(id) ON DELETE SET NULL,
    -- loose reference (legacy: plain column, no FK)
    dataset_id    TEXT,
    -- running | success | failed
    status        TEXT NOT NULL DEFAULT 'running',
    message       TEXT,
    rows_ingested INTEGER NOT NULL DEFAULT 0,
    started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at   TIMESTAMPTZ
);
CREATE INDEX ingestions_connector_id_started_at_idx ON ingestions (connector_id, started_at);

CREATE TABLE datasets (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    description         TEXT,
    project_id          TEXT REFERENCES projects(id) ON DELETE SET NULL,
    -- loose reference (legacy: plain column, no FK)
    source_connector_id TEXT,
    -- JSON string[]
    tags                JSONB NOT NULL DEFAULT '[]',
    -- max versions retained; 0 = unlimited
    keep_last_n         INTEGER NOT NULL DEFAULT 20,
    -- P2 trust workflow publication gate
    quality_gate        BOOLEAN NOT NULL DEFAULT FALSE,
    -- latest version cleared for consumption (NULL = fall back to head)
    published_version   INTEGER,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE dataset_versions (
    id                   TEXT PRIMARY KEY,
    dataset_id           TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
    version_number       INTEGER NOT NULL,
    -- JSON: [{ name, type }]
    schema_json          JSONB NOT NULL DEFAULT '[]',
    row_count            INTEGER NOT NULL DEFAULT 0,
    -- JSON text: array of insertion-ordered row objects
    data_json            TEXT NOT NULL DEFAULT '[]',
    -- ingestion id | pipeline run id | "transform:<runId>" | "branch-merge:<b>"
    -- | "action:<apiName>" | "seed"
    created_by           TEXT,
    -- unique output identity for a queued pipeline job (idempotent writes)
    output_job_id        TEXT UNIQUE,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- "main" = published lineage; else the branch name
    branch               TEXT NOT NULL DEFAULT 'main',
    parent_version       INTEGER,
    -- draft | published
    lifecycle            TEXT NOT NULL DEFAULT 'published',
    -- not_evaluated | passed | warned | failed
    quality_state        TEXT,
    -- JSON: { passed, failed, errorFailures, warnFailures, evaluatedAt }
    quality_summary_json JSONB,
    UNIQUE (dataset_id, version_number)
);

CREATE TABLE dataset_version_rows (
    id             TEXT PRIMARY KEY,
    dataset_id     TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    row_index      INTEGER NOT NULL,
    -- JSON text: single insertion-ordered row object
    row_data       TEXT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (dataset_id, version_number, row_index)
);

CREATE TABLE dataset_branches (
    id           TEXT PRIMARY KEY,
    dataset_id   TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    base_version INTEGER NOT NULL,
    head_version INTEGER NOT NULL,
    merged_at    TIMESTAMPTZ,
    merged_into  INTEGER,
    description  TEXT,
    created_by   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (dataset_id, name)
);

CREATE TABLE quality_rules (
    id          TEXT PRIMARY KEY,
    dataset_id  TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    -- not_null | unique | range | allowed_values | regex | freshness | row_count_min
    kind        TEXT NOT NULL,
    column_name TEXT,
    -- JSON text (key order is contract-visible: the quality fixture pins
    -- {"min":0,"max":100} — JSONB would reorder to max,min)
    config_json TEXT NOT NULL DEFAULT '{}',
    -- warn | error
    severity    TEXT NOT NULL DEFAULT 'warn',
    enabled     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE quality_results (
    id             TEXT PRIMARY KEY,
    rule_id        TEXT NOT NULL REFERENCES quality_rules(id) ON DELETE CASCADE,
    dataset_id     TEXT NOT NULL,
    version_number INTEGER NOT NULL,
    passed         BOOLEAN NOT NULL,
    actual         TEXT,
    message        TEXT,
    -- manual | post_run | auto
    trigger        TEXT NOT NULL DEFAULT 'manual',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX quality_results_rule_id_created_at_idx ON quality_results (rule_id, created_at);
CREATE INDEX quality_results_dataset_id_version_number_idx ON quality_results (dataset_id, version_number);

CREATE TABLE dataset_comments (
    id             TEXT PRIMARY KEY,
    dataset_id     TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
    version_number INTEGER,
    author_key     TEXT NOT NULL,
    author_label   TEXT NOT NULL,
    author_role    TEXT NOT NULL,
    body           TEXT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX dataset_comments_dataset_id_created_at_idx ON dataset_comments (dataset_id, created_at);

CREATE TABLE dataset_watchers (
    id         TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
    user_email TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (dataset_id, user_email)
);
CREATE INDEX dataset_watchers_user_email_idx ON dataset_watchers (user_email);

-- Dataset-level lineage (no FKs — datasets referenced loosely, like legacy).
CREATE TABLE lineage_edges (
    id              TEXT PRIMARY KEY,
    from_dataset_id TEXT NOT NULL,
    to_dataset_id   TEXT NOT NULL,
    pipeline_id     TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- NULL pipeline_ids stay distinct (PG default) — matches SQLite legacy.
    UNIQUE (from_dataset_id, to_dataset_id, pipeline_id)
);

-- Version-level lineage (trust workflow).
CREATE TABLE version_lineage_edges (
    id                 TEXT PRIMARY KEY,
    run_id             TEXT,
    pipeline_id        TEXT,
    transform_run_id   TEXT,
    transform_id       TEXT,
    from_dataset_id    TEXT NOT NULL,
    from_version_number INTEGER NOT NULL,
    to_dataset_id      TEXT NOT NULL,
    to_version_number  INTEGER NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX version_lineage_edges_to_idx ON version_lineage_edges (to_dataset_id, to_version_number);
CREATE INDEX version_lineage_edges_from_idx ON version_lineage_edges (from_dataset_id, from_version_number);
