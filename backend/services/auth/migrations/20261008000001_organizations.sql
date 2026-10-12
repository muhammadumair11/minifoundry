-- Organization tenancy. Existing single-workspace installations become Demo.
CREATE TABLE organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO organizations (id, name, slug) VALUES ('org_demo', 'Demo', 'demo')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE users ADD COLUMN IF NOT EXISTS default_organization_id TEXT REFERENCES organizations(id);

CREATE TABLE organization_memberships (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner','org_admin','access_manager','auditor','editor','viewer')),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (organization_id, user_id)
);
INSERT INTO organization_memberships (id, organization_id, user_id, role)
SELECT 'membership_' || id, 'org_demo', id,
       CASE role WHEN 'admin' THEN 'owner' WHEN 'editor' THEN 'editor' ELSE 'viewer' END
FROM users
ON CONFLICT (organization_id, user_id) DO NOTHING;
UPDATE users SET default_organization_id = 'org_demo' WHERE default_organization_id IS NULL;

ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS organization_id TEXT REFERENCES organizations(id);
UPDATE refresh_tokens SET organization_id = 'org_demo' WHERE organization_id IS NULL;
ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS organization_id TEXT REFERENCES organizations(id);
UPDATE api_tokens SET organization_id = 'org_demo' WHERE organization_id IS NULL;
ALTER TABLE api_request_logs ADD COLUMN IF NOT EXISTS organization_id TEXT REFERENCES organizations(id);
UPDATE api_request_logs SET organization_id = 'org_demo' WHERE organization_id IS NULL;
CREATE INDEX IF NOT EXISTS api_tokens_organization_idx ON api_tokens (organization_id);

CREATE TABLE organization_invitations (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('org_admin','access_manager','auditor','editor','viewer')),
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    accepted_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_by_user_id TEXT NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX organization_invites_lookup_idx ON organization_invitations (organization_id, email);
