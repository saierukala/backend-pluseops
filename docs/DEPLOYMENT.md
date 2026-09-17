# PulseOps — Deployment & Production Configuration (Phase 23)

This document is the Phase 23 production reference. It covers environment variables, secrets, migrations, health/readiness, graceful shutdown, logs, monitoring, error tracking, backups, rollback, HTTPS/reverse proxy, object storage, and PostgreSQL configuration.

> **No real production deployment is claimed here.** The CI pipeline validates deployment *readiness*; a real deploy requires provider configuration (see § 7). Do not invent credentials or hosts.

---

## 1. Services & Architecture

```
              ┌─────────────────────────────────────────────┐
              │              Reverse Proxy / LB             │
              │  (nginx / Traefik / ALB / Cloudflare) TLS │
              └──────────────────┬──────────────────────────┘
                                 │ HTTPS (443)
              ┌──────────────────┴──────────────────────────┐
              │              PulseOps API                   │
              │  Dockerfile  →  node src/app/server.js      │
              │  PORT 3000  health: /health /health/db /health/redis │
              └──────┬──────────────────────┬───────────────┘
                     │                      │
          ┌──────────┴──────────┐  ┌────────┴────────┐
          │  PostgreSQL 16      │  │  Redis 7        │
          │  postgres:16-alpine │  │  redis:7-alpine │
          │  pgdata volume      │  │  redisdata vol  │
          └─────────────────────┘  └────────┬────────┘
                                           │
                               ┌───────────┴───────────┐
                               │  PulseOps Worker      │
                               │  node src/worker.js   │
                               │  BullMQ consumers     │
                               └───────────────────────┘
```

* `Dockerfile` — multi-stage, `node:22-alpine`, non-root `pulseops`, `tini` PID 1, `wget` healthcheck.
* `docker-compose.yml` — local development (api + worker + postgres + redis + migrate).
* `docker-compose.prod.yml` — production overlay (requires real secrets, managed Postgres/Redis, `TRUST_PROXY=true`, `FAIL_ON_DEPENDENCY_ERROR=true`).

---

## 2. Environment Variables

### 2.1 Complete reference

