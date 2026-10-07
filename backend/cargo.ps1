# MiniFoundry backend — cargo wrapper running inside the rust:1-bookworm
# container (this host has no MSVC linker). Persistent named volumes keep the
# registry + target dir warm, so builds are incremental.
#
# Usage (from backend/):
#   .\cargo.ps1 check --workspace
#   .\cargo.ps1 test -p mf-auth-service
#   .\cargo.ps1 build --release -p mf-gateway
#   .\cargo.ps1 clippy --workspace --all-targets
#
# NOTE: no param() block on purpose — everything in $args is forwarded
# verbatim, so cargo flags like -p bind to cargo, not to PowerShell.

$backend = $PSScriptRoot
$cargoConfig = Join-Path $env:USERPROFILE '.cargo\config.toml'

$configMount = @()
if (Test-Path $cargoConfig) {
    $configMount = @('-v', "${cargoConfig}:/usr/local/cargo/config.toml:ro")
}

docker run --rm `
    -v "${backend}:/app" `
    -v "mf-cargo-registry:/usr/local/cargo/registry" `
    -v "mf-cargo-git:/usr/local/cargo/git" `
    -v "mf-cargo-target:/app/target" `
    @configMount `
    -w /app `
    rust:1-bookworm `
    cargo @args

exit $LASTEXITCODE
