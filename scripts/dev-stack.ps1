# MiniFoundry - dev-stack runner (pre-compose integration loop on Windows).
#
# Builds the requested services via the Docker cargo wrapper and (re)starts
# them as containers wired to the dev infra (docker-compose.dev.yml:
# postgres :5432, nats :4222). The gateway gets host-reachable internal URLs
# for every service.
#
# Usage:
#   .\scripts\dev-stack.ps1                          # auth + gateway
#   .\scripts\dev-stack.ps1 -Services auth,catalog,gateway
#   .\scripts\dev-stack.ps1 -Services all
#   .\scripts\dev-stack.ps1 -Services all -SkipBuild # restart only
#
# NOTE: pure ASCII on purpose - Windows PowerShell 5.1 reads BOM-less files
# as ANSI and UTF-8 punctuation breaks string literals.

param(
    [string[]]$Services = @('auth', 'gateway'),
    [switch]$SkipBuild
)

# Continue, not Stop: docker/cargo write progress to stderr, which Stop would
# convert into terminating errors. Failures are handled via explicit exit codes.
$ErrorActionPreference = 'Continue'
$root = Split-Path $PSScriptRoot -Parent

# Robust to being invoked via `powershell -File` (which passes "a,b,c" as a
# single string instead of an array).
$Services = @($Services | ForEach-Object { $_ -split ',' } | Where-Object { $_ })

if ($Services -contains 'all') {
    $Services = @('auth', 'catalog', 'orchestration', 'compute', 'ontology', 'governance', 'public-api', 'gateway')
}

$spec = @{
    'auth'          = @{ pkg = 'mf-auth-service'; port = 8081; db = 'mf_auth:<redacted>'; image = 'debian:bookworm-slim' }
    'catalog'       = @{ pkg = 'mf-catalog';      port = 8082; db = 'mf_catalog:<redacted>'; image = 'debian:bookworm-slim' }
    'orchestration' = @{ pkg = 'mf-orchestration'; port = 8083; db = 'mf_orchestration:<redacted>'; image = 'debian:bookworm-slim' }
    # compute executes Python workbooks -> runtime image must carry python3
    'compute'       = @{ pkg = 'mf-compute';      port = 8084; db = 'mf_compute:<redacted>'; image = 'python:3.12-slim' }
    'ontology'      = @{ pkg = 'mf-ontology';     port = 8085; db = 'mf_ontology:<redacted>'; image = 'debian:bookworm-slim' }
    'governance'    = @{ pkg = 'mf-governance';   port = 8086; db = 'mf_governance:<redacted>'; image = 'debian:bookworm-slim' }
    'public-api'    = @{ pkg = 'mf-public-api';   port = 8087; db = $null; image = 'debian:bookworm-slim' }
    'gateway'       = @{ pkg = 'mf-gateway';      port = 8080; db = $null; image = 'debian:bookworm-slim' }
}

$commonEnv = @(
    '-e', 'MF_DEMO_MODE=true',
    '-e', 'MF_SERVICE_TOKEN=<redacted>',
    '-e', 'AUTH_SECRET=<redacted>',
    '-e', 'MF_COOKIE_SECURE=0',
    '-e', 'NATS_URL=nats://host.docker.internal:4222',
    '-e', 'AUTH_INTERNAL_URL=http://host.docker.internal:8081',
    '-e', 'CATALOG_INTERNAL_URL=http://host.docker.internal:8082',
    '-e', 'ORCHESTRATION_INTERNAL_URL=http://host.docker.internal:8083',
    '-e', 'COMPUTE_INTERNAL_URL=http://host.docker.internal:8084',
    '-e', 'ONTOLOGY_INTERNAL_URL=http://host.docker.internal:8085',
    '-e', 'GOVERNANCE_INTERNAL_URL=http://host.docker.internal:8086',
    '-e', 'PUBLIC_API_INTERNAL_URL=http://host.docker.internal:8087',
    '-e', 'GATEWAY_URL=http://host.docker.internal:8080',
    '-e', 'RUST_LOG=info,sqlx=warn'
)

# -- build --
if (-not $SkipBuild) {
    $pkgs = @()
    foreach ($s in $Services) { $pkgs += @('-p', $spec[$s].pkg) }
    Write-Host "building: $($pkgs -join ' ')"
    Push-Location (Join-Path $root 'backend')
    & .\cargo.ps1 build @pkgs
    if ($LASTEXITCODE -ne 0) { Pop-Location; throw "cargo build failed ($LASTEXITCODE)" }
    Pop-Location
}

# -- (re)start --
foreach ($svc in $Services) {
    $s = $spec[$svc]
    $name = "mf-$svc"
    docker rm -f $name 2>$null | Out-Null
    $envArgs = @('-e', "PORT=$($s.port)")
    if ($s.db) {
        $envArgs += @('-e', "DATABASE_URL=postgres://$($s.db)@host.docker.internal:5432/minifoundry")
    }
    docker run -d --name $name --init -p "$($s.port):$($s.port)" `
        -v mf-cargo-target:/t:ro @commonEnv @envArgs `
        $s.image "/t/debug/$($s.pkg)" | Out-Null
    Write-Host "started $name on :$($s.port)"
}

# -- health wait --
$failed = @()
foreach ($svc in $Services) {
    $port = $spec[$svc].port
    $ok = $false
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Seconds 1
        try {
            $r = Invoke-WebRequest -Uri "http://localhost:$port/healthz" -UseBasicParsing -TimeoutSec 3
            if ($r.StatusCode -eq 200) { $ok = $true; break }
        } catch { }
    }
    if ($ok) {
        Write-Host "  [OK]   $svc healthy"
    } else {
        Write-Host "  [FAIL] $svc NOT healthy - logs:"
        docker logs "mf-$svc" --tail 15 2>&1 | Write-Host
        $failed += $svc
    }
}
Write-Host "stack: $($Services -join ', ') | gateway http://localhost:8080 | SPA (bun dev) http://localhost:3000"
if ($failed.Count -gt 0) { throw "unhealthy services: $($failed -join ', ')" }
