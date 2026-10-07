# Phase 7 cutover checklist (legacy Next.js app removal)

Precondition: `scripts/integrate.ps1` gate GREEN (verify-contracts + e2e +
smoke) with the full stack, and `docker compose up --build` verified from a
clean volume state.

## 1. Stop legacy processes
- [ ] Kill any `bun run dev` / `npm run local` / job-worker / scheduler processes
- [ ] Ports 3000 (frontend container/vite takes over) and 8080 free of legacy

## 2. Delete legacy application code (git rm)
- [ ] `src/` (entire legacy app: app/, components/, hooks/, lib/, middleware.ts)
- [ ] `prisma/`
- [ ] `mini-services/`
- [ ] `db/` (SQLite databases + backups — disposable dev data by decision)
- [ ] `public/` (copied to frontend/public)
- [ ] `tests/` (legacy bun tests — their Rust ports live in backend services;
      keep the two *-runtime-*.sh only if compute python-runtime docs reference them, else delete)
- [ ] Legacy scripts: `scripts/job-worker.ts`, `scripts/seed-cli.ts`,
      `scripts/seed-schedule-cli.ts`, `scripts/seed-users-cli.ts`,
      `scripts/benchmark-rows.ts`, `scripts/run-production-local.mjs`,
      `scripts/dev-guard.sh`, `scripts/verify-5a.sh`, `scripts/verify-p345.sh`
- [ ] Root app config: `package.json`, `bun.lock`, `tsconfig.json`,
      `tsconfig.tsbuildinfo`, `next.config.ts`, `next-env.d.ts`,
      `eslint.config.mjs`, `postcss.config.mjs`, `tailwind.config.ts`,
      `components.json` (copy components.json → frontend/ first if shadcn CLI
      is wanted there), `.ztmp-det.json`, `.ztmp-ds.json`, `qa-14b-connector.png`
- [ ] `Caddyfile` (nginx in the frontend container replaces it)
- [ ] `.next/`, `node_modules/` (build artifacts; already gitignored)

## 3. Keep (new stack + history)
- `frontend/`, `backend/`, `deploy/`, `docker-compose*.yml`, `.env.example`
- `scripts/`: capture-contracts.mjs (fixture provenance — move under
  backend/contracts/ optionally), verify-contracts.mjs, e2e-phase1.mjs,
  smoke.sh, dev-stack.ps1, integrate.ps1
- `worklog.md`, `docs/`, `MIGRATION.md` (fold into README or keep), `.github/`
- Non-code user artifacts (`download/`, `upload/`, `examples/`, `agent-ctx/`,
  `.zscripts/`, `tool-results/`) — leave untouched unless the user asks

## 4. Rewrite
- [ ] Root `README.md`: architecture diagram (text), quickstart =
      `docker compose up --build` + seed + URLs; dev workflow (dev compose +
      cargo.ps1 + bun dev); verification suite; link to backend/README.md,
      MIGRATION.md history, contracts docs
- [ ] `.github/workflows/verify.yml`: drop the legacy `app` job; keep
      backend (fmt/clippy/test) + frontend (build); ADD `smoke` job:
      docker compose build && up -d --wait → seed → verify-contracts + smoke.sh
- [ ] `.gitignore`: prune next.js entries, keep rust/node/docker entries

## 5. Final gate
- [ ] `git status` clean; fresh clone → `docker compose up -d --build` →
      `docker compose --profile tools run --rm seed all` →
      `node scripts/verify-contracts.mjs` green → `bash scripts/smoke.sh` green
- [ ] Browser pass (all 24 SPA pages) — role simulator, login/logout,
      pipeline run, transform runs (3 languages), action write-back, masking
      as viewer, notifications, curriculum
- [ ] Tag/merge decision handed to the user (NO push/merge without approval)
