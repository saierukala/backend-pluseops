---
description: Audit the PulseOps backend end to end — tests, lint, live API audit — and refresh the status/roadmap doc
argument-hint: "[focus area, e.g. 'rbac' or 'phase 26'] (optional)"
---

Run a full health audit of the PulseOps backend and report the whole picture in plain language.
Focus area from the user (may be empty): $ARGUMENTS

## Context to load first
- `docs/PROJECT_STATUS_AND_ROADMAP.md` — current status, audit table, gap list (this is what you refresh)
- `docs/PulseOps_Backend_Codex_Master_Roadmap.md` §4 phase order and §12 phases 24–35
- `src/app/routes.js` and every `src/modules/*/*.routes.js` — the real route inventory
- `src/modules/permissions/system-permissions.js` — tenant permission catalog
- `git log --oneline -15` and `git status` — what changed since the last audit

## Steps
1. **Environment.** Docker may be off; native PostgreSQL (5432) and Redis/Memurai (6379) are usually running.
   Check `npx prisma migrate status`. Never run `migrate dev`, `migrate reset` or `docker compose down -v`.
2. **Static checks.** `npm run lint` and `npm test` (≈3 min, run in background). Don't run a second API
   instance at the same time as Jest — both consume the same BullMQ queues and Phase 15 tests time out.
3. **Seed.** `npm run db:seed` (idempotent; backfills catalog permissions into existing tenants).
4. **Live audit.** Start the API on port 3100 with raised limits
   (`PORT=3100 RATE_LIMIT_MAX=100000 AUTH_RATE_LIMIT_MAX=100000 LOG_LEVEL=warn node src/app/server.js`),
   then `AUDIT_BASE_URL=http://localhost:3100 node scripts/api-audit.js --out <scratchpad>/audit.json`.
   Stop the server afterwards.
5. **New routes.** If a route exists that `scripts/api-audit.js` doesn't exercise, add checks for it (happy path,
   no-token 401, no-permission 403, other-tenant 404) before trusting the result.
6. **Triage every failure.** Read the route → service → repository code. Classify each as
   *bug* (behaviour contradicts code/docs intent), *gap* (feature missing — map it to a roadmap phase), or
   *audit expectation wrong* (fix the script and say so). Never relax an expectation just to get green.
7. **Corrections.** Fix clear, local bugs directly, each with a test. Anything that changes a public contract,
   removes an endpoint, or needs a product decision: list it and ask — don't do it silently.
8. **Refresh docs.** Update `docs/PROJECT_STATUS_AND_ROADMAP.md` (date, commit, feature table, audit table
   from the JSON, corrections, gap list by priority P0–P3) and the roadmap §12 if phases changed status.
   Never write real passwords or secrets into docs.

## Report back
Plain language, short: what PulseOps is (2 lines), test + audit numbers, bugs fixed, gaps by priority with the
phase that closes each, and the single recommended next step. Nothing is committed unless the user asks.
