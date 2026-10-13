-- Tokens are organization credentials; names may repeat in different tenants.
ALTER TABLE api_tokens ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE api_tokens DROP CONSTRAINT api_tokens_name_key;
ALTER TABLE api_tokens ADD UNIQUE (organization_id, name);
CREATE INDEX api_request_logs_organization_created_idx ON api_request_logs (organization_id, created_at);
