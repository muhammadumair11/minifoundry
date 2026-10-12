-- MiniFoundry — Postgres bootstrap (runs once on first volume init).
-- Topology: ONE instance, one schema per service. Each service owns its
-- schema and runs its own sqlx migrations at boot; no cross-schema grants,
-- so domain separation is enforced by the database itself.
--
-- Passwords below are LOCAL DEV defaults (compose). Real deployments must
-- override POSTGRES_PASSWORD and the role passwords via provisioning.

-- ─── roles (idempotent) ────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mf_auth') THEN
        CREATE ROLE mf_auth LOGIN PASSWORD '<redacted>';
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mf_catalog') THEN
        CREATE ROLE mf_catalog LOGIN PASSWORD '<redacted>';
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mf_orchestration') THEN
        CREATE ROLE mf_orchestration LOGIN PASSWORD '<redacted>';
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mf_compute') THEN
        CREATE ROLE mf_compute LOGIN PASSWORD '<redacted>';
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mf_ontology') THEN
        CREATE ROLE mf_ontology LOGIN PASSWORD '<redacted>';
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mf_governance') THEN
        CREATE ROLE mf_governance LOGIN PASSWORD '<redacted>';
    END IF;
    -- mf-seed runs as the postgres superuser in compose; this role exists
    -- for deployments that want a non-superuser seeder granted per schema.
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mf_seed') THEN
        CREATE ROLE mf_seed LOGIN PASSWORD '<redacted>';
    END IF;
END
$$;

-- ─── schemas, owned by their service role ──────────────────────────────
CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION mf_auth;
CREATE SCHEMA IF NOT EXISTS catalog AUTHORIZATION mf_catalog;
CREATE SCHEMA IF NOT EXISTS orchestration AUTHORIZATION mf_orchestration;
CREATE SCHEMA IF NOT EXISTS compute AUTHORIZATION mf_compute;
CREATE SCHEMA IF NOT EXISTS ontology AUTHORIZATION mf_ontology;
CREATE SCHEMA IF NOT EXISTS governance AUTHORIZATION mf_governance;

-- ─── seeder access (tables are created later by service migrations) ────
GRANT USAGE ON SCHEMA auth TO mf_seed;
GRANT USAGE ON SCHEMA catalog TO mf_seed;
GRANT USAGE ON SCHEMA orchestration TO mf_seed;
GRANT USAGE ON SCHEMA compute TO mf_seed;
GRANT USAGE ON SCHEMA ontology TO mf_seed;
GRANT USAGE ON SCHEMA governance TO mf_seed;

-- Default privileges: tables created BY each service role are readable/
-- writable by the seeder. (ALTER DEFAULT PRIVILEGES FOR ROLE <owner>.)
ALTER DEFAULT PRIVILEGES FOR ROLE mf_auth IN SCHEMA auth
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mf_seed;
ALTER DEFAULT PRIVILEGES FOR ROLE mf_catalog IN SCHEMA catalog
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mf_seed;
ALTER DEFAULT PRIVILEGES FOR ROLE mf_orchestration IN SCHEMA orchestration
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mf_seed;
ALTER DEFAULT PRIVILEGES FOR ROLE mf_compute IN SCHEMA compute
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mf_seed;
ALTER DEFAULT PRIVILEGES FOR ROLE mf_ontology IN SCHEMA ontology
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mf_seed;
ALTER DEFAULT PRIVILEGES FOR ROLE mf_governance IN SCHEMA governance
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mf_seed;
