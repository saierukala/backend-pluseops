# PulseOps backend — notes for Claude

## Git workflow (owner's standing instruction)

- Commit every finished change and push it to `main`, in addition to the session's working branch.
- Before pushing to `main`, run `npm run lint`, `npm test`, and the live audit (`/pulseops-audit` steps, or
  `scripts/api-audit.js` against a server on port 3100). Push only when they pass; the known intermittent
  `phase15 › POST /jobs/cleanup` failure must pass on re-run.
- Fast-forward only: `git fetch origin main`, merge `origin/main` into the branch if it moved, re-run the checks,
  then `git push origin HEAD:main`. Never force-push or rewrite `main`.
- Don't commit local artifacts (`.env`, `dump.rdb`, `storage/`, logs).

## Conventions

- Schema changes go through a new folder in `prisma/migrations/` applied with `prisma migrate deploy`;
  never run `migrate dev`, `migrate reset` or `docker compose down -v`.
- New routes need an `authorize('<resource>:<action>')` from `src/modules/permissions/system-permissions.js`,
  an OpenAPI entry under `src/docs/paths/`, the route added to `tests/integration/phase22-swagger.test.js`,
  and checks in `scripts/api-audit.js`.
- Update `docs/PROJECT_STATUS_AND_ROADMAP.md` and the roadmap §12 when a phase is completed.
