# MiniFoundry — integration gate runner.
#
# Brings up the full dev stack (containers wired to docker-compose.dev.yml
# infra), seeds the demo workspace through the gateway, then runs the two
# verification harnesses:
#   1. scripts/verify-contracts.mjs  — golden-contract replay (shapes/values)
#   2. scripts/e2e-phase1.mjs        — auth+gateway flows
#   3. scripts/smoke.sh              — full-stack flows (if bash available)
#
# Usage:
#   .\scripts\integrate.ps1                # build + start all + verify
#   .\scripts\integrate.ps1 -SkipBuild     # restart only
#   .\scripts\integrate.ps1 -SkipSmoke     # skip bash smoke (Windows w/o bash)

param(
    [switch]$SkipBuild,
    [switch]$SkipSmoke
)

$ErrorActionPreference = 'Continue'
$root = Split-Path $PSScriptRoot -Parent

Write-Host "=== 1/4 infra ===" -ForegroundColor Cyan
docker compose -f (Join-Path $root 'docker-compose.dev.yml') up -d --wait
if ($LASTEXITCODE -ne 0) { throw "dev infra failed to come up" }

Write-Host "=== 2/4 services (build + start) ===" -ForegroundColor Cyan
$stackArgs = @('-Services', 'all')
if ($SkipBuild) { $stackArgs += @('-SkipBuild') }
& (Join-Path $PSScriptRoot 'dev-stack.ps1') @stackArgs
if ($LASTEXITCODE -ne 0) { throw "dev-stack failed" }

Write-Host "=== 3/4 seed demo workspace ===" -ForegroundColor Cyan
$seedArgs = @('run', '--rm', '-v', 'mf-cargo-target:/t:ro',
    '-e', 'DATABASE_URL=postgres://postgres:<redacted>@host.docker.internal:5432/minifoundry',
    '-e', 'GATEWAY_URL=http://host.docker.internal:8080',
    '-e', 'MF_SERVICE_TOKEN=<redacted>',
    'debian:bookworm-slim', '/t/debug/mf-seed', 'all')
docker @seedArgs
$seedExit = $LASTEXITCODE
if ($seedExit -ne 0) { Write-Warning "mf-seed all exited $seedExit (stages may be missing)" }

Write-Host "=== 4/4 verification ===" -ForegroundColor Cyan
$results = @{}

node (Join-Path $root 'scripts\e2e-phase1.mjs') --base http://localhost:8080
$results['e2e-phase1'] = $LASTEXITCODE

node (Join-Path $root 'scripts\e2e-auth.mjs') --base http://localhost:8080
$results['e2e-auth'] = $LASTEXITCODE

node (Join-Path $root 'scripts\verify-contracts.mjs') --base http://localhost:8080
$results['verify-contracts'] = $LASTEXITCODE

if (-not $SkipSmoke) {
    $bash = Get-Command bash -ErrorAction SilentlyContinue
    if ($bash) {
        bash (Join-Path $root 'scripts/smoke.sh') http://localhost:8080
        $results['smoke'] = $LASTEXITCODE
    } else {
        Write-Warning "bash not found — skipping smoke.sh"
    }
}

Write-Host ""
Write-Host "=== integration gate summary ===" -ForegroundColor Cyan
$failed = 0
foreach ($k in $results.Keys) {
    $mark = if ($results[$k] -eq 0) { 'PASS' } else { $failed++; 'FAIL' }
    Write-Host ("  {0}: {1}" -f $k, $mark) $(if ($results[$k] -eq 0) {} else { })
}
if ($failed -gt 0) { Write-Host "GATE: $failed suite(s) failing" -ForegroundColor Red; exit 1 }
Write-Host "GATE: green" -ForegroundColor Green
