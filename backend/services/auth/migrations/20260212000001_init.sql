-- auth schema (search_path = auth for this service)
-- Ports Prisma models: User, ApiToken, ApiRequestLog (+ new RefreshToken).

CREATE TABLE users (
    id             TEXT PRIMARY KEY,
    email          TEXT NOT NULL UNIQUE,
    name           TEXT NOT NULL,
    -- viewer | editor | admin
    role           TEXT NOT NULL,
    -- scrypt:<saltHex>:<hashHex> — NEVER returned by any API route
    password_hash  TEXT NOT NULL,
    is_active      BOOLEAN NOT NULL DEFAULT TRUE,
    last_login_at  TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE api_tokens (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL UNIQUE,
    -- sha256 hex of the plaintext secret (mf_live_...) — plaintext NEVER stored
    token_hash     TEXT NOT NULL UNIQUE,
    -- first 12 chars of the secret (mf_live_XXX) — safe to display
    prefix         TEXT NOT NULL,
    request_count  INTEGER NOT NULL DEFAULT 0,
    last_used_at   TIMESTAMPTZ,
    revoked_at     TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per authenticated public-API request. Deliberately NO FK to
-- api_tokens: logs must survive token deletion (usage reads join in memory).
CREATE TABLE api_request_logs (
    id             TEXT PRIMARY KEY,
    token_id       TEXT NOT NULL,
    route          TEXT NOT NULL,
    status         INTEGER NOT NULL,
    duration_ms    INTEGER NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX api_request_logs_token_id_idx ON api_request_logs (token_id);
CREATE INDEX api_request_logs_created_at_idx ON api_request_logs (created_at);

-- Rotating refresh tokens (new in the Rust stack: short-lived access JWTs +
-- 7-day refresh, matching the old 7-day session TTL at the UX level).
-- impersonated_role persists an admin role-switch across refreshes so
-- impersonation survives the short access-token lifetime (legacy sessions
-- carried the override for their whole 7-day TTL).
CREATE TABLE refresh_tokens (
    id                TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- sha256 hex of the random 64-char token
    token_hash        TEXT NOT NULL UNIQUE,
    impersonated_role TEXT,
    expires_at        TIMESTAMPTZ NOT NULL,
    revoked_at        TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_id_idx ON refresh_tokens (user_id);
CREATE INDEX refresh_tokens_expires_at_idx ON refresh_tokens (expires_at);