| Variable | Required | Default | Notes |
|---|---|---|---|
| `NODE_ENV` | No | `development` | `development`/`test`/`production`. Production enforces `CORS_ORIGINS` and `FAIL_ON_DEPENDENCY_ERROR=true`. |
| `PORT` / `HOST` | No | `3000` / `0.0.0.0` | API bind. |
| `LOG_LEVEL` | No | `info` | `fatal`/`error`/`warn`/`info`/`debug`/`trace`/`silent`. |
| `DATABASE_URL` | **Yes** (prod) | — | `postgresql://user:password@host:5432/pulseops?schema=public` + `connection_limit`/`sslmode` (see § 6). |
| `REDIS_URL` | **Yes** (prod) | — | `redis://host:6379` or `rediss://` for TLS. |
| `CORS_ORIGINS` | **Yes** (prod) | `http://localhost:5173` | Comma-separated allow-list. `*` rejected with credentials; production default rejected. |
| `REQUEST_BODY_LIMIT` | No | `1mb` | JSON/urlencoded limit; multipart 10 MB via multer. |
| `RATE_LIMIT_WINDOW_MS`/`RATE_LIMIT_MAX` | No | `900000`/`100` | Global limiter (15 m / 100 req). |
| `AUTH_RATE_LIMIT_WINDOW_MS`/`AUTH_RATE_LIMIT_MAX` | No | `900000`/`20` | Auth endpoints (`/auth/login` etc.). |
| `WEBHOOK_RATE_LIMIT_WINDOW_MS`/`WEBHOOK_RATE_LIMIT_MAX` | No | `60000`/`100` | `POST /payments/webhook`. |
| `TRUST_PROXY` | No | `false` | Set `true` behind reverse proxy (production). |
| `FAIL_ON_DEPENDENCY_ERROR` | No | `true` in prod, `false` otherwise | When `true`, missing Postgres/Redis stops startup (correct for prod). |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | **Yes** (prod) | — | Min 32 chars. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Optional in `test`. |
| `JWT_ACCESS_EXPIRY` / `JWT_REFRESH_EXPIRY` | No | `15m` / `7d` | |
| `PASSWORD_RESET_EXPIRY` / `EMAIL_VERIFICATION_EXPIRY` | No | `1h` / `24h` | |
| `PAYMENT_WEBHOOK_SECRET` | No | `test-webhook-secret-…` | HMAC for `x-webhook-signature`/`x-payment-signature`. Must be set in prod. |
| `PAYMENT_PROVIDER` etc. | No | `mock` | `mock`/`http`; `PAYMENT_PROVIDER_URL`/`API_KEY`/`TIMEOUT_MS` when `http`. |
| `STORAGE_PROVIDER` | No | `local` | `local` (dev) / `s3` (prod). See § 5. |
| `LOCAL_STORAGE_PATH` / `LOCAL_STORAGE_URL` | No | `./storage` / `/storage` | Only when `STORAGE_PROVIDER=local`. |
| `S3_BUCKET` / `S3_REGION` / `S3_ENDPOINT` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` / `S3_PUBLIC_BASE_URL` / `S3_FORCE_PATH_STYLE` / `STORAGE_TIMEOUT_MS` | When `s3` | — | See § 5. |
| `EMAIL_PROVIDER` / `SMS_PROVIDER` / `SHIPPING_PROVIDER` / `MAPS_PROVIDER` + `*_URL`/`*_API_KEY`/`*_TIMEOUT_MS` | No | `mock` | Provider adapters (Phase 16). |

### 2.2 Local development

```bash
Copy-Item .env.example .env
# Edit .env — defaults work for docker compose (pulseops/pulseops)
DATABASE_URL=postgresql://pulseops:pulseops@localhost:5432/pulseops?schema=public
REDIS_URL=redis://localhost:6379
STORAGE_PROVIDER=local
```

### 2.3 Production — supply via secret manager (never commit `.env`)

```bash
# Example shape (DO NOT COMMIT REAL VALUES)
DATABASE_URL=postgresql://pulseops:${DB_PASSWORD}@<managed-pg-host>:5432/pulseops?schema=public&connection_limit=10&sslmode=require
REDIS_URL=rediss://default:${REDIS_PASSWORD}@<managed-redis-host>:6380
CORS_ORIGINS=https://app.example.com,https://admin.example.com
JWT_ACCESS_SECRET=<64-hex>
JWT_REFRESH_SECRET=<64-hex>
PAYMENT_WEBHOOK_SECRET=<64-hex>
STORAGE_PROVIDER=s3
S3_BUCKET=pulseops-prod-assets
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=<key>
S3_SECRET_ACCESS_KEY=<secret>
```

---

## 3. Secrets Management

* **Never commit** `.env`, passwords, API keys, or storage credentials. `.gitignore` excludes `.env`; `.dockerignore` excludes `.env` from images; Dockerfile does not `COPY .env`.
* **Local**: `.env` file (git-ignored) + `process.loadEnvFile` with deployment-env precedence (`src/config/env.js:5-13`).
* **CI**: GitHub **Environment** `production` secrets (`DATABASE_URL`, `REDIS_URL`, `JWT_*`, `PAYMENT_WEBHOOK_SECRET`, `S3_*`). Not `vars` — secrets are redacted in logs. Workflow has `permissions: contents: read` and never `echo` secrets.
* **Production**: Use provider secret manager — **AWS Secrets Manager / GCP Secret Manager / Azure Key Vault / Fly Secrets / Render Env Groups / Railway Variables / HashiCorp Vault**. Mount as env vars at deploy; rotate without redeploy where supported.
* **Logging**: `src/config/logger.js` redacts `password`, `token`, `secret`, `apiKey`, `S3_SECRET_ACCESS_KEY`, `authorization`, `cookie`, `*.secret` to `[REDACTED]` in Pino output.

---

## 4. Database Migrations

### 4.1 Production (the only correct command)

```bash
npx prisma migrate deploy
```

* Applies pending migrations from `prisma/migrations/` to the target `DATABASE_URL` without creating a new migration.
* **Idempotent** — re-running when up-to-date is a no-op.
* Must run as a **separate step before the API starts** (compose `migrate` service with `service_completed_successfully`).

### 4.2 What NOT to do in production

```bash
# ❌ NEVER in production — creates a new migration, may shadow history
npx prisma migrate dev
```

* `migrate dev` is for local development only (creates migration + applies). In CI/prod it can generate drift, prompt for names, or reset data.

### 4.3 Local / CI flow

```bash
# Fresh DB (empty) -> deploy must succeed
npx prisma migrate deploy
npx prisma migrate status   # "Database schema is up to date!"
npx prisma validate
npx prisma generate

