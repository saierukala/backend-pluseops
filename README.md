# PulseOps Backend

A production-minded, multi-tenant backend for PulseOps, built with Node.js, Express, PostgreSQL, Prisma, and Redis. The project follows a modular-monolith architecture and is being delivered incrementally so that every foundation layer is tested before business modules are introduced.

**Current status:** Phase 23 — Docker / CI/CD / Deployment is **COMPLETE and HUMAN VERIFIED**. Phase 22 — Swagger / OpenAPI Documentation is **COMPLETE (OpenAPI 3.0.3, 81 path keys, 115 operations, 115 unique operationIds, 26 schemas, bearerAuth, 21 tags, Swagger UI at `/api-docs`)**. Phase 21 — Complete Testing is **COMPLETE (87 new tests: 51 unit + 12 E2E + 24 extended)**. Phase 20 — Security Hardening is **COMPLETE and VERIFIED (HUMAN VERIFICATION: PASS)**. Phase 19 — Performance Optimization is **COMPLETE and VERIFIED (HUMAN VERIFICATION: PASS)**. No work beyond Phase 23 is claimed.

The full phase-by-phase plan lives in a single source of truth: [`docs/PulseOps_Backend_Codex_Master_Roadmap.md`](docs/PulseOps_Backend_Codex_Master_Roadmap.md).

## Quick Start — Docker

The primary recommended local workflow is Docker Compose. It provides the full PulseOps stack with no manual PostgreSQL/Redis setup.

```bash
docker compose up -d
docker compose ps
```

Normal PulseOps runtime consists of:

* **api** — Express API on `http://localhost:3000` (`pulseops-api`)
* **worker** — BullMQ background worker (`pulseops-worker`, no HTTP port)
* **postgres** — PostgreSQL 16 (`pulseops-postgres`, `pgdata` volume)
* **redis** — Redis 7 (`pulseops-redis`, `redisdata` volume)

Plus a short-lived **migrate** service (`pulseops-migrate`) that runs `npx prisma migrate deploy` against the healthy PostgreSQL instance and then exits successfully (`service_completed_successfully`). The `api` and `worker` start only after `migrate` has completed and both `postgres` and `redis` report healthy.

Verify after start:

```bash
curl -f http://localhost:3000/health
curl -f http://localhost:3000/api-docs
docker compose ps
```

