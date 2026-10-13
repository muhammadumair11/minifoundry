# Testing MiniFoundry

## Unit tests and build checks

With Rust and Bun installed:

```bash
cd backend
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cd ../frontend
bun install --frozen-lockfile
bun test tests
bun run build
```

On Windows, `backend/cargo.ps1` runs Cargo in Docker with cached build volumes. To pass Clippy's trailing arguments reliably in PowerShell, use `.\cargo.ps1 @('clippy', '--workspace', '--all-targets', '--', '-D', 'warnings')`.

## Demo integration checks

Against a running, seeded demo stack:

```bash
node scripts/e2e-phase1.mjs --base http://localhost:8080
node scripts/e2e-auth.mjs --base http://localhost:8080
node scripts/verify-contracts.mjs --base http://localhost:8080
bash scripts/smoke.sh http://localhost:8080
```

`scripts/integrate.ps1` orchestrates the demo checks. Golden contract fixtures live in [backend/contracts](../backend/contracts/README.md).

## Shared-mode organization checks

Use a local Compose stack with `MF_DEMO_MODE=false`. These checks use disposable accounts at `example.test`; invitations are accepted locally without sending email. Set a unique namespace and password for each new fixture set. No existing credentials or report files are needed.

From the repository root in PowerShell:

```powershell
$env:TEST_NAMESPACE = 'integration-' + [guid]::NewGuid().ToString('N')
$env:TEST_PASSWORD = [guid]::NewGuid().ToString() + 'Aa1!'
$env:TEST_CREATE_FIXTURES = '1'
bun scripts/check-organization-isolation.mjs
Remove-Item Env:\TEST_CREATE_FIXTURES

bun scripts/check-role-permissions.mjs
bun scripts/check-role-flow-fixes.mjs
bun scripts/check-quality-publication.mjs
bun scripts/check-consecutive-signups.mjs
bun scripts/check-tenant-scheduler.mjs
```

Fixture creation makes two organizations and all six roles in the primary organization. Subsequent runs reuse those fixtures with the same environment values. The default `BASE_URL` is `http://localhost:3000`; the harness restricts requests to localhost or `127.0.0.1`.

The suite covers resource lists and direct IDs, exports, writes, input bindings, spoofed identity headers, concurrent requests, background outputs, upstream events, tokens, search, audit and role revalidation. The quality check tests failed publication gates and approval decisions. The signup check removes its exact temporary users and organizations. The scheduler check disables its test schedules in cleanup.

To verify organization-scoped reset handlers, run this additional sequence. It clears resources only in the disposable control organization, checks that the primary organization survives, and then restores the control fixtures:

```powershell
bun scripts/check-scoped-reset.mjs
$env:TEST_RESEED_CONTROL = '1'
bun scripts/check-organization-isolation.mjs
Remove-Item Env:\TEST_RESEED_CONTROL
```

The fixture organizations remain available for inspection. Use a fresh namespace for a new independent run. `TEST_SEED_FIXTURES=1` can seed resources for matching accounts created separately through onboarding.

Additional self-contained checks are `bun scripts/check-auth-roles.mjs`, `bun scripts/check-rbac.mjs` and `.\scripts\check-tenant-policies.ps1`. These require the local Docker stack; the policy check rolls back its temporary schemas and rows.