# Local dev — create a new migration (only when schema.prisma changed)
npx prisma migrate dev --name <migration-name>
```

### 4.4 Verification

```bash
# Against disposable Postgres (CI does this in `migration-validation` job)
docker run --rm -e POSTGRES_USER=pulseops -e POSTGRES_PASSWORD=pulseops -e POSTGRES_DB=pulseops -p 5433:5432 postgres:16-alpine &
DATABASE_URL=postgresql://pulseops:pulseops@localhost:5433/pulseops?schema=public npx prisma migrate deploy
```

---

## 5. Object Storage Contract

### 5.1 Environment contract

```
STORAGE_PROVIDER       # local | s3
S3_BUCKET              # required when STORAGE_PROVIDER=s3
S3_REGION              # default us-east-1
S3_ENDPOINT            # e.g. https://s3.amazonaws.com or http://minio:9000 (optional)
S3_ACCESS_KEY_ID       # required for SigV4 when S3_ENDPOINT is private
S3_SECRET_ACCESS_KEY   # required for SigV4 (never logged, never sent to client)
S3_PUBLIC_BASE_URL     # optional public base; defaults to endpoint/bucket or virtual-hosted
S3_FORCE_PATH_STYLE    # true/false; path-style endpoint/bucket/key (MinIO/R2)
STORAGE_TIMEOUT_MS     # default 5000
```

Provider compatibility aliases (documented, not committed) — user may map per provider:

```
AWS S3:            S3_BUCKET / S3_REGION / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY
Cloudflare R2:     S3_BUCKET / S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY
GCS (S3 compat):   S3_BUCKET / S3_ENDPOINT=https://storage.googleapis.com / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY
Azure (S3 compat): S3_BUCKET / S3_ENDPOINT=https://<account>.blob.core.windows.net
```

### 5.2 Local vs production

```
Local development:  STORAGE_PROVIDER=local   → filesystem ./storage, no S3 credentials needed
Production:         STORAGE_PROVIDER=s3      → S3-compatible REST via S3StorageProvider (SigV4)
```

### 5.3 Security

* Do not hard-code credentials; do not commit them.
* Storage keys are server-generated and tenant-scoped (`tenants/{tenantId}/products/{productId}/{uuid}_{sanitized}`) — clients never choose paths.
* `STORAGE_SECRET_KEY` (alias `S3_SECRET_ACCESS_KEY`) never reaches the frontend; signed URLs carry only `storageKey` + expiry + HMAC/SigV4 signature.
* Local storage is **PRIVATE** — no `express.static` for `/storage`; bytes only via `GET /products/:productId/images/:imageId/file` (Bearer) or `GET /storage/signed?key=&expires=&signature=` (HMAC 900 s, `timingSafeEqual`).
* S3 is **PRIVATE-by-default** (bucket ACL private); `getUrl()` returns public URL only if bucket is public, otherwise `getSignedUrl()` SigV4 query (15 min) is required. See `src/common/storage/storage.service.js` and `src/integrations/storage/s3-storage.provider.js`.

---

## 6. Database Configuration

### 6.1 DATABASE_URL

```
DATABASE_URL=postgresql://user:password@host:5432/pulseops?schema=public
```

Production adds tuning params:

```
DATABASE_URL=postgresql://user:password@host:5432/pulseops?schema=public&connection_limit=10&sslmode=require
#                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
#                     user/PW/host              DB      schema   pool size     TLS
```

* `connection_limit` — Prisma pool size per process. With **N api replicas + M workers**, total connections ≈ `(N+M) * connection_limit`. Keep under managed Postgres `max_connections` (e.g. Neon 100, RDS 200). Example: 3 api + 2 workers × 10 = 50 connections → safe. If limit is tight, insert **PgBouncer** in transaction mode between app and Postgres and set `connection_limit` low (5) or use PgBouncer's own pooling.
* `sslmode=require` (or `verify-full` with CA) — required for managed PostgreSQL (RDS, Neon, Supabase, DO). Without it, managed hosts may reject non-TLS or expose MITM. Self-hosted `postgres:16-alpine` in compose does not need SSL.

### 6.2 Connection pooling

* **Prisma `connection_limit`** (query param) — simplest; per-process pool. Document above.
* **PgBouncer** (transaction mode) — option when managed Postgres has low `max_connections` or many replicas. Deploy as sidecar or separate service; point `DATABASE_URL` at PgBouncer host. Prisma works in transaction mode; avoid `interactiveTransactions` across multiple statements that rely on session state. For PulseOps, order/inventory/payment transactions are single Prisma `$transaction` blocks — compatible.

### 6.3 Managed PostgreSQL SSL considerations

* Set `sslmode=require` (minimum) or `sslmode=verify-full` + `sslcert` for strict.
* Prisma forwards `sslmode` to the underlying driver; no code change needed.
* In `docker-compose.prod.yml`, `DATABASE_URL` is required and should include `sslmode=require` — example in § 2.3.

### 6.4 Production checklist (database)

* [ ] `npx prisma migrate deploy` in `migrate` service (not `dev`)
* [ ] `connection_limit` tuned for replica count
* [ ] `sslmode=require` for managed hosts
* [ ] Automated backups (managed provider point-in-time recovery or `pg_dump` cron)
* [ ] PgBouncer if `max_connections` is constrained

---

## 7. Deployment Strategy

### 7.1 Provider — not yet selected (intentional)

No cloud provider, credentials, or infrastructure are claimed in this repo. The CI pipeline is **provider-agnostic** and will integrate with whichever provider the team selects. This section documents the reusable structure and required process.

### 7.2 CI/CD pipeline (` .github/workflows/ci.yml`)

```
install  →  lint  →  test  →  build  →  migration validation  →  deployment
  npm ci     eslint   jest    prisma   prisma migrate deploy     provider-agnostic
                      +       validate  (fresh empty DB,
                      Postgres  Docker   never `migrate dev`)
                      +Redis  build
                             compose config