See [Setup](#setup) for environment file setup and [Docker Operations](#docker-operations) for the full command reference.

## Health Checks

| Endpoint | URL | What it verifies |
| --- | --- | --- |
| Liveness | `http://localhost:3000/health` | Process is up. Works without PostgreSQL or Redis. Always returns 200 when the API is running. |
| PostgreSQL readiness | `http://localhost:3000/health/db` | PostgreSQL connectivity (`SELECT 1`). Returns 200 when connected, 503 until connected. |
| Redis readiness | `http://localhost:3000/health/redis` | Redis connectivity (`PING` → `PONG` and `status: ready`). Returns 200 when connected, 503 until connected. |

The same checks are also exposed under the versioned prefix `/api/v1/health`, `/api/v1/health/db`, `/api/v1/health/redis`, but infrastructure probes should use the root `/health` routes.

Docker Compose maps the API healthcheck to `wget -qO- http://127.0.0.1:3000/health` (liveness, no DB/Redis needed) and Postgres/Redis to `pg_isready` / `redis-cli ping` respectively.

## Swagger / OpenAPI Documentation

### Interactive UI

```text
http://localhost:3000/api-docs
```

The interactive Swagger UI (served by `swagger-ui-express@5.0.1`) is public, requires no authentication, and documents all 115 operations across 81 path keys with `bearerAuth` (`Authorization: Bearer <token>`). Use **Try it out** to execute requests.

### Machine-readable OpenAPI specification

```text
http://localhost:3000/api-docs.json
http://localhost:3000/openapi.json
http://localhost:3000/api/v1/openapi.json
```

All three endpoints return the same OpenAPI 3.0.3 JSON document (`openapi: 3.0.3`, 81 paths, 115 operations, 115 unique `operationId`, 26 reusable schemas, `bearerAuth`, 21 tags). Server is `http://localhost:3000` — clients append the path as-is (no `/api/v1` duplication; `SERVER BASE + PATH = ACTUAL ROUTE`). `$ref` coverage is 573 with 0 unresolved. The `/api-docs` route serves the human UI; the `.json` routes expose the machine-readable spec for code generation and tooling.

The endpoint table below lists the authoritative route inventory; Swagger is the interactive complement, not a duplicate listing.

## Prerequisites

- Node.js 22 or newer
- npm 10 or newer
- Docker & Docker Compose (recommended path) — provides PostgreSQL 16 and Redis 7 via containers
- PostgreSQL 16 or newer and Redis, only if running the API natively without Docker

## Setup

### Recommended: Docker (full stack)

Use Docker Compose for the full runtime — no local PostgreSQL/Redis installation required.

1. Install dependencies (needed for local lint/tests and Prisma client generation even when running via Docker):

   ```bash
   npm install
   ```

2. Create your local environment file:

   ```powershell
   Copy-Item .env.example .env
   ```

   Defaults in `.env.example` already match the compose services (`DATABASE_URL=postgresql://pulseops:pulseops@localhost:5432/pulseops?schema=public`, `REDIS_URL=redis://localhost:6379`, `STORAGE_PROVIDER=local`). No edits are required for local Docker.

3. Start the full stack:

   ```bash
   docker compose up -d
   docker compose ps
   ```

   Expected: `postgres` and `redis` report `healthy`, `migrate` runs `prisma migrate deploy` and exits `Exit 0`, `api` and `worker` show `healthy`/`running`. Persistent data lives in named volumes `pulseops_pgdata` and `pulseops_redisdata`.

4. Access the API and docs:

   ```text
   http://localhost:3000/health
   http://localhost:3000/api-docs
   http://localhost:3000/api-docs.json
   ```

   The API is available at `http://localhost:3000` and Swagger UI at `http://localhost:3000/api-docs`.

### Alternative: Native Node (when PostgreSQL/Redis are provided separately)

Use this workflow when you manage PostgreSQL and Redis outside Docker (e.g., locally installed services or managed hosts). The Docker workflow above remains the recommended full-stack path.

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create and configure `.env`:

   ```powershell
   Copy-Item .env.example .env
   ```

   Update `DATABASE_URL` and `REDIS_URL` to point to your separately provided services.

3. Generate Prisma Client:

   ```bash
   npm run prisma:generate
   ```

4. Run database migrations:

   ```bash
   npx prisma migrate deploy
   ```

5. (Optional) Seed foundational roles/permissions:

   ```bash
   npm run db:seed
   ```

6. Start the API:

   ```bash
   npm run dev
   ```

## Environment Reference

| Variable | Required | Purpose |
| --- | --- | --- |
| `NODE_ENV` | No | `development`, `test`, or `production`; defaults to `development`. |
| `PORT` / `HOST` | No | HTTP bind address; defaults to `3000` and `0.0.0.0`. |
| `DATABASE_URL` | For DB checks | PostgreSQL Prisma connection string, e.g. `postgresql://user:pass@localhost:5432/pulseops?schema=public`. **Required in production** (with `connection_limit` + `sslmode=require` for managed hosts — see `docs/DEPLOYMENT.md`). |
| `REDIS_URL` | For Redis checks | Redis connection string. **Required in production**. |
| `CORS_ORIGINS` | No in dev, **Yes in prod** | Comma-separated allow-list; `*` rejected with credentials, production requires explicit origins (default `http://localhost:5173` rejected in prod). |
| `LOG_LEVEL` | No | Pino log threshold. |
| `REQUEST_BODY_LIMIT` | No | Maximum JSON/urlencoded request size; defaults to `1mb` (multipart 10MB via multer). |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` | No | Global rate-limit (default 15m/100). |
| `AUTH_RATE_LIMIT_WINDOW_MS` / `AUTH_RATE_LIMIT_MAX` | No | Auth rate-limit (default 15m/20) for `/auth/login|register|refresh|forgot-password|reset-password|verify-email`. |
| `WEBHOOK_RATE_LIMIT_WINDOW_MS` / `WEBHOOK_RATE_LIMIT_MAX` | No | Webhook rate-limit (default 1m/100) for `/payments/webhook`. |
| `TRUST_PROXY` | No | Set to `true` when the API runs behind a trusted reverse proxy. |
| `FAIL_ON_DEPENDENCY_ERROR` | No | Defaults to `true` in production and `false` elsewhere. When true, PostgreSQL/Redis startup failures stop the API. |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | Yes in prod | JWT secrets (min 32 chars); optional in test. |
| `JWT_ACCESS_EXPIRY` / `JWT_REFRESH_EXPIRY` | No | JWT expiry; defaults `15m` / `7d`. |
| `PASSWORD_RESET_EXPIRY` / `EMAIL_VERIFICATION_EXPIRY` | No | Token expiry; defaults `1h` / `24h`. |
| `PAYMENT_WEBHOOK_SECRET` | No | HMAC secret for `x-webhook-signature`/`x-payment-signature`; defaults to test secret. **Required in production.** |
| `PAYMENT_PROVIDER` | No | `mock` or `http` (or `stripe`, `adyen`); defaults to `mock`. |
| `PAYMENT_PROVIDER_URL` | No | Base URL for HTTP payment provider; required when `PAYMENT_PROVIDER=http`. |
| `PAYMENT_PROVIDER_API_KEY` | No | API key for HTTP payment provider; sent as `Authorization: Bearer`. |
| `PAYMENT_PROVIDER_TIMEOUT_MS` | No | Timeout for payment provider HTTP calls; defaults to `5000`. |
| `STORAGE_PROVIDER` | No | `local` or `s3`; defaults to `local`. |
| `LOCAL_STORAGE_PATH` | No | Filesystem base path for local storage; defaults to `./storage`. |
| `LOCAL_STORAGE_URL` | No | URL prefix for local storage; defaults to `/storage`. |
| `S3_BUCKET` | No | S3 bucket name; required when `STORAGE_PROVIDER=s3` in production. |
| `S3_REGION` | No | S3 region; defaults to `us-east-1`. |
| `S3_ENDPOINT` | No | S3 endpoint URL (e.g., `http://localhost:9000` for MinIO); optional. |
| `S3_ACCESS_KEY_ID` | No | S3 access key; used for SigV4 when provided. |
| `S3_SECRET_ACCESS_KEY` | No | S3 secret key; used for SigV4; never logged. |
| `S3_PUBLIC_BASE_URL` | No | Public base URL for S3 objects; defaults to endpoint/bucket or virtual-hosted URL. |
| `S3_FORCE_PATH_STYLE` | No | `true`/`false`; path-style `endpoint/bucket/key`; defaults to `false`. |
| `STORAGE_TIMEOUT_MS` | No | Timeout for storage provider HTTP (S3 REST); defaults to `5000`. |
| `EMAIL_PROVIDER` | No | `mock` or `http` (or `sendgrid`, `ses`, `mailgun`); defaults to `mock`. |
| `EMAIL_PROVIDER_URL` | No | Base URL for HTTP email provider; required when `EMAIL_PROVIDER=http`. |
| `EMAIL_PROVIDER_API_KEY` | No | API key for HTTP email provider. |
| `EMAIL_PROVIDER_TIMEOUT_MS` | No | Timeout for email provider HTTP; defaults to `5000`. |
| `SMS_PROVIDER` | No | `mock` or `http` (or `twilio`, `vonage`); defaults to `mock`. |
| `SMS_PROVIDER_URL` | No | Base URL for HTTP SMS provider. |
| `SMS_PROVIDER_API_KEY` | No | API key for HTTP SMS provider. |
| `SMS_PROVIDER_TIMEOUT_MS` | No | Timeout for SMS provider HTTP; defaults to `5000`. |
| `SHIPPING_PROVIDER` | No | `mock` or `http` (or `shippo`, `easypost`); defaults to `mock`. |
| `SHIPPING_PROVIDER_URL` | No | Base URL for HTTP shipping provider. |
| `SHIPPING_PROVIDER_API_KEY` | No | API key for HTTP shipping provider. |
| `SHIPPING_PROVIDER_TIMEOUT_MS` | No | Timeout for shipping provider HTTP; defaults to `5000`. |
| `MAPS_PROVIDER` | No | `mock` or `http` (or `google`, `mapbox`); defaults to `mock`. |
| `MAPS_PROVIDER_URL` | No | Base URL for HTTP maps provider. |
| `MAPS_PROVIDER_API_KEY` | No | API key for HTTP maps provider. |
| `MAPS_PROVIDER_TIMEOUT_MS` | No | Timeout for maps provider HTTP; defaults to `5000`. |

Never commit `.env`. The repository `.gitignore` excludes `.env` and `.dockerignore` excludes `.env` from images; the `Dockerfile` does not `COPY .env`. Use a secret manager or deployment-specific environment variables in production. See `docs/DEPLOYMENT.md` for the full production contract (`DATABASE_URL` with `connection_limit`/`sslmode`, `S3_*`, `TRUST_PROXY`, etc.). Required production values (`DATABASE_URL`, `REDIS_URL`, `JWT_*`, `PAYMENT_WEBHOOK_SECRET`, `CORS_ORIGINS`) must come from the provider — do not commit them.

## Endpoints

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/health` | Liveness probe. Works without PostgreSQL or Redis. |
| GET | `/health/db` | PostgreSQL readiness probe. Returns `503` until connected. |
| GET | `/health/redis` | Redis readiness probe. Returns `503` until connected. |
| POST | `/api/v1/tenants` | Create a tenant |
| GET | `/api/v1/tenants/:id` | Get tenant by ID |
| PATCH | `/api/v1/tenants/:id` | Update tenant |
| DELETE | `/api/v1/tenants/:id` | Delete tenant |
| POST | `/api/v1/auth/register` | Register a user |
| POST | `/api/v1/auth/login` | Login user |
| POST | `/api/v1/auth/refresh` | Refresh access token |
| POST | `/api/v1/auth/logout` | Logout (revoke refresh token) |
| POST | `/api/v1/auth/forgot-password` | Request password reset |
| POST | `/api/v1/auth/reset-password` | Reset password |
| POST | `/api/v1/auth/verify-email` | Verify email |
| GET | `/api/v1/auth/me` | Get current user profile |
| GET | `/api/v1/users` | List users (tenant-scoped, paginated, search, filter, sort) |
| GET | `/api/v1/users/:id` | Get user by ID (tenant-scoped) |
| PATCH | `/api/v1/users/:id` | Update user (firstName, lastName, status) |
| DELETE | `/api/v1/users/:id` | Delete user (self-deletion prevented) |
| GET | `/api/v1/roles` | List roles (tenant-scoped) |
| GET | `/api/v1/roles/:id` | Get role by ID |
| POST | `/api/v1/roles` | Create role |
| PATCH | `/api/v1/roles/:id` | Update role |
| DELETE | `/api/v1/roles/:id` | Delete role |
| POST | `/api/v1/roles/:id/permissions` | Assign permissions to role |
| GET | `/api/v1/permissions` | List permissions (tenant-scoped) |
| GET | `/api/v1/permissions/:id` | Get permission by ID |
| GET | `/api/v1/users/:id/roles` | Get user roles |
| POST | `/api/v1/users/:id/roles` | Assign roles to user |
| POST | `/api/v1/categories` | Create category |
| GET | `/api/v1/categories` | List categories (paginated) |
| PATCH | `/api/v1/categories/:id` | Update category |
| DELETE | `/api/v1/categories/:id` | Delete category |
| POST | `/api/v1/products` | Create product |
| GET | `/api/v1/products` | List products (paginated, search, filters) |
| GET | `/api/v1/products/:id` | Get product by ID |
| PATCH | `/api/v1/products/:id` | Update product |
| DELETE | `/api/v1/products/:id` | Delete product |
| POST | `/api/v1/products/:productId/categories` | Set product categories |
| GET | `/api/v1/products/:productId/categories` | Get product categories |
| POST | `/api/v1/products/:productId/variants` | Create variant (SKU/barcode tenant-scoped) |
| GET | `/api/v1/products/:productId/variants` | List variants |
| GET | `/api/v1/products/:productId/variants/:variantId` | Get variant |
| PATCH | `/api/v1/products/:productId/variants/:variantId` | Update variant |
| DELETE | `/api/v1/products/:productId/variants/:variantId` | Delete variant |
| PUT | `/api/v1/products/:productId/variants/:variantId/attributes` | Assign variant attributes |
| GET | `/api/v1/products/:productId/variants/:variantId/attributes` | List variant attributes |
| POST | `/api/v1/products/:productId/images` | Upload product image (local StorageService) |
| GET | `/api/v1/products/:productId/images` | List product images |
| PATCH | `/api/v1/products/:productId/images/:imageId` | Update product image metadata |
| DELETE | `/api/v1/products/:productId/images/:imageId` | Delete product image (DB + storage) |
| POST | `/api/v1/products/:productId/variants/:variantId/images` | Upload variant image |
| GET | `/api/v1/products/:productId/variants/:variantId/images` | List variant images |
| POST | `/api/v1/attributes` | Create attribute definition |
| GET | `/api/v1/attributes` | List attributes |
| PATCH | `/api/v1/attributes/:id` | Update attribute |
| DELETE | `/api/v1/attributes/:id` | Delete attribute |
| POST | `/api/v1/attributes/:attributeId/values` | Create attribute value |
| GET | `/api/v1/attributes/:attributeId/values` | List attribute values |
| PATCH | `/api/v1/attributes/:attributeId/values/:valueId` | Update attribute value |
| DELETE | `/api/v1/attributes/:attributeId/values/:valueId` | Delete attribute value |
| POST | `/api/v1/warehouses` | Create warehouse |
| GET | `/api/v1/warehouses` | List warehouses |
| GET | `/api/v1/warehouses/:id` | Get warehouse by ID |
| PATCH | `/api/v1/warehouses/:id` | Update warehouse |
| DELETE | `/api/v1/warehouses/:id` | Delete warehouse |
| GET | `/api/v1/inventory` | List inventory (paginated, warehouse/variant/sku filters) |
| GET | `/api/v1/inventory/variants/:variantId` | Get variant inventory across warehouses |
| POST | `/api/v1/inventory/adjust` | Adjust stock (positive/negative, movement) |
| POST | `/api/v1/inventory/transfer` | Transfer stock between warehouses (atomic) |
| GET | `/api/v1/inventory/movements` | List inventory movements (paginated, filtered) |
| GET | `/api/v1/inventory/low-stock` | List low-stock inventory (threshold default 10) |
| POST | `/api/v1/orders` | Create order (variant/SKU, warehouse, snapshots, atomic inventory) |
| GET | `/api/v1/orders` | List orders (paginated, status filter) |
| GET | `/api/v1/orders/:id` | Get order with items and snapshots |
| PATCH | `/api/v1/orders/:id/status` | Update order status (state machine) |
| POST | `/api/v1/orders/:id/cancel` | Cancel order (inventory restoration) |
| GET | `/api/v1/orders/:id/history` | Get order status history |
| POST | `/api/v1/payments/create` | Create payment for order (server-authoritative amount, tenant ownership, pending guard) |
| POST | `/api/v1/payments/confirm` | Confirm payment (controlled transition PENDING/PROCESSING → COMPLETED/FAILED) |
| POST | `/api/v1/payments/webhook` | Provider webhook (HMAC signature, idempotent via DB uniqueness) |
| GET | `/api/v1/payments/:id` | Get payment with transactions/refunds (tenant-scoped) |
| POST | `/api/v1/payments/:id/refund` | Refund payment (refundable balance, partial/full → PARTIALLY_REFUNDED/REFUNDED) |
| GET | `/api/v1/audit-logs` | List audit logs (tenant-scoped, paginated, filters: action/resource/resourceId/userId/from/to) |
| GET | `/api/v1/activity-logs` | List activity logs (tenant-scoped, paginated, filters: action/userId/from/to) |
| GET | `/api/v1/activity-logs/:id` | Get activity log by ID (tenant-scoped, 404 if other tenant) |
| GET | `/api/v1/notifications` | List notifications (tenant/user-scoped, paginated, filters: isRead/type/channel, newest-first) |
| PATCH | `/api/v1/notifications/:id/read` | Mark one notification as read (idempotent, 404 if other tenant) |
| POST | `/api/v1/notifications/read-all` | Mark all visible notifications as read (idempotent) |
| GET | `/api/v1/notification-preferences` | List notification preferences (4 channels, tenant/user-scoped, defaults) |
| PATCH | `/api/v1/notification-preferences` | Update notification preferences (upsert IN_APP/EMAIL/SMS/PUSH) |
| GET | `/api/v1/jobs/status` | Jobs status (enabled, workersStarted, queues) |
| POST | `/api/v1/jobs/notifications` | Enqueue notification job (tenant-scoped, `title`/`message` required, returns `202` when queued or `200` fallback) |
| POST | `/api/v1/jobs/cleanup` | Enqueue cleanup expired tokens (tenant-scoped, `202`/`200` fallback) |
| POST | `/api/v1/jobs/reports` | Enqueue report job (deferred stub, `202`, Phase 18) |
| POST | `/api/v1/jobs/analytics` | Enqueue analytics job (deferred stub, `202`, Phase 18) |
| GET | `/api/v1/dashboard/overview` | Dashboard overview (orchestrated aggregation, `dashboard:read`, `x-cache: HIT|MISS`) |
| GET | `/api/v1/analytics/overview` | Analytics overview (tenant-scoped, `analytics:read`, `x-cache: HIT|MISS`) |
| GET | `/api/v1/analytics/sales` | Sales analytics (tenant-scoped, date range, groupBy, category/product/status filters, `analytics:read`, `x-cache: HIT|MISS`) |
| GET | `/api/v1/analytics/orders` | Order analytics (tenant-scoped, date range, groupBy, status filter, `analytics:read`, `x-cache: HIT|MISS`) |
| GET | `/api/v1/analytics/inventory` | Inventory analytics (tenant-scoped, warehouse/category/product/status filters, `analytics:read`, `x-cache: HIT|MISS`) |
| GET | `/api/v1/analytics/customers` | Customer analytics (tenant-scoped, date range, groupBy, top customers, `analytics:read`, `x-cache: HIT|MISS`) |
| GET | `/api/v1/analytics/revenue` | Revenue analytics (tenant-scoped, date range, groupBy, gross/refund/net, `analytics:read`, `x-cache: HIT|MISS`) |
| GET | `/api/v1/products/:productId/images/:imageId/file` | Stream product image bytes (private, `product:read`, tenant-scoped `storageKey`, 403 cross-tenant, 401 unauth) |
| GET | `/api/v1/products/:productId/images/:imageId/signed-url` | Generate signed URL (private, `product:read`, HMAC 900s or SigV4, no credentials in URL) |
| GET | `/api/v1/storage/signed` | Stream via signed URL (no auth, `?key=&expires=&signature=` HMAC/SigV4 verified, 403 tampered/expired, 404 not found) |
| GET | `/api/v1/storage/file` | Stream via authenticated tenant check (Bearer, `?key=`, 403 cross-tenant) |
| GET | `/api-docs/` | Swagger UI (public, OpenAPI 3.0.3, Try it out) |
| GET | `/api-docs.json` | OpenAPI JSON (public, `openapi:3.0.3`, 81 paths, 115 ops) |
| GET | `/openapi.json` | OpenAPI JSON alias (public) |
| GET | `/api/v1/openapi.json` | OpenAPI JSON alias under prefix (public) |

The same health endpoints are also exposed under `/api/v1/health`, although infrastructure probes should use the root `/health` routes.

**Storage access policy:** Local storage is **PRIVATE** — no `express.static` for `/storage`. Direct `GET /storage/...` →404. Bytes only via `.../file` (Bearer) or `.../signed` (HMAC, 900s). S3 is **PRIVATE-by-default** (bucket ACL private); `getUrl()` is public only if bucket configured public, otherwise `getSignedUrl()` SigV4 query is required. Tenant-scoped keys (`tenants/{tenantId}/...` + `uuid_` prefix) alone do NOT make objects private — bucket ACL + signed URL + application `tenantId` check do. Credentials never reach client.

Successful responses use `{ "success": true, "data": ..., "message": "..." }`. Errors include `{ "success": false, "error": ..., "requestId": "..." }`. Send an `X-Request-Id` header to supply your own trace identifier; otherwise one is generated.

## Docker Operations

All commands run from the repository root (where `docker-compose.yml` lives).

#### Start

```bash
docker compose up -d
```

Builds (if needed), creates the network/volumes, starts `postgres` and `redis`, waits for them to become healthy, runs `migrate` (`prisma migrate deploy`), then starts `api` and `worker`.

#### Status

```bash
docker compose ps
```

Shows each service state. Expect `postgres` and `redis` `healthy`, `migrate` `Exit 0` (completed), `api` and `worker` `healthy`/`running`. Use `docker compose ps -a` to also show the completed `migrate` container.

#### Logs

```bash
docker compose logs -f
docker compose logs -f api
docker compose logs -f worker
docker compose logs -f postgres
docker compose logs -f redis
```

Follow all services or a single service. For the one-shot migration output:

```bash
docker compose logs migrate
```

#### Rebuild

After changing `Dockerfile`, dependencies, or `prisma/schema.prisma`:

```bash
docker compose build
docker compose up -d
```

For a clean rebuild without cache (e.g., after base image or native dependency changes like `argon2`):

```bash
docker compose build --no-cache
docker compose up -d
```

#### Stop

```bash
docker compose down
```

Stops and removes containers and the default network. **It does not remove persistent volumes** — PostgreSQL data (`pgdata`) and Redis data (`redisdata`) are retained.

To also remove volumes (destructive):

```bash
docker compose down -v
```

**Warning:** `docker compose down -v` removes the named volumes and **destroys persisted PostgreSQL/Redis data**. Only use it when you intentionally want to reset the database. For a production host, prefer managed PostgreSQL/Redis or external volume backups (see `docs/DEPLOYMENT.md`). The CI `migration-validation` job tests a fresh empty DB via a disposable container, which is the safe pattern for validating `migrate deploy` without touching local volumes.

## Local Node Development — Alternative Workflow

**Docker workflow** = recommended full PulseOps stack (API + worker + PostgreSQL + Redis + migrations). Use [Quick Start — Docker](#quick-start--docker) and [Docker Operations](#docker-operations).

**Native Node workflow** = alternative when PostgreSQL and Redis are provided separately (local installs or managed services). Use it only when you do not want the Docker-provided dependencies.

All commands below are valid `package.json` scripts (or `npx` Prisma invocations). Only commands that actually exist in `package.json` are documented.

```bash
npm run dev              # start API with --watch (src/app/server.js)
npm start                # start API (src/app/server.js)
npm test                 # run Jest suite (node --experimental-vm-modules, --runInBand)
npm run lint             # run ESLint (must be 0 errors, 0 warnings)
npm run prisma:validate  # validate prisma/schema.prisma
npm run prisma:generate  # generate Prisma Client
npx prisma migrate status # check migration state (Database schema is up to date!)
npm run db:seed           # seed foundational roles/permissions (idempotent)
```

Additional workflow notes:

* `npx prisma migrate deploy` is the production migration command (never `migrate dev` in production or in compose). See `docs/DEPLOYMENT.md`.
* `docker compose config --quiet` validates the compose files without starting services.
* Native mode still requires `DATABASE_URL` and `REDIS_URL` in `.env` pointing to your separately provided services; degraded mode (`FAIL_ON_DEPENDENCY_ERROR=false`) keeps liveness available when a dependency is temporarily down, but production should use `FAIL_ON_DEPENDENCY_ERROR=true`.

## CI/CD

Pipeline (` .github/workflows/ci.yml`, `runs-on: ubuntu-latest`, Node 22):

```text
install
→ lint
→ test
→ build
→ migration validation
→ deployment
```

| Stage | What it does |
| --- | --- |
| **install** | `npm ci` (reproducible, `package-lock.json` exact), caches `node_modules` for downstream jobs. |
| **lint** | `npm run lint --silent` (0 errors, 0 warnings). Needs `install`. |
| **test** | Disposable PostgreSQL 16 + Redis 7 services (`pg_isready` / `redis-cli ping` health checks). `npx prisma generate` → `npx prisma migrate deploy` → `npm test --silent` → `npx prisma migrate status`. Needs `install`. |
| **build** | Needs `lint` + `test`. `npx prisma validate` (with `DATABASE_URL`) + `npx prisma generate` + `docker compose config --quiet` + `docker compose -f docker-compose.yml -f docker-compose.prod.yml config --quiet` + `docker build -t pulseops-backend:ci` + verifies non-root user `pulseops` and `.dockerignore` excludes `.env`. |
| **migration validation** | Needs `build`. Fresh empty PostgreSQL 16; `npm ci` + `npx prisma validate` + `npx prisma migrate deploy` (production command, never `dev`) + `npx prisma migrate status` + probe `SELECT tablename FROM pg_tables`; asserts no `npx prisma migrate dev` in workflow (guard uses `npx [p]risma` trick to avoid self-match). |
| **deployment** | Needs `migration validation`. Runs only on `push` to `main`/`master` under `environment: production`. Validates `docker compose` configs and `prisma validate`, checks required secrets (`DATABASE_URL`, `REDIS_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` — plus `PAYMENT_WEBHOOK_SECRET`, `S3_*` when S3), then provider-agnostic placeholder gated on `vars.DEPLOY_PROVIDER` + `secrets.DEPLOY_HOST` (e.g., `fly`, `render`, `railway`, `aws`, `gcp`, `azure`, `custom`). **No real production deployment is claimed.** See `docs/DEPLOYMENT.md`. |
| **deployment (dry-run)** | Needs `migration validation`. Runs on `pull_request` or non-`main` pushes. Validates compose configs without secrets. |

**Last verified remote run:** All required checks **passed** (`install`, `lint`, `test`, `build`, `migration validation`). The `deployment` job was entered but the `deployment dry-run` variant was **SKIPPED** (expected — dry-runOnly runs on PRs/non-main pushes; the main push runs the `deployment` stage gated on secrets). The dry-run is not described as passed.

## Verification

Latest verified results (Phase 23 — HUMAN VERIFIED):

* **Full test suite:** 905/905 passed (00 suites, no failures) — `npm test` via `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runInBand`
* **Phase 23 deployment tests:** 56 passed (Dockerfile, `.dockerignore`, `docker-compose.yml`, worker entrypoint, migrations, CI workflow, environment/storage contracts, security, health)
* **Phase 20 regression:** passed (53/53 security tests)
* **Phase 21 regression:** passed (51 unit + 12 E2E + 24 extended = 87 new; full 833 per-suite evidence preserved)
* **Phase 22 regression:** passed (16 dedicated Swagger/OpenAPI tests; 81 path keys, 115 operations, 115 unique operationIds, 26 schemas, bearerAuth, 21 tags)
* **Docker build:** passed (`docker build -t pulseops-backend:ci --file Dockerfile .`)
* **Docker Compose runtime:** passed (`docker compose up -d` → `migrate` completed, `api` + `worker` running)
* **PostgreSQL:** healthy (`pg_isready -U pulseops -d pulseops`)
* **Redis:** healthy (`redis-cli ping` → `PONG`)
* **Migrations:** passed (`npx prisma validate` → Valid, `npx prisma migrate status` → Database schema is up to date, 9 migrations)
* **API health:** passed (`GET /health` 200, `GET /health/db` 200, `GET /health/redis` 200)
* **Worker:** healthy (process `node src/worker.js` alive, BullMQ workers started, graceful `shutdownJobs` OK)
* **Graceful shutdown:** passed (SIGTERM/SIGINT → `tini` PID 1 → `server.close()` → `shutdownJobs()` → `disconnectRedis`/`disconnectDatabase`, 10s hard timeout)
* **GitHub Actions required CI checks:** passed (`install` → `lint` → `test` → `build` → `migration validation` → `deployment` on main)
* **Deployment dry-run:** skipped (expected on `main` push — dry-run only runs on PRs/non-main; not claimed as passed)

Supporting evidence preserved from earlier phases (now reconciled, not stale):

* Phase 14 cache 27/27, Phase 15 jobs 44/44, Phase 16 integrations 58/58, Phase 17 orchestration 22/22, Phase 18 analytics 45/45 — all still passing within the 905 total.
* Lint: `npm run lint` → 0 errors, 0 warnings
* Prisma: `npx prisma validate` → Valid, `npx prisma generate` → Success, `npx prisma migrate status` → up to date (9 migrations; no Phase 23 schema change)
* Production migration command is `npx prisma migrate deploy` everywhere (compose `migrate` service, CI `migration validation`); never `migrate dev`.

## Implemented Foundation

- Express API with versioned routing (`/api/v1`)
- Environment validation with Zod
- Prisma/PostgreSQL and Redis connection configuration
- Liveness and dependency health endpoints
- Request IDs, Pino structured logging, centralized errors
- Helmet, CORS allow-list, HPP, compression, JSON size limits, and rate limiting
- Graceful shutdown for HTTP, Prisma, and Redis clients
- Jest/Supertest integration coverage for health and error behavior
- **Multi-tenant foundation: Tenant, TenantSettings, TenantDomain with CRUD APIs**
- **Core relational schema: 31 Phase 03 models with tenant isolation, Decimal money, TIMESTAMPTZ(6)**
- **Minimal idempotent seed for foundational roles/permissions**
- **Authentication: JWT (HS256), refresh token rotation, password reset, email verification**
- **Authorization / RBAC: role-based and permission-based access control with tenant isolation**
- **User Management: tenant-scoped user CRUD with pagination, search, filter, sort, status/role filtering**
- **Product Management: business-agnostic product catalog — categories, category hierarchy, products, product/category relationships, product variants (tenant-scoped SKUs/barcodes), flexible attributes/values, variant attribute assignment, product & variant images via local StorageService with tenant-scoped keys, product filtering (search, category, status, price, SKU/barcode, attribute), pagination, RBAC, tenant isolation, validation, 78 integration tests**
- **Inventory Management: variant/SKU-level inventory (`product_variant_id` + `warehouse_id`), warehouse-specific quantities, stock adjustments (positive/negative with insufficient-stock protection), atomic transfers, movement history (`quantity_before`/`quantity_changed`/`quantity_after`), low-stock reporting (threshold default 10), PostgreSQL transactions with `SELECT ... FOR UPDATE` row locking, non-negative enforcement (DB CHECK), tenant isolation, RBAC (`inventory:read`/`inventory:update`), Zod validation, warehouse management supporting inventory, concurrency-safe updates, 36 integration tests**
- **Order Management: order lifecycle management — variant/SKU-centric ordering (`product_variant_id`), immutable commercial snapshots (`product_name_snapshot`, `variant_name_snapshot`, `attribute_snapshot`, `sku_snapshot`, `unit_price`, `quantity`, `discount`, `tax`, `line_total`), server-authoritative Decimal pricing, atomic order creation (order + items + inventory `ORDER_RESERVATION` movements + status history `PENDING` in one transaction), PostgreSQL `SELECT ... FOR UPDATE` concurrency protection (10 concurrent qty 1 from 5 → 5 success), status lifecycle (DRAFT→PENDING→CONFIRMED→PROCESSING→SHIPPED→DELIVERED, terminal CANCELLED/REFUNDED), cancellation with atomic `ORDER_RELEASE` restoration, tenant isolation, RBAC (`order:create`/`order:read`/`order:update`/`order:cancel`), Zod validation, business-agnostic, 34 integration tests**
- **Payment & Transaction Processing: business-agnostic payment architecture anchored to Orders (`Order → Payment → Payment Transaction → Refund`), processor-agnostic provider abstraction — no industry-specific catalog concepts. Order-derived server-authoritative Decimal amounts, duplicate pending guard, controlled state transitions (`PENDING`↔`PROCESSING`→`COMPLETED`/`FAILED`/`CANCELLED`, `COMPLETED`/`PARTIALLY_REFUNDED`→`REFUNDED`/`PARTIALLY_REFUNDED`), frontend cannot inject arbitrary status, `POST /payments/create`/`/confirm`/`/webhook` + `GET /payments/:id` + `POST /payments/:id/refund`, HMAC-SHA256 webhook signature (`x-webhook-signature`/`x-payment-signature`), database-enforced webhook idempotency (`payment_webhook_events` with `@@unique([tenantId, eventId])` + `@@unique([eventId])` + partial unique provider indexes, `INSERT` conflict → `P2002` → safely ignore), concurrent duplicate safe (5 parallel identical webhooks → 1 effect), refunds with refundable-balance check and audit-preserving transactions, `SELECT ... FOR UPDATE` row locking with Prisma `$transaction` rollback, tenant isolation via `req.context.tenantId`, RBAC (`payment:create`/`payment:confirm`/`payment:read`/`payment:refund`), 40 integration tests**
- **Audit & Activity Logs: reusable audit/activity logging for important system actions. Existing Phase 3 models `audit_logs`/`activity_logs` reused (no duplicate tables, no new migration). Fields: `tenant_id`, `user_id`, `action`, `resource`, `resource_id`, `old_value`, `new_value`, `ip_address`, `user_agent`, `created_at` (audit) / `action`, `description`, `metadata` (activity). Reusable module `src/modules/audit/` (`sanitize`, `repository`, `service`, `controller`, `validation`, `routes`) via `auditService.logAudit`/`logActivity` abstraction for future modules. Sensitive-data protection via recursive sanitization (`[REDACTED]` for passwords/hashes/tokens/secrets). Tenant isolation via `req.context.tenantId`; cross-tenant access prevented. APIs: `GET /audit-logs`, `GET /activity-logs`, `GET /activity-logs/:id` (authentication, RBAC `audit:read`/`activity:read`, pagination, filtering, validation). Integrated mutations: `PATCH /users/:id`, `DELETE /users/:id`, `POST /orders`, `PATCH /orders/:id/status`, `POST /orders/:id/cancel` each atomically creates audit/activity records in the same Prisma `$transaction`. 35 Phase 11 integration tests**
- **Notifications: notification domain reusing existing Phase 3 models `notifications`/`notification_preferences`/`notification_templates` and enums `NotificationType`/`NotificationChannel` (no new tables, no Phase 12 migration). Module `src/modules/notifications/` (`repository`, `validation`, `service`, `controller`, `routes`) via provider-independent `NotificationService` abstraction (`createNotification`/`notify`/`dispatchViaChannel`). Tenant/user-scoped visibility (`tenant_id` + `user_id` or `null` tenant-wide), pagination (`page` default 1 `limit` 20 max 100), filtering (`isRead`/`type`/`channel`), newest-first ordering, RBAC `notification:read`/`notification:update`, tenant isolation, validation, mass-assignment protection. APIs: `GET /notifications`, `PATCH /notifications/:id/read` (idempotent), `POST /notifications/read-all` (idempotent), `GET /notification-preferences`, `PATCH /notification-preferences` (upsert). Channels: `IN_APP`/`EMAIL`/`SMS`/`PUSH` (concepts only, no external provider delivery). 53 Phase 12 integration tests**
- **WebSockets / Real-Time: Socket.IO integrated with the existing HTTP server (`http.createServer(app)` + `createSocketServer(server)`), provider-independent `realtime.service.js` abstraction (`emitRealtime` + `REALTIME_EVENTS` + recursive sanitization), socket authentication reusing existing JWT verification (`verifyAccessToken`, `sub`/`tenantId`/`sessionId` required, `ACTIVE` user/tenant `ACTIVE|TRIAL` check), server-derived `socket.context={userId, tenantId, sessionId}`, tenant-aware rooms `tenant:{tenantId}` and `user:{userId}` auto-joined on connection, guarded `join`/`subscribe` (only own rooms allowed), five events `order.created`/`order.updated`/`inventory.low_stock`/`payment.completed`/`notification.created` routed tenant-scoped or user-specific, minimal payloads with sanitization, lifecycle `connection`/`disconnect`/`error` with Pino logging and clean `io.close()` shutdown. 32 Phase 13 integration tests**
- **Redis Caching: reusable cache abstraction `src/common/cache/` (`cache.config.js` TTL `TENANT 300s`/`TENANT_SETTINGS 300s`/`PERMISSIONS 300s`/`PERMISSIONS_USER 300s`/`PRODUCT_LIST 60s` + `CACHE_PREFIX pulseops:v1`, `cache.keys.js` tenant-safe keys via `createHash` of normalized query, `cache.service.js` `CacheService` `get`/`set`/`del`/`delByPattern`/`getOrSet` with graceful `logger.warn` fallback), cache-aside, PostgreSQL authoritative, tenant-safe keys, invalidation after DB commit, Redis failure fallback, 27 Phase 14 integration tests**
- **Background Jobs / BullMQ: `API → Queue → Worker → Processor → Database / External Service`. Six queue abstractions (`src/jobs/`): `notificationQueue`, `cleanupQueue`, `webhookQueue` (real) and `emailQueue`/`reportQueue`/`analyticsQueue` (deferred stubs where noted). Jobs: `send-notification`, `cleanup-expired-tokens`, `process-webhook` (HMAC verified before enqueue and re-verified in processor, DB `@@unique` idempotency), BullMQ `^5.10.2` on `REDIS_URL` prefix `pulseops:v1:queue`, worker lifecycle via `src/jobs/workers/index.js` (webhook concurrency 10, cleanup 1, others 5, lock 30s), `initJobs()`/`startWorkers()` and `shutdownJobs()` → `stopWorkers()` + `closeAllQueues()` + `disconnectBullMqRedis()` in `src/app/server.js`. Job defaults: notification 3 attempts exponential 1000ms, cleanup 2 exponential 2000ms, webhook 5 exponential 1000ms; permanent vs transient errors. 44 Phase 15 integration tests**
- **External API Integrations: provider-independent integration layer `Controller -> Service -> Integration Adapter -> External API` for Payment, Email, SMS, Shipping, Maps, Object Storage; Payment Mock/Http (charge/refund, idempotency-aware retry), Email Mock/Http via EmailService + BullMQ, SMS Mock/Http, Shipping Mock/Http, Maps Mock/Http, Object Storage via StorageService (`LocalStorageProvider` + `S3StorageProvider` real S3 REST SigV4 + `MockS3StorageProvider` test-only, `STORAGE_PROVIDER` local/s3, tenant-scoped keys, traversal protection); shared HTTP timeout via AbortController, idempotency-aware retry, normalized IntegrationError codes, no secret leakage; 58 integration tests**
- **API Orchestration (Phase 17): Dashboard orchestration `Dashboard Route → Controller → Service → 6 domain Services → Repositories → PostgreSQL` aggregating `orders/inventory/payments/users/notifications/products` via `Promise.allSettled`, tenant-scoped `dashboard:read`, `x-cache: HIT|MISS` with `CacheService` reuse `pulseops:v1:tenant:{tenantId}:dashboard:overview` TTL 60s, parallel + partial-failure handling, 22 integration tests**
- **Analytics & Reporting (Phase 18): Route → Controller → Service → Repository → PostgreSQL using existing transactional data (no separate analytics DB); 6 APIs `GET /api/v1/analytics/overview|sales|orders|inventory|customers|revenue` tenant-isolated via `req.context.tenantId` + `authorize('analytics:read')`, filters `from/to` (YYYY-MM-DD UTC) `groupBy=day|week|month` (UTC deterministic via `date_trunc(... AT TIME ZONE 'UTC')`), `category`/`product`/`status`/`warehouseId`, `page`/`limit`; money `Decimal(12,2)` formatted `toFixed(2)`; `CacheService` reuse tenant-scoped analytics keys TTL 60s. 45 integration tests**
- **Performance Optimization (Phase 19): 4 approved indexes (`ProductVariant (tenantId,price)`, `ProductVariant (tenantId,status,createdAt)`, `Inventory (tenantId,quantity)`, `Order (tenantId,customerId,createdAt)`), selective field loading for orders list, compression tuned (threshold 512 level 6), Redis TTL tuned (PRODUCT_LIST 300s, DASHBOARD 300s, ANALYTICS 180-300s), no new APIs, no schema changes beyond indexes, 693 full regression preserved**
- **Security Hardening (Phase 20): Helmet (`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, HSTS 31536000 production, CSP/COEP deliberately disabled for JSON API), CORS explicit allow-list, global (100/15m) + auth (20/15m) + webhook (100/1m) rate limiting, Zod strict validation, `SELECT ... FOR UPDATE` + allow-listed sort + `assertSafeTrunc` SQL injection protection, XSS JSON-only, CSRF Bearer-only, request-size `1mb` + 10MB multer, file upload + Local PRIVATE + S3 PRIVATE-by-default + signed URLs (HMAC/SigV4), JWT HS256 pinned, refresh rotation atomic `revokedAt`, Argon2id, webhook raw-body HMAC-SHA256 `timingSafeEqual`, audit sanitize `[REDACTED]`, logger redact, 53 security tests**
- **Complete Testing (Phase 21): Full-system validation. 51 unit + 12 E2E + 24 extended integration (multi-tenant matrix, transaction/rollback, concurrent webhook idempotency 5→1, cache tenant keys & fallback, queue tenant context, storage isolation, error handling 401/403/400/SQL injection). Total 87 new + 746 baseline = 833 per-suite evidence; Phase 20 security regression 53/53 still PASS.**
- **Swagger / OpenAPI Documentation (Phase 22): OpenAPI 3.0.3, `src/docs/` modular spec, 81 path keys, 115 operations, 115 unique operationIds, 26 reusable schemas, `bearerAuth`, 21 tags, Swagger UI at `GET /api-docs/`, OpenAPI JSON at `GET /api-docs.json` / `GET /openapi.json` / `GET /api/v1/openapi.json` (all 200), 100% production route coverage, 573 `$ref` (0 unresolved), request/response/validation/authorization documented, no secrets exposed, 16 dedicated Phase 22 tests**
- **Docker / CI/CD / Deployment (Phase 23 — COMPLETE and HUMAN VERIFIED): Multi-stage `Dockerfile` (`node:22-alpine`, `deps` → `production`, `npm ci`, `prisma generate`, non-root `pulseops`, `tini` PID 1, `wget` healthcheck, `EXPOSE 3000`, no `.env`/credentials baked), `docker-compose.yml` (api + worker + postgres 16 + redis 7 + migrate, `pg_isready`/`redis-cli ping` healthchecks, named volumes `pgdata`/`redisdata`, `service_healthy`/`service_completed_successfully` dependencies, `prisma migrate deploy` only), `docker-compose.prod.yml` production overlay (required secrets via `${VAR:?…}`, `TRUST_PROXY=true`, `FAIL_ON_DEPENDENCY_ERROR=true`, `STORAGE_PROVIDER=s3` default), `src/worker.js` standalone BullMQ worker with graceful shutdown (no HTTP server), `.dockerignore` excludes `.env`/`node_modules`/`storage`/`.git`/`.github`/tests/docs, CI pipeline `install → lint → test → build → migration validation → deployment` (Node 22, `npm ci`, disposable Postgres/Redis, `prisma migrate deploy` fresh-DB validation, `docker build` + `compose config` checks), `docs/DEPLOYMENT.md` production reference (env, secrets, migrations, pooling `connection_limit`/`sslmode`/`PgBouncer`, storage contract `local` vs `s3`, health/readiness, graceful shutdown, logs/monitoring, backups/rollback, HTTPS/reverse proxy), 56 Phase 23 deployment tests, 905/905 full suite**

