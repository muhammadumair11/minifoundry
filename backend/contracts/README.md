# Golden contract fixtures

JSON responses captured from the **legacy Next.js API** (SQLite-seeded demo
workspace) that pin the wire contract every Rust service must reproduce
byte-for-byte at the structural level:

- identical field names and casing (camelCase);
- identical value types (`string | number | boolean | null`, arrays, objects);
- ISO-8601 UTC timestamps with exactly 3 fraction digits + `Z`
  (`2026-02-12T03:04:05.123Z`) — `Date#toJSON()` compatible;
- identical error envelopes `{ "error": "...", "detail"?: ... }` including the
  exact legacy message strings (e.g. `requires editor role (current: viewer)`);
- identical row ordering semantics where the legacy code guaranteed order
  (insertion-ordered JSON objects for rows/schemas).

## Layout

```
contracts/<service>/<route-slug>.json        # captured response body
contracts/<service>/<route-slug>.meta.json   # { method, path, status, notes }
```

## Capture procedure (run against the legacy app)

1. `bun run local` (or `bun run dev` + seeded `db/custom.db`).
2. `node scripts/capture-contracts.mjs` — logs in as the seeded admin,
   exercises representative flows (seed → list → detail → mutate), and writes
   the fixtures above. (Script lands in Phase 2 alongside the catalog port.)
3. Fixtures are committed; ids/timestamps inside them are normalized
   (placeholder tokens) by the capture script so tests compare structure,
   not volatile values.

## Test usage

Each service crate has `tests/contracts.rs` that replays the same requests
against an ephemeral Postgres (seeded via mf-seed) and asserts structural
equality with the fixture: same key sets (recursive), same value types, exact
error strings. Volatile values (ids, timestamps, durations) are type-checked,
not value-checked.
