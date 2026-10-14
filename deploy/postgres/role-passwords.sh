#!/bin/sh
set -eu

# Never echo passwords or pass them as psql command-line arguments.
: "${MF_AUTH_DB_PASSWORD:?Set MF_AUTH_DB_PASSWORD}"
: "${MF_CATALOG_DB_PASSWORD:?Set MF_CATALOG_DB_PASSWORD}"
: "${MF_ORCHESTRATION_DB_PASSWORD:?Set MF_ORCHESTRATION_DB_PASSWORD}"
: "${MF_COMPUTE_DB_PASSWORD:?Set MF_COMPUTE_DB_PASSWORD}"
: "${MF_ONTOLOGY_DB_PASSWORD:?Set MF_ONTOLOGY_DB_PASSWORD}"
: "${MF_GOVERNANCE_DB_PASSWORD:?Set MF_GOVERNANCE_DB_PASSWORD}"
: "${MF_SEED_DB_PASSWORD:?Set MF_SEED_DB_PASSWORD}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv role_password MF_AUTH_DB_PASSWORD
SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', 'mf_auth', :'role_password') \gexec
\getenv role_password MF_CATALOG_DB_PASSWORD
SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', 'mf_catalog', :'role_password') \gexec
\getenv role_password MF_ORCHESTRATION_DB_PASSWORD
SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', 'mf_orchestration', :'role_password') \gexec
\getenv role_password MF_COMPUTE_DB_PASSWORD
SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', 'mf_compute', :'role_password') \gexec
\getenv role_password MF_ONTOLOGY_DB_PASSWORD
SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', 'mf_ontology', :'role_password') \gexec
\getenv role_password MF_GOVERNANCE_DB_PASSWORD
SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', 'mf_governance', :'role_password') \gexec
\getenv role_password MF_SEED_DB_PASSWORD
SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', 'mf_seed', :'role_password') \gexec
SQL