## Operational Notes

At startup the API attempts to connect to PostgreSQL and Redis, then `initJobs()` starts BullMQ workers (`startWorkers()`; if `REDIS_URL` missing or Redis unreachable, workers are skipped and enqueue falls back to synchronous processing so readiness still degrades gracefully). In development and test, unavailable configured services leave the API running in degraded mode so liveness remains available and readiness returns `503` (Redis outage fallback can reintroduce HTTP latency but preserves correctness). Production fails fast by default; set `FAIL_ON_DEPENDENCY_ERROR=false` only when degraded startup is intentional. On `SIGINT` or `SIGTERM`, the server stops accepting connections, then `shutdownJobs()` gracefully closes workers (allows active jobs to finish, `lockDuration` 30s), closes all queues, disconnects BullMQ Redis, then closes Redis and Prisma cleanly (force exit after 10s if hung). The `Dockerfile` uses `tini` as PID 1 so signals reach Node correctly; `docker compose stop` sends `SIGTERM` then `SIGKILL` after 10s — aligned with the app's 10s timeout. The `worker` (`src/worker.js`) follows the same shutdown sequence but does not create an HTTP server.

## Current Scope

- Phase 01 provides operational infrastructure only.
- Phase 02 provides tenant management and the tenant context foundation.
- Phase 03 provides the complete core relational schema (31 models) with tenant isolation, proper indexes, constraints, Decimal money, and TIMESTAMPTZ(6) timestamps.
- Phase 04 provides authentication (JWT, refresh tokens, password reset, email verification).
- Phase 05 provides role-based and permission-based authorization (RBAC) with tenant isolation.
- Phase 06 provides tenant-scoped user management (CRUD, pagination, search, filter, sort, tenant isolation).
- Phase 07 provides business-agnostic product management (categories, hierarchy, products, product/category relationships, variants with tenant-scoped SKUs/barcodes, flexible attributes/values, variant attributes, product & variant images via local StorageService with tenant-scoped keys, filtering/search/pagination, RBAC, tenant isolation).
- Phase 08 provides variant/SKU-level inventory management (warehouse-specific stock, adjustments, atomic transfers, movement history `quantity_before`/`quantity_changed`/`quantity_after`, low-stock reporting threshold 10, PostgreSQL `SELECT ... FOR UPDATE` transactions, non-negative enforcement, tenant isolation, RBAC `inventory:read`/`inventory:update`, validation, warehouse management supporting inventory, concurrency-safe updates).
- Phase 09 provides order lifecycle management — variant/SKU-centric ordering, immutable snapshots, server-authoritative Decimal pricing, atomic transactions (order + items + inventory `ORDER_RESERVATION` + status history), `SELECT ... FOR UPDATE` concurrency, status state machine (DRAFT→PENDING→CONFIRMED→PROCESSING→SHIPPED→DELIVERED→terminal CANCELLED/REFUNDED), cancellation with `ORDER_RELEASE` restoration, history, RBAC `order:create`/`order:read`/`order:update`/`order:cancel`, tenant isolation, validation, business-agnostic.
- Phase 10 provides Payment & Transaction Processing — business-agnostic payments anchored to Orders, provider-neutral abstraction, server-authoritative amounts, controlled transitions, HMAC webhook signature, DB-enforced idempotency via `payment_webhook_events`, partial unique provider indexes, `SELECT ... FOR UPDATE` transactions/rollback, Decimal money, tenant isolation, RBAC `payment:create`/`payment:confirm`/`payment:read`/`payment:refund`.
- Phase 11 provides Audit & Activity Logs — reusable `audit_logs`/`activity_logs` with tenant isolation, sanitization `[REDACTED]`, `GET /audit-logs`/`GET /activity-logs`/`GET /activity-logs/:id`, RBAC `audit:read`/`activity:read`, atomic `$transaction` integration for 5 important mutations (user update/delete, order create/status/cancel), verified 35/35 Phase 11, 497/497 full with 15000ms timeout.
- Phase 12 provides Notifications — reusable `notifications`/`notification_preferences`/`notification_templates` with tenant/user-scoped visibility, provider-independent `NotificationService` (`createNotification`/`notify`/`dispatchViaChannel`), channels `IN_APP`/`EMAIL`/`SMS`/`PUSH` concepts only, `GET /notifications` pagination/filtering/newest-first, `PATCH /notifications/:id/read` idempotent, `POST /notifications/read-all` idempotent, preferences defaults/upserts via `GET`/`PATCH /notification-preferences`, RBAC `notification:read`/`notification:update`, no external provider delivery, verified 53/53 Phase 12, 497/497 full with 15000ms timeout.
- Phase 13 provides WebSockets / Real-Time — `src/realtime/` with `realtime.service.js` (provider-independent `emitRealtime`, `REALTIME_EVENTS`, recursive sanitization), `socket.auth.js` (JWT `verifyAccessToken`, tenant/user ACTIVE, server-derived `socket.context`), `socket.server.js` (`tenant:{tenantId}`/`user:{userId}` rooms, guarded `join`/`subscribe`, lifecycle `connection`/`disconnect`/`error`, `io.close()` shutdown), HTTP co-existence (`http.createServer(app)` + `initSocketIO`), five events `order.created`/`order.updated`/`inventory.low_stock` (threshold 10)/`payment.completed`/`notification.created` (tenant or user room), minimal payloads, tenant isolation, verified 32/32 Phase 13, 497/497 full with 15000ms timeout, 8 migrations (no new Phase 13 migration), storage local, S3 deferred.
- Phase 14 provides Redis Caching — `src/common/cache/` reusable abstraction (`cache.config.js` `CACHE_TTL`/`CACHE_PREFIX pulseops:v1`, `cache.keys.js` tenant-safe keys with `sanitizeId` + `sha256` hash 16, `cache.service.js` `CacheService` with JSON serialization, `stripSensitive`, `logger.warn` fallback, `getOrSet`/`delByPattern` SCAN), existing `ioredis` reused, cache-aside with TTL 300s tenant/settings/permissions and 60s product lists, PostgreSQL authoritative, tenant isolation, invalidation after DB commit (tenant del both keys, permissions helpers, product lists delByPattern), Redis failure fallback (core DB ops continue), verified 27/27 Phase 14, 524/524 full with 15000ms timeout, 8 migrations (no new Phase 14 migration), dashboard metrics now via dashboard overview cache (see Phase 17).
- Phase 15 provides Background Jobs / BullMQ — `src/jobs/` (`connection.js` dedicated Redis `maxRetriesPerRequest: null`, `jobs.config.js` 6 queues + 6 jobs, `queues/` with `notification`/`cleanup`/`webhook` real + `email`/`report`/`analytics` deferred stubs, `processors/` with `send-notification`→`NotificationService`, `cleanup-expired-tokens` tenant-scoped, `process-webhook`→`PaymentService.handleWebhook` HMAC re-verify, `workers/index.js` 6 workers concurrency webhook10/cleanup1/others5, `index.js` lifecycle), `src/modules/jobs/` (`/api/v1/jobs/*`), `src/app/server.js` init/shutdown, BullMQ `^5.10.2` on `REDIS_URL` prefix `pulseops:v1:queue`, retry 3/2/5 exponential, failed retention 24h no DLQ, at-least-once deterministic jobIds, tenant isolation, sensitive guards, HTTP 202/200 fallback, order→notification fire-and-forget, verified 44/44 Phase 15, 568/568 full (524+44), 8 migrations (no new Phase 15 migration).
- Phase 16 provides External API Integrations — provider-independent `Controller -> Service -> Integration Adapter -> External API` (Payment Mock/Http charge/refund idempotency-aware retry, Email Mock/Http via EmailService + BullMQ processor->service->adapter, SMS Mock/Http, Shipping Mock/Http `getRate`/`createShipment` retry distinction, Maps Mock/Http `geocode`/reverse, Object Storage `StorageService` + `LocalStorageProvider` + `S3StorageProvider` real S3 REST SigV4 + `MockS3StorageProvider` test-only via local HTTP S3 test server no cloud credentials, shared HTTP AbortController timeout + retry + IntegrationError normalization + mapProviderResponse, tenant isolation `req.context.tenantId`, traversal, HMAC `PAYMENT_WEBHOOK_SECRET`, env secrets, logger redact, no credentials in queue).
- Phase 17 provides API Orchestration — GET /api/v1/dashboard/overview orchestrated aggregation via Dashboard Route → Dashboard Controller → Dashboard Service → OrderService/InventoryService/PaymentService/UserService/NotificationService/ProductService → existing repositories → Prisma/PostgreSQL (DashboardService is orchestration only, no direct Prisma; six domain services expose getOverview(tenantId) via service/repository; tenant-scoped, req.context.tenantId, dashboard:read, client tenantId blocked, no HTTP calls, Promise.allSettled parallel, partial-failure markers / all-fail error, {success,data,message} + x-cache: HIT|MISS, Redis CacheService reuse pulseops:v1:tenant:{tenantId}:dashboard:overview TTL 60s, 0 migrations / 0 schema changes, 8 migrations current, 22/22).
- Phase 18 provides Analytics & Reporting — 6 analytics APIs (overview, sales, orders, inventory, customers, revenue) via Route → Controller → Service → Repository → PostgreSQL using existing transactional data (no separate analytics DB); tenant-scoped via req.context.tenantId + authorize('analytics:read'); filters from/to (YYYY-MM-DD UTC), groupBy=day|week|month (UTC deterministic via date_trunc AT TIME ZONE 'UTC'), category/product/status/warehouseId, page/limit; client tenantId ignored; money Decimal formatted to 2dp; grossRevenue = completed payments createdAt in range; totalRefunded = completed refunds createdAt in range; netRevenue = gross - refunded; CacheService reuse tenant-scoped analytics keys TTL 60s; 45 dedicated tests, 693 full regression (19 suites), 0 migrations, 8 migrations current.
- Phase 19 provides Performance Optimization — 4 approved indexes (`ProductVariant (tenantId,price)`, `ProductVariant (tenantId,status,createdAt)`, `Inventory (tenantId,quantity)`, `Order (tenantId,customerId,createdAt)`), selective field loading for orders list, compression tuned (threshold 512 level 6), Redis TTL tuned (PRODUCT_LIST 300s, DASHBOARD 300s, ANALYTICS 180-300s), no new APIs, 693 preserved, 9 migrations.
- Phase 20 provides Security Hardening — Helmet/CORS/rate limiting, JWT HS256, refresh rotation, Argon2id, Zod, SQL allow-lists, XSS/CSRF, request-size, file upload + Local PRIVATE/S3 PRIVATE-by-default + signed URLs (HMAC/SigV4), raw-body HMAC webhook, audit sanitize, 53 security tests, 746 full (20 suites), 9 migrations.
- Phase 21 provides Complete Testing — 51 unit + 12 E2E + 24 extended integration, Phase 20 53/53 preserved.
- Phase 22 provides Swagger / OpenAPI Documentation — OpenAPI 3.0.3, 81 paths, 115 operations, `bearerAuth`, 21 tags, Swagger UI at `/api-docs`, JSON at `/api-docs.json`/`/openapi.json`/`/api/v1/openapi.json`, 16 tests.
- Phase 23 provides Docker / CI/CD / Deployment — `Dockerfile` multi-stage, `docker-compose.yml` + `docker-compose.prod.yml`, `src/worker.js` standalone worker, `.dockerignore`, CI pipeline `install → lint → test → build → migration validation → deployment`, `docs/DEPLOYMENT.md` production reference; HUMAN VERIFIED. See [Docker Operations](#docker-operations) and [CI/CD](#cicd).
- Phase 7 local storage now superseded by Phase 16 StorageService abstraction (`LocalStorageProvider` + `S3StorageProvider` real S3 REST SigV4 + `MockS3StorageProvider` test-only); `STORAGE_PROVIDER` local/s3 via `src/config/env.js`, storage keys server-generated `tenants/{tenantId}/products/{productId}/` and `variants/{variantId}/`, tenant-scoped, traversal protection (`..`/`//`/`\`/`:`/`\0`), timeout `STORAGE_TIMEOUT_MS`, retry, normalization.
- PostgreSQL and Redis connectivity are verified locally and via Docker healthchecks. The health endpoints distinguish liveness from dependency readiness.
- Production requires explicit secrets and `docker-compose.prod.yml` overlay; no real deployment is claimed without provider configuration (see `docs/DEPLOYMENT.md`).

## Phase Status

| Phase | Description | Status |
| --- | --- | --- |
| Phase 01 | Project Foundation | ✅ Complete |
| Phase 02 | Multi-Tenant Foundation | ✅ Complete |
| Phase 03 | Database Schema & Migrations | ✅ Complete |
| Phase 04 | Authentication | ✅ Complete |
| Phase 05 | Authorization / RBAC | ✅ Complete |
| Phase 06 | User Management | ✅ Complete |
| Phase 07 | Product Management | ✅ Complete |
| Phase 08 | Inventory Management | ✅ Complete |
| Phase 09 | Order Management | ✅ Complete |
| Phase 10 | Payment & Transaction Processing | ✅ Complete |
| Phase 11 | Audit & Activity Logs | ✅ Complete |
| Phase 12 | Notifications | ✅ Complete |
| Phase 13 | WebSockets | ✅ Complete |
| Phase 14 | Redis Caching | ✅ Complete |
| Phase 15 | Background Jobs / BullMQ | ✅ Complete |
| Phase 16 | External Integrations | ✅ Complete |
| Phase 17 | API Orchestration | ✅ Complete |
| Phase 18 | Analytics & Reporting | ✅ Complete |
| Phase 19 | Performance | ✅ Complete |
| Phase 20 | Security Hardening | ✅ Complete and HUMAN VERIFIED |
| Phase 21 | Complete Testing | ✅ Complete |
| Phase 22 | Swagger/OpenAPI | ✅ Complete |
| Phase 23 | Docker/CI/CD/Deployment | ✅ Complete and HUMAN VERIFIED |

**Phase 23 is COMPLETE and HUMAN VERIFIED — 905/905 full suite, 56/56 Phase 23 deployment tests, Docker build passed, Docker Compose runtime passed (postgres healthy, redis healthy, migrate completed, api health passed, worker healthy, graceful shutdown passed), GitHub Actions required CI checks passed (install → lint → test → build → migration validation → deployment), deployment dry-run skipped (expected on main). No Phase 24 work is claimed or started. Roadmap remains unchanged.**
