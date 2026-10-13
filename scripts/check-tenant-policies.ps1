# Run real PostgreSQL policy checks in temporary schemas, then roll back every
# transaction. Existing application data and migration ledgers are untouched.
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$policySql = [System.Text.StringBuilder]::new()
[void]$policySql.AppendLine('\set ON_ERROR_STOP on')
foreach ($domain in @('catalog', 'orchestration', 'compute', 'ontology', 'governance', 'auth')) {
    $testSchema = 'qa_tenant_' + $domain
    [void]$policySql.AppendLine("BEGIN; CREATE SCHEMA $testSchema AUTHORIZATION mf_$domain; SET LOCAL ROLE mf_$domain; SET LOCAL search_path = $testSchema; SET LOCAL mf.organization_id = '*';")
    $migrationPaths = Get-ChildItem -LiteralPath (Join-Path $repoRoot "backend/services/$domain/migrations") -Filter '*.sql' | Sort-Object Name
    foreach ($migrationPath in $migrationPaths) {
        [void]$policySql.AppendLine([System.IO.File]::ReadAllText($migrationPath.FullName))
    }
    if ($domain -eq 'catalog') {
        [void]$policySql.AppendLine(@'
SET LOCAL mf.organization_id = 'tenant_test_a';
INSERT INTO projects (id, name) VALUES ('qa-project', 'Private project');
SET LOCAL mf.organization_id = 'tenant_test_b';
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM projects WHERE id = 'qa-project') THEN RAISE EXCEPTION 'cross-tenant read'; END IF;
 BEGIN
  INSERT INTO datasets (id, name, project_id) VALUES ('qa-dataset', 'Foreign binding', 'qa-project');
  SET CONSTRAINTS ALL IMMEDIATE;
  RAISE EXCEPTION 'cross-tenant FK accepted';
 EXCEPTION WHEN foreign_key_violation THEN NULL;
 END;
END $$;
SET LOCAL mf.organization_id = '';
DO $$ BEGIN IF EXISTS(SELECT 1 FROM projects) THEN RAISE EXCEPTION 'unscoped read'; END IF; END $$;
'@)
    }
    if ($domain -eq 'auth') {
        [void]$policySql.AppendLine(@'
INSERT INTO organizations (id, name, slug) VALUES ('qa-org-a', 'A', 'qa-a'), ('qa-org-b', 'B', 'qa-b');
INSERT INTO api_tokens (id, organization_id, name, token_hash, prefix) VALUES
 ('qa-token-a', 'qa-org-a', 'Same name', 'hash-a', 'test-a'),
 ('qa-token-b', 'qa-org-b', 'Same name', 'hash-b', 'test-b');
DO $$ BEGIN IF (SELECT count(*) FROM api_tokens WHERE name = 'Same name') <> 2 THEN RAISE EXCEPTION 'token names not scoped'; END IF; END $$;
'@)
    }
    $testLabel = if ($domain -eq 'auth') { 'auth token scope' } else { "$domain row policies" }
    [void]$policySql.AppendLine("ROLLBACK; \echo PASS $testLabel")
}
Push-Location $repoRoot
try {
    $policySql.ToString() | docker compose exec -T postgres psql -U postgres -d minifoundry -v ON_ERROR_STOP=1
    if ($LASTEXITCODE -ne 0) { throw 'Tenant policy checks failed' }
} finally { Pop-Location }
