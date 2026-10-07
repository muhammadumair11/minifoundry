-- governance schema (search_path = governance for this service)
-- Ports Prisma models: Marking, ColumnMarking, ApprovalRequest, AuditEntry,
-- ResourceAcl, Notification, CurriculumProgress.
-- NOTE: column_markings.dataset_id has NO foreign key — datasets live in the
-- catalog schema now (cross-schema FKs are not allowed between service roles).
-- Orphan cleanup rides the settings/reset fan-out and marking deletion.

CREATE TABLE markings (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    description TEXT,
    -- rose | amber | teal | zinc
    color       TEXT NOT NULL DEFAULT 'rose',
    -- minimum role that can see VALUES in marked columns: viewer | editor | admin
    min_role    TEXT NOT NULL DEFAULT 'editor',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE column_markings (
    id          TEXT PRIMARY KEY,
    dataset_id  TEXT NOT NULL,
    column_name TEXT NOT NULL,
    marking_id  TEXT NOT NULL REFERENCES markings(id) ON DELETE CASCADE,
    UNIQUE (dataset_id, column_name)
);
CREATE INDEX column_markings_marking_id_idx ON column_markings (marking_id);

CREATE TABLE approval_requests (
    id             TEXT PRIMARY KEY,
    -- publish_dataset | publish_pipeline
    kind           TEXT NOT NULL,
    target_id      TEXT NOT NULL,
    -- dataset draft pinned when the request was created (null for pipelines
    -- and for legacy/seed requests without a pin)
    version_number INTEGER,
    target_name    TEXT NOT NULL,
    requested_by   TEXT NOT NULL,
    note           TEXT,
    -- pending | approved | rejected
    status         TEXT NOT NULL DEFAULT 'pending',
    decided_by     TEXT,
    decided_at     TIMESTAMPTZ,
    decision_note  TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX approval_requests_status_idx ON approval_requests (status);

CREATE TABLE audit_entries (
    id            TEXT PRIMARY KEY,
    -- viewer | editor | admin | system
    actor_role    TEXT NOT NULL,
    -- user email when the actor was a real (session) user; null for
    -- simulator/machine actors
    actor_email   TEXT,
    action        TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id   TEXT,
    resource_name TEXT,
    detail        TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_entries_created_at_idx ON audit_entries (created_at);
CREATE INDEX audit_entries_resource_type_idx ON audit_entries (resource_type);
CREATE INDEX audit_entries_actor_email_idx ON audit_entries (actor_email);

CREATE TABLE resource_acls (
    id            TEXT PRIMARY KEY,
    -- dataset | pipeline | dashboard
    resource_type TEXT NOT NULL,
    resource_id   TEXT NOT NULL,
    user_email    TEXT NOT NULL,
    -- viewer | editor | owner — ELEVATES a user on this resource beyond their
    -- global role
    level         TEXT NOT NULL DEFAULT 'editor',
    granted_by    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (resource_type, resource_id, user_email)
);
CREATE INDEX resource_acls_resource_id_idx ON resource_acls (resource_id);

CREATE TABLE notifications (
    id            TEXT PRIMARY KEY,
    -- null = broadcast to all users
    user_email    TEXT,
    -- run_failed | quality_failed | approval_requested | pipeline_triggered | system
    type          TEXT NOT NULL,
    title         TEXT NOT NULL,
    body          TEXT,
    resource_type TEXT,
    resource_id   TEXT,
    -- in-app deep link (e.g. /pipelines/[id])
    href          TEXT,
    read_at       TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_email_idx ON notifications (user_email);
CREATE INDEX notifications_created_at_idx ON notifications (created_at);

CREATE TABLE curriculum_progress (
    id           TEXT PRIMARY KEY,
    actor_key    TEXT NOT NULL,
    step_id      TEXT NOT NULL,
    source       TEXT NOT NULL DEFAULT 'manual',
    completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (actor_key, step_id)
);