```

* **install** — `npm ci` (reproducible, lockfile-exact).
* **lint** — `npm run lint` (0 errors).
* **test** — disposable Postgres 16 + Redis 7 services; `prisma generate` → `migrate deploy` → `npm test` → `migrate status`.
* **build** — `prisma validate` + `generate` + `docker compose config` + `docker build -t pulseops-backend:ci` + non-root + `.dockerignore` checks.
* **migration validation** — fresh empty Postgres; `prisma validate` → `migrate deploy` → `migrate status` → `SELECT` probe; asserts no `migrate dev` in workflow.
* **deployment** — needs `migration-validation`. On `push` to `main`/`master` it runs under `environment: production`; on PRs it runs `deployment (dry-run)` without secrets. Checks secrets presence, validates compose overlay, then provider-specific deploy is gated on `vars.DEPLOY_PROVIDER` + `secrets.DEPLOY_HOST`.
* Secrets are never echoed; workflow fails correctly when any required stage fails (no `|| true` on critical steps).

### 7.3 Reusable deployment interface

Configure these in GitHub **Environment `production`** (or repo-level `vars`/`secrets`) when a provider is selected:

```
vars.DEPLOY_PROVIDER   # fly | render | railway | aws | gcp | azure | custom
vars.DEPLOY_URL        # https://api.example.com (environment URL)
secrets.DEPLOY_HOST    # <provider host / app name>
secrets.DATABASE_URL   # production DATABASE_URL (with connection_limit & sslmode)
secrets.REDIS_URL      # production REDIS_URL
secrets.JWT_ACCESS_SECRET / JWT_REFRESH_SECRET / PAYMENT_WEBHOOK_SECRET
secrets.S3_*           # when STORAGE_PROVIDER=s3
```

The `deployment` job's placeholder step documents the pattern; replace it with provider commands, e.g.:

```yaml
# Fly.io example (illustrative — not executed until configured)
- run: flyctl deploy --remote-only --config fly.toml
  env:
    FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

### 7.4 What this repo provides vs provider dependency

| Provided by repo | Provider dependency (configure externally) |
|---|---|
| Dockerfile, compose, `migrate` service | Container registry / runtime (Fly, Render, Railway, ECS, GKE, etc.) |
| CI workflow with deployment stage | Secrets (`DATABASE_URL`, `REDIS_URL`, `JWT_*`, `S3_*`) |
| `DEPLOYMENT.md` + `docker-compose.prod.yml` | Domain, TLS cert, managed Postgres/Redis, S3 bucket |
| Healthchecks, graceful shutdown, logging | Reverse proxy / load balancer / autoscaling |

Never claim a real production deployment occurred unless it actually did against a configured provider.

---

## 8. Health / Readiness / Startup

### 8.1 Endpoints (preserved from Phase 1)

