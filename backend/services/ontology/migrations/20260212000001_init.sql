-- ontology schema (search_path = ontology for this service)
-- Ports Prisma models: ObjectType, Property, LinkType, ActionType, ActionLog,
-- ObjectView, Dashboard, Application. Dataset rows live in the catalog
-- service — object types reference datasets by id only (no FK across schemas).

CREATE TABLE object_types (
    id                TEXT PRIMARY KEY,
    -- url-safe unique name, e.g. "shipment"
    api_name          TEXT NOT NULL UNIQUE,
    display_name      TEXT NOT NULL,
    description       TEXT,
    -- backing dataset (catalog schema; rows = object instances)
    source_dataset_id TEXT,
    -- property apiName used as primary key (column in backing dataset)
    primary_key       TEXT,
    -- lucide icon name + accent key (emerald|amber|rose|teal|orange|zinc)
    icon              TEXT NOT NULL DEFAULT 'box',
    color             TEXT NOT NULL DEFAULT 'emerald',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE properties (
    id             TEXT PRIMARY KEY,
    object_type_id TEXT NOT NULL REFERENCES object_types(id) ON DELETE CASCADE,
    api_name       TEXT NOT NULL,
    display_name   TEXT NOT NULL,
    -- string | number | boolean (mirrors dataset schema types)
    data_type      TEXT NOT NULL DEFAULT 'string',
    is_title       BOOLEAN NOT NULL DEFAULT FALSE,
    hide_in_table  BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE (object_type_id, api_name)
);
CREATE INDEX properties_object_type_id_idx ON properties (object_type_id);

CREATE TABLE link_types (
    id              TEXT PRIMARY KEY,
    api_name        TEXT NOT NULL,
    display_name    TEXT NOT NULL,
    from_type_id    TEXT NOT NULL REFERENCES object_types(id) ON DELETE CASCADE,
    to_type_id      TEXT NOT NULL REFERENCES object_types(id) ON DELETE CASCADE,
    -- one-to-one | one-to-many | many-to-one | many-to-many
    cardinality     TEXT NOT NULL DEFAULT 'one-to-many',
    -- foreign key column on the side indicated by fk_side ('from'|'to';
    -- NULL = legacy link, side derived from cardinality)
    fk_property     TEXT,
    fk_side         TEXT,
    -- many-to-many: dataset (catalog id) with two columns holding both PKs
    link_dataset_id TEXT,
    from_key_column TEXT,
    to_key_column   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (from_type_id, api_name)
);
CREATE INDEX link_types_to_type_id_idx ON link_types (to_type_id);

CREATE TABLE action_types (
    id                TEXT PRIMARY KEY,
    api_name          TEXT NOT NULL UNIQUE,
    display_name      TEXT NOT NULL,
    description       TEXT,
    object_type_id    TEXT NOT NULL REFERENCES object_types(id) ON DELETE CASCADE,
    -- create | update | delete
    operation         TEXT NOT NULL DEFAULT 'update',
    -- [{ apiName, displayName?, dataType, required?, mapsTo, isPk?, defaultValue?, oneOf? }]
    parameters_json   JSONB NOT NULL DEFAULT '[]',
    enabled           BOOLEAN NOT NULL DEFAULT TRUE,
    -- R14.6 write-back target (catalog dataset id): when set, applying the
    -- action appends/upserts a row into the TARGET dataset instead of
    -- mutating object rows. write_mode: append | upsert (matched on
    -- key_property).
    target_dataset_id TEXT,
    write_mode        TEXT,
    key_property      TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX action_types_object_type_id_idx ON action_types (object_type_id);

CREATE TABLE action_logs (
    id             TEXT PRIMARY KEY,
    action_type_id TEXT NOT NULL REFERENCES action_types(id) ON DELETE CASCADE,
    params_json    JSONB NOT NULL DEFAULT '{}',
    -- success | failed
    result         TEXT NOT NULL,
    message        TEXT,
    object_pk      TEXT,
    version_number INTEGER,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX action_logs_action_type_id_idx ON action_logs (action_type_id);
CREATE INDEX action_logs_created_at_idx ON action_logs (created_at);

CREATE TABLE object_views (
    id             TEXT PRIMARY KEY,
    object_type_id TEXT NOT NULL REFERENCES object_types(id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    -- [{ property, op: eq|neq|contains|gt|lt|gte|lte|in, value }]
    filters_json   JSONB NOT NULL DEFAULT '[]',
    sort_by        TEXT,
    -- asc | desc
    sort_dir       TEXT NOT NULL DEFAULT 'asc',
    created_by     TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (object_type_id, name)
);

CREATE TABLE dashboards (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    description TEXT,
    -- DashboardWidget[]: { id, type: bar|line|pie|area|stat|table, title, ... }
    layout_json JSONB NOT NULL DEFAULT '[]',
    created_by  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE applications (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT,
    -- AppConfig: { pages, widgets: (map|objectTable|stat|actionButton|chart)[], filters }
    config_json JSONB NOT NULL DEFAULT '{}',
    created_by  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
