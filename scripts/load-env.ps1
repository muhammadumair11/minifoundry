# Load private .env values without echoing them. Explicit environment wins.
$envPath = Join-Path (Split-Path $PSScriptRoot -Parent) '.env'
if (Test-Path -LiteralPath $envPath) {
    foreach ($line in Get-Content -LiteralPath $envPath) {
        if ($line -match '^([A-Z_]+)=(.*)$') {
            $key = $Matches[1]
            $value = $Matches[2].Trim()
            if (-not [Environment]::GetEnvironmentVariable($key, 'Process')) {
                [Environment]::SetEnvironmentVariable($key, $value, 'Process')
            }
        }
    }
}
foreach ($key in @('AUTH_SECRET', 'MF_SERVICE_TOKEN', 'POSTGRES_PASSWORD')) {
    if (-not [Environment]::GetEnvironmentVariable($key, 'Process')) {
        throw "Set $key in private .env; generate it with node scripts/configure-env.mjs"
    }
}