| Endpoint | Purpose | Returns 200 | Returns 503 |
|---|---|---|---|
| `GET /health` | Liveness — process is up | Always (no DB/Redis needed) | Never |
| `GET /health/db` | PostgreSQL readiness | `pg` SELECT 1 succeeded | `pg` down or not connected |
| `GET /health/redis` | Redis readiness | `PING` = `PONG` and status `ready` | Redis down or status not `ready` |
| `GET /api/v1/health` etc. | Same via versioned prefix | Same | Same |

Implementations: `src/modules/health/health.controller.js`, `src/config/database.js:databaseHealthCheck`, `src/config/redis.js:redisHealthCheck`.

### 8.2 Docker healthchecks

* **postgres** — `pg_isready -U pulseops -d pulseops` (interval 5 s, retries 10).
* **redis** — `redis-cli ping` (interval 5 s, retries 10).
* **api** — `wget -qO- http://127.0.0.1:3000/health` (liveness, no deps). Interval 15 s, start 20 s.
* **worker** — `ps aux | grep '[n]ode src/worker.js'` (process alive). Workers have no HTTP port.

### 8.3 Startup order (compose)

```
postgres (healthy) ─┐
redis    (healthy) ─┤─→  migrate (deploy) ─→  api  ─┐
                    │         (completed)      worker ─┤ (both wait for postgres+redis healthy)
```

`depends_on` uses `service_healthy` / `service_completed_successfully` — no polling that assumes "started" means ready.

### 8.4 Readiness semantics

* `src/app/server.js` — `Promise.allSettled([connectDatabase, connectRedis])`; if `FAIL_ON_DEPENDENCY_ERROR=true` (prod) any failure throws and process exits 1 (orchestrator restarts). Otherwise warns and readiness endpoints return 503 until connected.
* `src/worker.js` — same but **hard-fails** if either dependency is unavailable (worker cannot function without both).

### 8.5 Graceful shutdown

* `src/app/server.js:67-83` — `SIGTERM`/`SIGINT` → `shuttingDown` guard → `closeSocketServer` → `server.close()` → `shutdownJobs()` → `disconnectRedis()` + `disconnectDatabase()` → log `Graceful shutdown complete`; 10 s hard timeout `process.exit(1)`.
* `src/worker.js` — same for worker: `shutdownJobs()` (stops BullMQ workers, closes queues, disconnects BullMQ Redis) + `disconnectRedis`/`disconnectDatabase`; 10 s timeout.
* `Dockerfile` uses `tini` as PID 1 so signals reach Node correctly; `docker compose stop` sends `SIGTERM` then `SIGKILL` after 10 s — aligns with app timeout.

---

## 9. Logs, Monitoring, Error Tracking

### 9.1 Logs (Pino)

* `src/config/logger.js` — Pino structured JSON, `level: env.LOG_LEVEL`, redacts `password`/`token`/`secret`/`apiKey`/`authorization`/`cookie` paths to `[REDACTED]`.
* In Docker, logs go to stdout/stderr — collected by Docker's json-file driver or provider log aggregation. View: `docker compose logs -f api worker` or provider dashboard (Fly Logs, Render Logs, CloudWatch, etc.).
* `LOG_LEVEL=info` in prod; `debug`/`trace` for troubleshooting (verbose, not default).

### 9.2 Monitoring

* **Uptime** — probe `GET /health` (liveness) every 30 s; alert if non-200.
* **Readiness** — probe `GET /health/db` + `/health/redis` if you need dependency-aware routing; otherwise Kubernetes `readinessProbe` can use `/health`.
* **Metrics** — no Prometheus endpoint yet (Phase 23 only). Add `prom-client` in a later phase if needed; for now rely on provider metrics (CPU/memory, DB connections, Redis latency).
* **BullMQ** — queues observable via `GET /api/v1/jobs/status` and BullMQ failed set + Pino `Worker emitted failed` logs.

### 9.3 Error tracking

* Pino `logger.fatal` on `uncaughtException`/`unhandledRejection` with `{ err }`. For production error tracking, add **Sentry** or **Datadog** in a later phase: wrap `errorHandler` middleware and `shutdown` paths; keep Pino as primary logger. Do not expose stack traces in API responses (Phase 20 `error-handler.js` already hides stacks in prod).

---

## 10. Backups & Rollback

### 10.1 Backups

* **Managed Postgres** (RDS, Neon, Supabase, DO): enable **point-in-time recovery (PITR)** + daily snapshots; test restore quarterly. This is the recommended prod path.
* **Self-hosted `postgres` service**: schedule `pg_dump` cron outside compose (e.g. host cron or separate backup container):

  ```bash
  # Example host cron (daily 03:00 UTC, retains 7 days)
  pg_dump "postgresql://pulseops:${DB_PASSWORD}@localhost:5432/pulseops" \
    | gzip > /backups/pulseops-$(date +%F).sql.gz
  # Upload to S3: aws s3 cp /backups/pulseops-*.sql.gz s3://pulseops-backups/
  ```
