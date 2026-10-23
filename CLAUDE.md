# PulseOps backend — notes for Claude

## Git workflow (owner's standing instruction)

- Never push directly to `main`. Commit finished work to the session's working branch, push it, and open a
  pull request into `main` (one per phase or change).
- Before pushing, run `npm run lint`, `npm test`, and the live audit (`/pulseops-audit` steps, or
  `scripts/api-audit.js` against a server on port 3100). The known intermittent `phase15 › POST /jobs/cleanup`
  failure must pass on re-run.
- Merge the PR only once CI is green on its latest commit and there is no merge conflict. If `main` moved, merge
  `origin/main` into the branch (no rebase/force-push), re-run the checks, and push.
- Never force-push or rewrite `main`.
- Don't commit local artifacts (`.env`, `dump.rdb`, `storage/`, logs).

## Conventions

- Schema changes go through a new folder in `prisma/migrations/` applied with `prisma migrate deploy`;
  never run `migrate dev`, `migrate reset` or `docker compose down -v`.
- New routes need an `authorize('<resource>:<action>')` from `src/modules/permissions/system-permissions.js`,
  an OpenAPI entry under `src/docs/paths/`, the route added to `tests/integration/phase22-swagger.test.js`,
  and checks in `scripts/api-audit.js`.
- Update `docs/PROJECT_STATUS_AND_ROADMAP.md` and the roadmap §12 when a phase is completed.
