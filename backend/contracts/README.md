# Golden contract fixtures

Captured JSON responses from the earlier Next.js API provide compatibility references for the Rust services. Fixtures preserve field names, value types, timestamp formats, error envelopes and row ordering.

## Layout

```text
contracts/<service>/<route-slug>.json        # response body
contracts/<service>/<route-slug>.meta.json   # method, path, status and notes
```

## Verification

Run against a seeded demo stack from the repository root:

```bash
node scripts/verify-contracts.mjs --base http://localhost:8080
```

The harness exercises public routes and compares responses with the committed fixtures. Deterministic values are compared directly; volatile identifiers, timestamps and history-dependent responses use structural checks. Unit tests run separately through `cargo test --workspace`.

`scripts/capture-contracts.mjs` can capture fixture responses from a local compatible API. Review fixture changes alongside the implementation so a capture does not silently replace the expected behavior. Token secrets are redacted in captured fixtures.

Internal service contracts are documented in [INTERNAL_API.md](INTERNAL_API.md). See the [testing guide](../../docs/testing.md) for the full integration suites.