* **Redis** — `redis:7-alpine` runs with `--appendonly yes` (AOF persistence) on volume `redisdata`. AOF + RDB snapshots survive restarts. For managed Redis, provider handles backups. Redis data is cache/queues — loss is recoverable (queues lose in-flight jobs; cache repopulates).
* **Object storage** — S3 buckets should have versioning + cross-region replication enabled.

### 10.2 Rollback strategy

* **Application** — rollback = redeploy previous Docker image tag (immutable tags per CI build, e.g. `pulseops-backend:sha-<commit>`). Keep last 3–5 tags in registry. `docker compose up -d` with previous tag or `kubectl rollout undo`.
* **Migrations** — Prisma migrations are **forward-only**. Never auto-rollback DB on deploy failure. If a migration introduced a breaking change, create a **new migration** that reverts the schema (Prisma has no `down`; author a compensating migration). Keep migrations backward-compatible where possible (add nullable columns first, drop later).
* **CI gate** — `migration-validation` job ensures fresh-DB deploy succeeds *before* deployment job runs; a broken migration blocks deploy.

---

## 11. HTTPS & Reverse Proxy

* **TLS** — terminate at the reverse proxy / load balancer, not in Node. Use provider-managed certs (Let's Encrypt via Traefik/nginx/Caddy, or ALB/Cloudflare). Node listens on `3000` plain HTTP inside the overlay network.
* **Reverse proxy** — examples: `nginx`, `Traefik`, `Caddy`, `AWS ALB`, `Cloudflare Tunnel`. Proxy forwards `Host` + `X-Forwarded-*` + `X-Request-Id`. Set `TRUST_PROXY=true` so Express respects `X-Forwarded-For` for rate limiting and `req.ip` in audit logs (`src/app/app.js:26`).
* **HSTS** — enabled in production via Helmet (`maxAge: 31536000`, `includeSubDomains`, `preload`) when `NODE_ENV=production` (`src/app/app.js:33`). Ensure proxy forwards `Strict-Transport-Security` header or let Helmet handle it.
* **Production overlay** — `docker-compose.prod.yml` sets `TRUST_PROXY=true` and `FAIL_ON_DEPENDENCY_ERROR=true`; expose API only via proxy (do not publish `3000` publicly without TLS).

---

## 12. PostgreSQL Connection Configuration — Quick Reference

```bash
# Development (compose default, no SSL, no pool tuning needed)
DATABASE_URL=postgresql://pulseops:pulseops@localhost:5432/pulseops?schema=public

# Production — managed Postgres with pooling + TLS
DATABASE_URL=postgresql://pulseops:${DB_PASSWORD}@<managed-host>:5432/pulseops?schema=public&connection_limit=10&sslmode=require

# With PgBouncer (transaction mode)
DATABASE_URL=postgresql://pulseops:${DB_PASSWORD}@pgbouncer:6432/pulseops?schema=public&connection_limit=5&sslmode=require
```

See § 6 for pooling/SSL details and § 4.1 for `migrate deploy` (never `migrate dev`).

---

## 13. Verification Commands

```bash
# Lint, Prisma, migrations, tests
npm run lint
npx prisma validate
npx prisma migrate status
npm test

# Docker
docker build -t pulseops-backend:local .
docker compose config --quiet && echo "compose OK"
docker compose -f docker-compose.yml -f docker-compose.prod.yml config --quiet && echo "prod overlay OK"
docker compose build
docker compose up -d
docker compose ps
curl -f http://localhost:3000/health
curl -f http://localhost:3000/health/db
curl -f http://localhost:3000/health/redis
docker compose logs api worker migrate postgres redis
docker compose down -v  # when safe to remove volumes

# Migration from empty DB (disposable)
docker run --rm -e POSTGRES_USER=pulseops -e POSTGRES_PASSWORD=pulseops -e POSTGRES_DB=pulseops -p 5433:5432 -d postgres:16-alpine
DATABASE_URL=postgresql://pulseops:pulseops@localhost:5433/pulseops?schema=public npx prisma migrate deploy
```

If Docker is unavailable in the environment, state that clearly and provide `docker compose config` validation as evidence (CI validates builds).
