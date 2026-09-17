# PulseOps Backend

A production-minded, multi-tenant backend for PulseOps, built with Node.js, Express, PostgreSQL, Prisma, and Redis. The project follows a modular-monolith architecture and is being delivered incrementally so that every foundation layer is tested before business modules are introduced.

**Current status:** Phase 22 — Swagger / OpenAPI Documentation is **COMPLETE (OpenAPI 3.0.3, 81 path keys, 115 operations, 115 unique operationIds, 26 schemas, bearerAuth, 21 tags, Swagger UI at `/api-docs`)**. Phase 21 — Complete Testing is **COMPLETE (87 new tests: 51 unit + 12 E2E + 24 extended)**. Phase 20 — Security Hardening is **COMPLETE and VERIFIED (HUMAN VERIFICATION: PASS)**. Phase 19 — Performance Optimization is **COMPLETE and VERIFIED (HUMAN VERIFICATION: PASS)**.

The full phase-by-phase plan lives in a single source of truth: [`docs/PulseOps_Backend_Codex_Master_Roadmap.md`](docs/PulseOps_Backend_Codex_Master_Roadmap.md).

## Implemented foundation

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
- **Audit & Activity Logs: reusable audit/activity logging for important system actions. Existing Phase 3 models `audit_logs`/`activity_logs` reused (no duplicate tables, no new migration). Fields: `tenant_id`, `user_id`, `action`, `resource`, `resource_id`, `old_value`, `new_value`, `ip_address`, `user_agent`, `created_at` (audit) / `action`, `description`, `metadata` (activity). Reusable module `src/modules/audit/` (`sanitize`, `repository`, `service`, `controller`, `validation`, `routes`) via `auditService.logAudit`/`logActivity` abstraction for future modules. Sensitive-data protection via recursive sanitization (`[REDACTED]` for passwords/hashes/tokens/secrets). Tenant isolation via `req.context.tenantId`; cross-tenant access prevented (activity detail returns 404). APIs: `GET /audit-logs`, `GET /activity-logs`, `GET /activity-logs/:id` (authentication, RBAC `audit:read`/`activity:read`, pagination, filtering, validation). Integrated mutations: `PATCH /users/:id`, `DELETE /users/:id`, `POST /orders`, `PATCH /orders/:id/status`, `POST /orders/:id/cancel` each atomically creates audit/activity records in the same Prisma `$transaction` (mutation + log succeed together, rollback leaves no audit). 35 Phase 11 integration tests**
- **Notifications: notification domain reusing existing Phase 3 models `notifications`/`notification_preferences`/`notification_templates` and enums `NotificationType`/`NotificationChannel` (no new tables, no Phase 12 migration). Module `src/modules/notifications/` (`repository`, `validation`, `service`, `controller`, `routes`) via provider-independent `NotificationService` abstraction (`createNotification`/`notify`/`dispatchViaChannel`). Tenant/user-scoped visibility (`tenant_id` + `user_id` or `null` tenant-wide), pagination (`page` default 1 `limit` 20 max 100), filtering (`isRead`/`type`/`channel`), newest-first ordering, RBAC `notification:read`/`notification:update`, tenant isolation, UUID/pagination/enum validation, mass-assignment protection, safe errors, no sensitive data. APIs: `GET /notifications`, `PATCH /notifications/:id/read` (idempotent), `POST /notifications/read-all` (idempotent), `GET /notification-preferences` (4 channels defaults), `PATCH /notification-preferences` (upsert). Channels: `IN_APP`/`EMAIL`/`SMS`/`PUSH` (concepts only, no external provider delivery). 53 Phase 12 integration tests**
- **WebSockets / Real-Time: Socket.IO integrated with the existing HTTP server (`http.createServer(app)` + `createSocketServer(server)`), provider-independent `realtime.service.js` abstraction (`emitRealtime` + `REALTIME_EVENTS` + recursive sanitization), socket authentication reusing existing JWT verification (`verifyAccessToken`, `sub`/`tenantId`/`sessionId` required, `ACTIVE` user/tenant `ACTIVE|TRIAL` check), server-derived `socket.context={userId, tenantId, sessionId}`, tenant-aware rooms `tenant:{tenantId}` and `user:{userId}` auto-joined on connection, guarded `join`/`subscribe` (only own rooms allowed, another tenant/user/arbitrary blocked, client `tenantId`/`userId` never trusted), five events `order.created`/`order.updated`/`inventory.low_stock`/`payment.completed`/`notification.created` routed tenant-scoped (`tenant` room) or user-specific (`user` room when `userId` available), minimal payloads with recursive sensitive-field sanitization (no passwords/hashes/tokens/secrets/authorization/cookies/stack traces), lifecycle `connection`/`authentication failure`/`disconnect`/`error` with Pino logging and clean `io.close()` shutdown, dependencies `socket.io@^4.8.1` + `socket.io-client@^4.8.1` for tests. Integrations: `src/app/server.js` (`initSocketIO`), `src/modules/orders/orders.service.js` (`order.created`/`order.updated`), `src/modules/inventory/inventory.service.js` (`inventory.low_stock` threshold 10 on adjust/transfer), `src/modules/payments/payments.service.js` (`payment.completed` on confirm/webhook), `src/modules/notifications/notifications.service.js` (`notification.created`). 32 Phase 13 integration tests**
- **Redis Caching: reusable cache abstraction `src/common/cache/` (`cache.config.js` TTL `TENANT 300s`/`TENANT_SETTINGS 300s`/`PERMISSIONS 300s`/`PERMISSIONS_USER 300s`/`PRODUCT_LIST 60s` + `CACHE_PREFIX pulseops:v1`, `cache.keys.js` tenant-safe keys `pulseops:v1:tenant:{tenantId}`/`pulseops:v1:tenant:{tenantId}:settings`/`pulseops:v1:tenant:{tenantId}:permissions:list`/`pulseops:v1:tenant:{tenantId}:permissions:user:{userId}`/`pulseops:v1:tenant:{tenantId}:products:list:{sha256(hash).slice(0,16)}` via `createHash` of normalized `{page,limit,search,status,categoryId,minPrice,maxPrice,sku,barcode,sortBy,sortOrder,attributeFilters(sorted)}`, `cache.service.js` `CacheService` `get`/`set`/`del`/`delByPattern`/`getOrSet` with JSON serialization, `stripSensitive` removing `password`/`passwordHash`/`token`/`secret` etc., graceful `logger.warn` fallback), existing `ioredis`/`src/config/redis.js` reused (no new dependency), cache-aside (GET → hit return / miss → DB via repository → SET), PostgreSQL remains authoritative, tenant-safe key structure (sanitizeId regex, no user-controlled arbitrary keys, no secrets in keys, attributeFilters sorted, hash 16 hex), invalidation after DB commit (`TenantService.update`/`delete` → `del(tenantKey)`+`del(tenantSettingsKey)`, `PermissionService` helpers `invalidateTenantPermissions`+`invalidateUserPermissionsCache`/`invalidateTenantPermissionsCache`, `ProductService` `invalidateProductListCache` via `delByPattern` after create/update/delete/setCategories, failures logged not rolled back), Redis failure fallback (GET fail → null → DB, SET fail → DB result, DEL fail → logged), tenant isolation preserved, RBAC preserved, 27 Phase 14 integration tests**
- **Background Jobs / BullMQ: move slow/non-critical work outside HTTP requests using BullMQ and existing `REDIS_URL`. Architecture `API → Queue → Worker → Processor → Database / External Service`. Six queue abstractions (`src/jobs/`): `notificationQueue`, `cleanupQueue`, `webhookQueue` (real) and `emailQueue` (provider deferred to Phase 16), `reportQueue`/`analyticsQueue` (deferred to Phase 18 — stubs). Real jobs: `send-notification` (reuses Phase 12 `NotificationService.createNotification`, tenant-scoped, sanitized), `cleanup-expired-tokens` (tenant-scoped delete of expired `refresh_tokens`/`password_reset_tokens`/`email_verification_tokens`), `process-webhook` (preserves payment webhook HMAC verification/idempotency — HMAC verified before enqueue and re-verified in processor, uses existing `payment_webhook_events` unique constraints). BullMQ `^5.10.2` reuses `REDIS_URL` with dedicated connection `maxRetriesPerRequest: null`, `enableReadyCheck: false`, queue prefix `pulseops:v1:queue`; worker lifecycle via `src/jobs/workers/index.js` (webhook concurrency 10, cleanup 1, others 5, lock 30s, `completed`/`failed`/`stalled`/`error` logging, graceful `Worker.close()`), startup `initJobs()`/`startWorkers()` and shutdown `shutdownJobs()` → `stopWorkers()` + `closeAllQueues()` + `disconnectBullMqRedis()` in `src/app/server.js`. Job defaults: notification 3 attempts exponential 1000ms, cleanup 2 exponential 2000ms, webhook 5 exponential 1000ms; permanent (400/401/Validation `UnrecoverableError` no retry) vs transient (retry). Failure handling: BullMQ failed-job retention 24h (`removeOnFail: {age: 86400}`), no separate DLQ — failed jobs observable via BullMQ failed state + Pino logs. Idempotency: at-least-once with deterministic jobIds (`notif:<tenant>:<idempotencyKey>`, `webhook:<eventId>`, `cleanup:<tenant>:<YYYY-MM-DD>`) + processor safeguards (notification recent `tenant+referenceType+referenceId+title` 60s skip; webhook DB `@@unique([tenantId,eventId])`; cleanup re-delete no-op). Tenant isolation: `tenantId` server-derived from `req.context`, never trusted from client, carried in job payload, processors scope all DB ops by `tenantId` (`tenantB` cannot read `tenantA` notification/cleanup/webhook), cross-tenant tests 44. Sensitive-data guards reject `password`/`secret`/`token`/`authorization`/`cookie` in job payloads; JWT/refresh/provider secrets never enqueued; structured logs sanitized (`sanitizeForLog`). HTTP: `REDIS_URL` available → async `queue.add` and `202 Accepted` (`POST /payments/webhook` enqueues, `POST /jobs/notifications`/`/jobs/cleanup`), Redis unavailable → synchronous fallback processor and `200` (preserves correctness, can reintroduce latency). Order → notification: `OrderService.create` after committed transaction fire-and-forget `enqueueNotification({tenantId,userId, orderId, idempotencyKey: order:<id>})` logged not rolled back. 44 Phase 15 integration tests `tests/integration/phase15-background-jobs.test.js` (queue creation, enqueueing, processor success/retry/failed/idempotency/tenant/sensitive/log/shutdown/Redis failure/regression/HTTP), verification 44/44 and full regression 568/568 (16 suites, 524+44), lint 0, Prisma valid, 8 migrations up-to-date (no Phase 15 migration)**
- **External API Integrations: provider-independent integration layer `Controller -> Service -> Integration Adapter -> External API` for Payment, Email, SMS, Shipping, Maps, Object Storage; Payment Mock/Http (charge/refund, idempotency-aware retry, state machine/HMAC preserved), Email Mock/Http via EmailService + BullMQ `queue processor -> service -> adapter` (retry-aware), SMS Mock/Http, Shipping Mock/Http (`getRate` idempotent retry vs `createShipment` no retry), Maps Mock/Http (`geocode`/reverse), Object Storage via StorageService (`LocalStorageProvider` + `S3StorageProvider` real S3 REST SigV4 + `MockS3StorageProvider` test-only, `STORAGE_PROVIDER` local/s3, tenant-scoped keys, traversal protection, timeout/retry/normalization); shared HTTP timeout via AbortController, idempotency-aware retry, normalized IntegrationError codes, response mapping, no secret leakage; 58 integration tests**
- **API Orchestration (Phase 17): Dashboard orchestration `Dashboard Route → Controller → Service → 6 domain Services → Repositories → PostgreSQL` aggregating `orders/inventory/payments/users/notifications/products` via `Promise.allSettled`, tenant-scoped `dashboard:read`, `x-cache: HIT|MISS` with `CacheService` reuse `pulseops:v1:tenant:{tenantId}:dashboard:overview` TTL 60s, parallel + partial-failure handling, no direct Prisma, no internal HTTP, 22 integration tests**
- **Analytics & Reporting (Phase 18 — COMPLETE and VERIFIED): Route → Controller → Service → Repository → PostgreSQL using existing transactional data (no separate analytics DB); 6 APIs `GET /api/v1/analytics/overview|sales|orders|inventory|customers|revenue` tenant-isolated via `req.context.tenantId` + `authorize('analytics:read')`, filters `from/to` (YYYY-MM-DD UTC) `groupBy=day|week|month` (UTC deterministic via `date_trunc(... AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`), `category`/`product`/`status`/`warehouseId`, `page`/`limit`, client `tenantId` ignored; money `Decimal(12,2)` formatted `toFixed(2)`; revenue `grossRevenue` = completed payments `createdAt` in range, `totalRefunded` = completed refunds `createdAt` in range, `netRevenue = gross - refunded`; `CacheService` reuse tenant-scoped `pulseops:v1:tenant:{tenantId}:analytics:{endpoint}:{hash}` TTL 60s, miss/hit/fallback, `stripSensitive`; 45 dedicated + 693 full (19 suites) tests, 0 lint, 8 migrations**
- **Performance Optimization (Phase 19 — COMPLETE and VERIFIED): DB indexes, N+1 elimination, pagination, compression, caching review; no new APIs, no schema changes, 693 full regression preserved**
- **Security Hardening (Phase 20 — COMPLETE and VERIFIED): Helmet (`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, HSTS 31536000 production, CSP/COEP deliberately disabled for JSON API), CORS explicit allow-list (no `*` with credentials, production requires explicit `CORS_ORIGINS`), global (100/15m) + auth (20/15m) + webhook (100/1m) rate limiting with in-memory fallback, Zod strict validation, `SELECT ... FOR UPDATE` + allow-listed sort + `assertSafeTrunc` SQL injection protection, XSS JSON-only threat model (no HTML, frontend must sanitize), CSRF not applicable (Bearer-only, no cookies), request-size `1mb` JSON/urlencoded + 10MB multer, file upload (`image/jpeg|png|webp|gif`, 10MB, HMAC-signed storage keys `tenants/{tenantId}/products/{productId}/{uuid}_{sanitized}` with basename sanitization, executable rejection, tenant-scoped `assertTenantScopedKey`), Local PRIVATE (no `/storage` static, access only via `GET /api/v1/products/:productId/images/:imageId/file` + `GET /api/v1/storage/signed?key=&expires=&signature=` HMAC-SHA256 900s) + S3 PRIVATE-by-default (SigV4 pre-signed `getSignedUrl`, public `getUrl` only if bucket public), JWT HS256 pinned (`HS256` + `issuer:pulseops`/`audience:pulseops-api` + `sub/tenantId/sessionId` required, `exp` enforced, `none` rejected), refresh rotation atomic `revokedAt` + reuse revokes family, Argon2id, webhook raw-body HMAC-SHA256 `timingSafeEqual` over exact `req.rawBody` (whitespace-sensitive) before enqueue, BullMQ idempotency `@@unique([tenantId,eventId])`, audit sanitize `[REDACTED]`, logger redact, secrets never in responses/logs, 53 security tests + 746/746 full (20 suites)**
- **Complete Testing (Phase 21 — COMPLETE): Full-system validation. New: 51 unit (validators auth/product/inventory/payment/attribute + services/utils JWT/password/storage/cache/webhook/rate-limit/authorization), 12 E2E (Register→Login→Define Attributes→Create Product→Create Variants+Images→Add Inventory→Create Order (SKU snapshots)→Process Payment (webhook idempotency)→Notifications→Audit→WebSocket), 24 extended integration (multi-tenant matrix A→A/A→B/B→A, transaction/rollback, concurrent webhook idempotency 5→1, cache tenant keys & fallback, queue tenant context, storage isolation, error handling 401/403/400/SQL injection, IntegrationError mapping). Total 87 new + 746 baseline = 833 per-suite evidence (controlled individual execution, not one combined 833 run). Phase 20 security regression 53/53 still PASS. Lint 0, Prisma valid, 9 migrations up-to-date, no schema change.**
- **Swagger / OpenAPI Documentation (Phase 22 — COMPLETE): OpenAPI 3.0.3, `src/docs/` modular spec (openapi.js, swagger.js, components/schemas.js, 10 path modules), 81 path keys, 115 operations, 115 unique operationIds, 26 reusable schemas (Tenant, User, Role, Permission, Product, Variant, Attribute, Image, Inventory, Warehouse, Order, Payment, Notification, Audit, Activity, etc.), `bearerAuth` JWT security (`Authorization: Bearer <token>`), 21 tags, Swagger UI at `GET /api-docs/` (public, no auth, `swagger-ui-express@5.0.1`), OpenAPI JSON at `GET /api-docs.json` / `GET /openapi.json` / `GET /api/v1/openapi.json` (all 200), server `http://localhost:3000` (no `/api/v1` duplication — `SERVER BASE + PATH = ACTUAL ROUTE`), 100% production route coverage (115/115, PUT only at variant attributes), 573 `$ref` (0 unresolved), request/response/validation/authorization documented, no secrets exposed, 16 dedicated Phase 22 tests, lint 0, Prisma valid, 9 migrations up-to-date, no schema change.**

## Prerequisites

- Node.js 22 or newer
- npm 10 or newer
- PostgreSQL 16 or newer and Redis, if you want dependency health checks to report `up`

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create your local environment file:

   ```powershell
   Copy-Item .env.example .env
   ```

3. Update `DATABASE_URL` and `REDIS_URL` in `.env` for your local services.

4. Generate Prisma Client:

   ```bash
   npm run prisma:generate
   ```

5. Run database migrations:

   ```bash
   npx prisma migrate deploy
   ```

6. (Optional) Seed foundational roles/permissions:

   ```bash
   npm run db:seed
   ```

7. Start the API:

   ```bash
   npm run dev
   ```

## Environment reference

| Variable | Required | Purpose |
| --- | --- | --- |
| `NODE_ENV` | No | `development`, `test`, or `production`; defaults to `development`. |
| `PORT` / `HOST` | No | HTTP bind address; defaults to `3000` and `0.0.0.0`. |
| `DATABASE_URL` | For DB checks | PostgreSQL Prisma connection string, e.g. `postgresql://user:pass@localhost:5432/pulseops?schema=public`. |
| `REDIS_URL` | For Redis checks | Redis connection string. |
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
| `PAYMENT_WEBHOOK_SECRET` | No | HMAC secret for `x-webhook-signature`/`x-payment-signature`; defaults to test secret. |
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

Never commit `.env`. Use a secret manager or deployment-specific environment variables in production.

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

## Development commands

```bash
npm run dev
npm start
npm test
npm run lint
npm run prisma:validate
npm run prisma:generate
npx prisma migrate status
npm run db:seed
```

## Verification

Latest verification results (all passing, Phase 20 independently verified — HUMAN VERIFICATION: PASS):

- **Full test suite:** 746 passed, 0 failed (20 suites) — per-suite `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runInBand <file>` (693 Phase 1-19 +53 Phase 20 =746; Phase 20 53/53, Phase 19 preserved, Phase 18 45/45, Phase 17 22/22, Phase 16 58/58, Phase 15 44/44, Phase 14 27/27; combined `jest --runInBand` over all 20 suites exceeds 600s timeout due to DB load, so per-suite iteration used; no failures)
- **Phase 7:** 78 passed, 0 failed (product management: categories, products, variants, attributes, images, filtering, RBAC, tenant isolation, storage)
- **Phase 8:** 36 passed, 0 failed (inventory: adjustments, transfers, movements, low-stock, concurrency, tenant isolation, RBAC)
- **Phase 9:** 34 passed, 0 failed (orders: creation, multi-item, snapshots, pricing/totals, insufficient/rollback, variant/warehouse isolation, status transitions, history, cancellation, inventory restoration, authorization, concurrency, business-agnostic)
- **Phase 10:** 40 passed, 0 failed (payments: create with server amount truth, invalid/cross-tenant order 404, duplicate pending guard, confirm PENDING→COMPLETED/FAILED, invalid transition 400, frontend status injection rejected, webhook valid/invalid sig 401/malformed 400/duplicate safely ignored/concurrent duplicate 5→1 idempotent, refunds partial/full/excessive 400/invalid state 400/cross-tenant 404/audit-preserving, Decimal money, tenant isolation, rollback)
- **Phase 11:** 35 passed, 0 failed (audit & activity logs: authentication 401, authorization 403, tenant isolation cross-tenant 404, validation malformed UUID/pagination/filters, pagination/meta, no sensitive data / sanitization `[REDACTED]`, mutation audit/activity creation for user update/delete and order create/status/cancel with correct tenant/user/action/resource/timestamps, rollback leaves no audit, API response format, safe 404)
- **Phase 12:** 53 passed, 0 failed (notifications: authentication 401, authorization 403 `notification:read`/`notification:update`, tenant isolation cross-tenant 404 + client tenant override ignored, pagination/filtering newest-first, mark-one idempotent + 404/400, read-all idempotent tenant-isolated, preferences defaults/updates/upserts/validation 400, service `createNotification`/`notify`/`dispatchViaChannel` abstraction, channel `IN_APP`/`EMAIL`/`SMS`/`PUSH` concepts, mass-assignment protection, safe errors, no sensitive data)
- **Phase 13:** 32 passed, 0 failed (websockets/real-time: authenticated `connect` + tenant `connected` ack 200, missing/invalid/expired/malformed JWT rejected, `Bearer` prefix + `Authorization` header, tenant `tenant:A` allowed/`tenant:B` blocked, `user:A1` allowed/`user:B1` blocked, arbitrary/`forged tenantId`/`subscribe` blocked, tenant A cannot receive B events and vice-versa, user private `notification.created` isolation, A1/A2 tenant-share vs private, forged `tenantId` in payload does not affect routing, five events `order.created`/`order.updated`/`inventory.low_stock`/`payment.completed`/`notification.created` (tenant + user) delivery, sensitive-field sanitization `passwordHash`/`refreshToken`/`accessToken`/`secret`/`webhookSecret`/`authorization`/`cookie`/`stack` stripped, `sanitizeForTest`, notificationService no leak, webhook/confirm/inventory low-stock integration, `unknown.event`/`missing tenantId` rejected, HTTP still 200/403)
- **Phase 14:** 27 passed, 0 failed (redis caching: cache hit avoids DB, miss loads+sets, invalidation after tenant update/delete and product create/update/delete/setCategories, expiration TTL 1s → fresh, GET/SET/DEL failure fallback to DB without 500, tenant isolation distinct keys, product key includes page/limit/search/status/category/minPrice/maxPrice/sku/barcode/sortBy/sortOrder/attributeFilters, no secrets in keys/values, TTL constants valid, HTTP cache miss then hit, tenant isolation via API, mutation clears pattern, redis-down fallback 200)
- **Phase 15:** 44 passed, 0 failed (background jobs / BullMQ: queue creation `pulseops:v1:queue` + job names, enqueue `notification`/`cleanup`/`webhook` with deterministic jobId + sensitive guards, processor success `send-notification` creates `notifications` row + `cleanup-expired-tokens` tenant-scoped delete + `process-webhook` HMAC re-verify + `email`/`report`/`analytics` deferred stubs, retry/backoff 3/2/5 exponential `UnrecoverableError` for 400/401 vs transient retry, failed retention 24h no DLQ, idempotency `notif:<tenant>:key`/`webhook:<eventId>`/`cleanup:<tenant>:date` + processor safeguards, tenant isolation, sensitive `password`/`secret`/`token`/`authorization`/`cookie` rejected, logging `queue`/`jobId`/`tenantId`/`durationMs`, graceful `stopWorkers`/`shutdownJobs`, Redis fallback sync preserves correctness, HTTP `POST /jobs/notifications`/`/jobs/cleanup` 202/200 + `POST /payments/webhook` HMAC before enqueue + `GET /jobs/status`, regression still 568, 27 Phase 14 unchanged)
- **Phase 16:** 58 passed, 0 failed (external API integrations: StorageService `local`/`S3`/`MockS3` same interface `upload`/`delete`/`getUrl`/`exists`/`getStream` + `STORAGE_PROVIDER` local/s3 + tenant-scoped keys `tenants/{tenantId}/products/{productId}/{file}` + traversal protection + real S3 REST SigV4 via `S3StorageProvider` (PUT/GET/HEAD/DELETE + `x-amz-date`/`x-amz-content-sha256`/`Authorization` SigV4, timeout `STORAGE_TIMEOUT_MS`, retry idempotent PUT 503->retry, 401/404/429 normalized, no secret leakage) + `MockS3StorageProvider` test-only in-memory + local HTTP S3 test server (no cloud credentials, request log proves PUT/HEAD/GET/DELETE), payment Mock/Http `charge`/`refund` (idempotency-aware retry: charge retry on 503 when `idempotencyKey`, refund no retry, timeout 50ms->TIMEOUT 504 retryable, 401 AUTH 404 NOT_FOUND 429 RATE_LIMIT mapping, HMAC `verifyWebhookSignature` preserved, state machine `PENDING->COMPLETED/FAILED` unchanged, secrets not logged), email Mock/Http via `EmailService` (`sendEmail` -> `provider.send` adapter) + BullMQ `email` processor `processSendEmail` -> `EmailService` -> adapter (retry vs `UnrecoverableError` no-retry, queue `email` deferred from Phase 15 now real, no `fetch` in processor), SMS Mock/Http `send` (+ HTTP mapping `sid`/`id`), Shipping Mock/Http `getRate` (idempotent retry) vs `createShipment` (no retry, 503 1 call), Maps Mock/Http `geocode`/`reverseGeocode` (GET idempotent retry), shared HTTP `fetchWithTimeout` AbortController + `requestWithRetry` idempotency-aware + `IntegrationError` `TIMEOUT`/`UNAVAILABLE`/`AUTHENTICATION`/`VALIDATION`/`NOT_FOUND`/`RATE_LIMIT`/`CONFIGURATION` + `isRetryable` + `normalizeProviderError` + `mapProviderResponse` (never leak `apiKey`/`secret`), tenant isolation via `req.context.tenantId` (keys tenant-scoped, `assertTenantScopedKey` `tenants/` + no `..`/`//`/`\`/`\0`), webhook HMAC `PAYMENT_WEBHOOK_SECRET`, env secrets (`PAYMENT_PROVIDER*`, `STORAGE_PROVIDER`/`LOCAL_STORAGE_PATH`/`LOCAL_STORAGE_URL`/`S3_*`/`STORAGE_TIMEOUT_MS`, `EMAIL_PROVIDER*`, `SMS_PROVIDER*`, `SHIPPING_PROVIDER*`, `MAPS_PROVIDER*`), logger redact, no credentials in queue payload, normalized errors, 58 dedicated, 626 full, 17 suites)
- **Lint:** `npm run lint` → 0 errors, 0 warnings
- **Prisma validate:** `npx prisma validate` → ✅ Valid
- **Prisma generate:** ✅ Success
- **Migration status:** `npx prisma migrate status` → Database schema up to date (8 migrations applied; no Phase 15 migration)
- **Phase 9 migration:** No new migration required — reused Phase 03 order tables (`orders`, `order_items`, `order_status_history`)
- **Phase 10 migration:** `20260914_phase10_payments_webhook` — creates `payment_webhook_events` (idempotency) + partial unique provider indexes + non-negative CHECKs; reuses Phase 03 `payments`/`payment_transactions`/`refunds`
- **Phase 11 migration:** No new migration — reused Phase 3 models `audit_logs`/`activity_logs` (existing indexes `tenantId+createdAt`, `tenantId+resource+resourceId`, `tenantId+action+createdAt`)
- **Phase 12 migration:** No new migration — reused Phase 3 models `notifications`/`notification_preferences`/`notification_templates` and enums `NotificationType`/`NotificationChannel` (existing indexes `tenantId+userId+isRead`, `tenantId+createdAt`, unique `tenantId+userId+channel`)
- **Phase 13 migration:** No new migration — no database tables added, existing 8 migrations remain up to date (Socket.IO in-memory, no persistence table)
- **Phase 14 migration:** No new migration — Redis is cache/shared-state layer not a DB table, 8 migrations remain up to date (no new tables, PostgreSQL remains authoritative)
- **Phase 15 migration:** No new migration — `npx prisma migrate status` 8 migrations up to date, no new tables; jobs use existing `notifications`/`refresh_tokens`/`password_reset_tokens`/`email_verification_tokens`/`payment_webhook_events`
- **Phase 16 migration:** No new migration — `npx prisma migrate status` 8 migrations up to date, no new tables; integrations reuse existing `notifications`/`payments`/`product_images` and storage/filesystem (no new DB tables, S3 via REST, no cloud credentials)
- **Storage:** StorageService (`tenants/{tenantId}/products/{productId}/{filename}` + `tenants/{tenantId}/products/{productId}/variants/{variantId}/{filename}`) with `LocalStorageProvider` (filesystem `./storage`, traversal check) + `S3StorageProvider` (real S3 REST SigV4 PUT/GET/HEAD/DELETE via `fetch`, `STORAGE_PROVIDER` local/s3, `S3_BUCKET`/`S3_REGION`/`S3_ENDPOINT`/`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`/`S3_PUBLIC_BASE_URL`/`S3_FORCE_PATH_STYLE`/`STORAGE_TIMEOUT_MS` 5000, tenant-scoped keys, traversal protection, timeout/retry/normalization) + `MockS3StorageProvider` test-only (in-memory Map, local HTTP S3 test server, no cloud credentials needed, request log proves PUT/HEAD/GET/DELETE, 503 retry, timeout 60ms->TIMEOUT)
- **Regression:** Phase 1 PASS, Phase 2 PASS, Phase 3 PASS, Phase 4 PASS, Phase 5 PASS, Phase 6 PASS, Phase 7 PASS, Phase 8 PASS, Phase 9 PASS, Phase 10 PASS, Phase 11 PASS, Phase 12 PASS, Phase 13 PASS, Phase 14 PASS (27/27), Phase 15 PASS (44/44), Phase 16 PASS (58/58), Phase 17 PASS (22/22), Phase 18 PASS (45/45), Phase 19 PASS (preserved), Phase 20 PASS (53/53) — 693 +53 =746
- **Phase 17:** 22 passed, 0 failed (API orchestration: GET /api/v1/dashboard/overview via Dashboard Route → Dashboard Controller → Dashboard Service → OrderService/InventoryService/PaymentService/UserService/NotificationService/ProductService → repositories → Prisma/PostgreSQL; DashboardService orchestration only — no direct Prisma; six domain services expose getOverview(tenantId); tenant-scoped aggregation, req.context.tenantId, dashboard:read, client tenantId override blocked, no HTTP calls, Promise.allSettled parallel, partial-failure error markers / all-fail error, {success,data,message} + x-cache: HIT|MISS, Redis CacheService reuse pulseops:v1:tenant:{tenantId}:dashboard:overview TTL 60s — miss/hit, tenant keys, invalidation, GET/SET fallback, no second Redis, stripSensitive; 0 migrations / 0 schema changes, 8 migrations current)
- **Phase 18:** 45 passed, 0 failed (Analytics & Reporting: 6 APIs overview/sales/orders/inventory/customers/revenue; tenant-scoped via req.context.tenantId, analytics:read RBAC; date range from/to with UTC boundaries, groupBy day/week/month deterministic UTC grouping via date_trunc AT TIME ZONE 'UTC'; category/product/status/warehouseId filters; pagination page/limit; Decimal money formatted to 2dp; grossRevenue = completed payments createdAt in range; totalRefunded = completed refunds createdAt in range; netRevenue = gross - refunded; CacheService reuse tenant-scoped analytics keys TTL 60s; 0 migrations, 8 migrations current; validation/auth/authorization/tenant isolation/aggregation correctness/UTC grouping/revenue-refund semantics/cache hit-miss-fallback/Redis isolation/repository failure coverage)
- **Order verification:** POST create 201 PENDING, multi-item totals (subtotal/discount/tax/shipping/total), snapshot write-once, insufficient 400 `INSUFFICIENT_STOCK` rollback (no orphan order/movement/history), valid status PENDING→CONFIRMED 200, invalid transition 400 `INVALID_STATUS_TRANSITION`, cancel PENDING→CANCELLED 200 + `ORDER_RELEASE` restoration, invalid cancel SHIPPED 400 `CANCELLATION_NOT_ALLOWED`, cross-tenant variant/warehouse/order 404, unauthorized 403, unauthenticated 401, concurrent 10× qty1 from 5 → 5 success/5 fail final 0 never negative
- **Inventory verification:** adjust 25→30→27, transfer 27→22 / 14→19, insufficient 400 `INSUFFICIENT_STOCK`, same warehouse 400 `SAME_WAREHOUSE`, cross-tenant 404, unauthorized 403, unauthenticated 401, concurrent 10×-1 from 5 → 5 success/5 fail final 0
- **Image PATCH/DELETE:** PATCH authorized owner → 200, DELETE authorized owner → 200 (DB + storage removed), cross-tenant PATCH/DELETE → 404, unauthorized PATCH/DELETE → 403, unauthenticated → 401
- **Payment verification:** POST create 201 PENDING server amount `order.total` (client amount rejected strict), invalid order 404 `ORDER_NOT_FOUND`, cross-tenant order 404, duplicate pending 400 `PAYMENT_ALREADY_PENDING`; GET `/:id` 200 tenant-scoped, cross-tenant 404 `PAYMENT_NOT_FOUND`; POST confirm PENDING→COMPLETED 200 / `simulateFailure`→FAILED, double confirm 400 `INVALID_STATE_TRANSITION`, status injection strict 400; POST webhook valid `payment.succeeded`→COMPLETED 200 duplicate:false → second 200 duplicate:true no duplicate transaction, 5 concurrent identical → 1 effect, invalid signature 401 `INVALID_WEBHOOK_SIGNATURE`, malformed 400, DB unique `tenant_id+event_id` + `event_id`; POST refund partial `PARTIALLY_REFUNDED` → full `REFUNDED`, excessive 400 `EXCESSIVE_REFUND` no new refund, PENDING refund 400 `INVALID_REFUND_STATE`, history preserved (transactions appended)
- **Audit verification:** GET `/audit-logs` 200 tenant-scoped pagination/meta, filters `action`/`resource`/`resourceId`/`userId`/`from`/`to`, invalid action/datetime 400, malformed UUID 400, invalid pagination 400, client `tenantId` override ignored, cross-tenant 404; GET `/activity-logs` 200, GET `/activity-logs/:id` 200 owner / 404 other tenant; `old_value`/`new_value` sanitized `[REDACTED]` for passwords/hashes/tokens/secrets; `ip_address`/`user_agent` captured from `req.ip`/`user-agent`
- **Notification verification:** GET `/notifications` 200 tenant/user-scoped pagination/meta newest-first, filters `isRead`/`type`/`channel`, invalid pagination 400, invalid type/channel 400, client tenant override ignored; PATCH `/:id/read` 200 idempotent second 200, 404 not-found/cross-tenant, 400 invalid UUID, forged tenant/body ignored, unauthorized 403 unauth 401; POST `/read-all` 200 `{updated:n}` 0 repeated idempotent tenant-isolated; GET `notification-preferences` 200 4 channels defaults tenant-scoped; PATCH `preferences` 200 upsert `EMAIL`/`SMS`/`IN_APP`/`PUSH` via flat or `{preferences:{}}`, invalid/empty 400, unknown channel 400, tenant injection ignored; service creates tenant-scoped, validates required, channel/type enums, provider-independent `notify`/`dispatchViaChannel`
- **WebSockets verification:** Socket.IO authenticated `connect` succeeds with `connected` `{userId, tenantId, rooms:[tenant:...,user:...]}` and `join tenant:A/user:A1` allowed, `tenant:B/user:B1/arbitrary/global/forged tenantId/subscribe` blocked `FORBIDDEN`; `order.created`/`order.updated` tenant-isolated (A cannot receive B, B cannot receive A), `notification.created` user-private (A1 cannot receive B1, A2 cannot receive A1 private but both receive tenant broadcast), forged `tenantId` in payload ignored (envelope `tenantId` server-derived); five events delivered tenant `tenant:A` or user `user:Id` with `{event,data,tenantId,timestamp}` and recursive sanitization (no `passwordHash`/`refreshToken`/`accessToken`/`secret`/`webhookSecret`/`authorization`/`cookie`/`stack`); `unknown.event`/missing audience rejected; HTTP `GET /health` 200, `GET /notifications` 200 still pass
- **Redis caching verification:** `GET /health` 200, `GET /health/redis` 200 `PONG` after `connectRedis` (503 before connect is fallback not failure), degraded mode verified — Redis down still `GET /api/v1/products` 200 via DB fallback, `GET /api/v1/products?page=1&limit=10` miss stores `pulseops:v1:tenant:{id}:products:list:*` hash, hit returns cached, `POST /api/v1/products` after hit clears pattern 0 keys, next GET repopulates 2 items, tenant B list 0 isolated, `GET /api/v1/tenants/:id` tenant/settings cache, `GET /api/v1/permissions` list + `getUserPermissions` user-scoped cache, SET failure still 200, DEL failure does not roll back DB mutation, key includes all query params (page/limit/search/status/category/minPrice/maxPrice/sku/barcode/sortBy/sortOrder/attributeFilters sorted hash 16), no secrets in values/keys, TTL 300/60 validated, expiration 1s → miss
- **Background jobs verification:** `bullmq ^5.10.2` installed, `REDIS_URL` reused, dedicated BullMQ Redis `maxRetriesPerRequest: null` `ping PONG`, queue prefix `pulseops:v1:queue`, 6 queues registered, workers `webhook 10`/`cleanup 1`/`others 5` start and graceful `stopWorkers`→0, `POST /api/v1/payments/webhook` HMAC before enqueue invalid 401 no job vs valid → `202` enqueued (fallback `200` when Redis unavailable) and processor re-verifies, `POST /api/v1/jobs/notifications` → `202`/`200` with `jobId`, `POST /api/v1/jobs/cleanup` → `202`/`200` tenant-scoped, `GET /api/v1/jobs/status` 200 `{enabled, workersStarted, queues: [notification,webhook,…]}`, `send-notification` creates DB row, `cleanup-expired-tokens` deletes only that tenant expired, `process-webhook` 5 concurrent identical → 1 effect, retry 3/2/5 exponential with `UnrecoverableError` for permanent 400/401, failed retention 24h no DLQ, idempotency `notif:<tid>:key`/`webhook:<eid>`/`cleanup:<tid>:date` + processor safeguards, Redis `ECONNREFUSED` fallback sync preserves `200`, order create enqueues notification fire-and-forget, 44/44 Phase 15 + 568/568 full
- **External integrations verification:** StorageService provider contract (`local`/`S3`/`MockS3` same `upload`/`delete`/`getUrl`/`exists`/`getStream`), `STORAGE_PROVIDER` local vs s3 factory, `MockS3StorageProvider` distinct from `S3StorageProvider` (constructor name), tenant-scoped keys `tenants/{tenantId}/products/{productId}/` and `variants/{variantId}/`, traversal rejected `../`/`//`/`\`/`:`/`\0`/`not-tenants/` 400, tenant B key != tenant A key, local regression `upload`/`fileExists`/`getFileUrl`/`delete`/`exists false`, real S3 via local HTTP S3 test server `PUT`200/`HEAD`200/`GET` stream/`DELETE`204/`HEAD`404->null + log proves PUT/HEAD/GET/DELETE, HEAD->false after delete, `S3StorageProvider` SigV4 `Authorization: AWS4-HMAC-SHA256` when `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` provided else unsigned (test server), timeout 60ms->`TIMEOUT` 504 retryable, 503 retry 2 PUTs then success (idempotent PUT), 401/404/429 normalized, secrets not leaked; Payment Mock `charge` `pay_mock_*` mapped + Http `charge` request mapping `amount`/`orderId`/`tenantId` + `Authorization: Bearer` + `Idempotency-Key` + response `pay_http_123` mapped, Http timeout 50ms->TIMEOUT, retry on 503 when idempotent 2 calls, refund no retry 1 call, mock UNAVAILABLE retryable, validation 400 not retryable, factory mock/Http, CONFIGURATION when URL missing, webhook `verifyWebhookSignature` 401; Email Mock `email_mock_*` + Http `/send` mapping, timeout retryable vs validation not, processor `processSendEmail` via `EmailService`->adapter (no `fetch`), `UnrecoverableError` for missing `to`/`subject`, no secrets in payload; SMS Mock `sms_mock_*` + Http `sid`, timeout retryable; Shipping `getRate` 12.5 USD + Http `/rates` + `createShipment` no retry 1 call, validation not retryable; Maps `geocode` lat/lng + Http GET `/geocode?address=` + retry 2 calls on 503; Error normalization `TIMEOUT`/`UNAVAILABLE`/`AUTHENTICATION`/`VALIDATION`/`NOT_FOUND`/`RATE_LIMIT` distinct `isRetryable`, provider errors no `apiKey`/`secret` leak, HTTP 401->AUTH 404->NOT_FOUND 429->RATE_LIMIT; Secret management `PAYMENT_PROVIDER*`/`STORAGE_PROVIDER`/`S3_*`/`STORAGE_TIMEOUT_MS`/`EMAIL_PROVIDER*`/`SMS_PROVIDER*`/`SHIPPING_PROVIDER*`/`MAPS_PROVIDER*` env secrets not leaked, queue payload no `apiKey`/`secret`, logger redact; tenant isolation `tenantId` via `req.context` keys tenant-scoped; startup `GET /health` 200 `GET /health/db` 200 `GET /health/redis` 200/503 + invalid webhook 401
- **Startup/health:** `GET /health` 200, `GET /health/db` 200, `GET /health/redis` 200/503, degraded mode verified; actual HTTP+Socket.IO+Redis verification passed on `http.createServer(app)` ephemeral port + ioredis

## Operational notes

At startup the API attempts to connect to PostgreSQL and Redis, then `initJobs()` starts BullMQ workers (`startWorkers()`; if `REDIS_URL` missing or Redis unreachable, workers are skipped and enqueue falls back to synchronous processing so readiness still degrades gracefully). In development and test, unavailable configured services leave the API running in degraded mode so liveness remains available and readiness returns `503` (Redis outage fallback can reintroduce HTTP latency but preserves correctness). Production fails fast by default; set `FAIL_ON_DEPENDENCY_ERROR=false` only when degraded startup is intentional. On `SIGINT` or `SIGTERM`, the server stops accepting connections, then `shutdownJobs()` gracefully closes workers (allows active jobs to finish, `lockDuration` 30s), closes all queues, disconnects BullMQ Redis, then closes Redis and Prisma cleanly (force exit after 10s if hung).

## Current scope

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
- Swagger/OpenAPI, Docker/CI/CD are **NOT implemented yet**.
- Phase 7 local storage now superseded by Phase 16 StorageService abstraction (`LocalStorageProvider` + `S3StorageProvider` real S3 REST SigV4 + `MockS3StorageProvider` test-only); `STORAGE_PROVIDER` local/s3 via `src/config/env.js`, storage keys server-generated `tenants/{tenantId}/products/{productId}/` and `variants/{variantId}/`, tenant-scoped, traversal protection (`..`/`//`/`\`/`:`/`\0`), timeout `STORAGE_TIMEOUT_MS`, retry, normalization, request log proves PUT/HEAD/GET/DELETE via local HTTP S3 test server (no cloud credentials).
- PostgreSQL and Redis connectivity are verified locally. The health endpoints distinguish liveness from dependency readiness.
- Docker and deployment configuration are intentionally deferred until their dedicated delivery phase.

## Phase status

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
| Phase 20 | Security Hardening | ✅ Complete |
| Phase 21 | Complete Testing | ⏳ Not started |
| Phase 22 | Swagger/OpenAPI | ⏳ Not started |
| Phase 23 | Docker/CI/CD/Deployment | ⏳ Not started |

**Phase 20 is COMPLETE and VERIFIED (HUMAN VERIFICATION: PASS) — 53/53 Phase 20 tests, 746/746 full suite (20 suites, 693 Phase 1-19 +53 Phase 20 =746; per-suite iteration, combined >600s due to DB load; Phase 19 preserved, Phase 18 45/45, Phase 17 22/22, Phase 16 58/58, Phase 15 44/44, Phase 14 27/27), `node --experimental-vm-modules jest --runInBand tests/integration/phase20-security.test.js` 53/53, `npm run lint` 0 errors, `npx prisma validate` valid, `npx prisma migrate status` 9 migrations up to date (no Phase 20 migration — hardening reuses existing tables/filesystem/S3, 0 schema changes). Security: Helmet HSTS/CSP, CORS allow-list, global/auth/webhook rate limiting, Zod, SQL allow-lists, XSS/CSRF, request-size, file upload + Local PRIVATE/S3 PRIVATE-by-default + signed URLs (HMAC/SigV4) + UUID keys, JWT HS256, refresh rotation, raw-body HMAC whitespace-sensitive, idempotency, audit sanitize. Known limitations preserved: deepmerge-ts 3 high dev-only via prisma, combined Jest >600s per-suite used, real S3 SigV4 requires credentials (mock HMAC in test), Local private no /storage static, signed URLs are controlled-access, tenant-scoped keys alone not private.**

**Phase 16 is COMPLETE and VERIFIED (HUMAN VERIFICATION: PASS) — 58/58 Phase 16 tests, 626/626 full suite (17 suites, 568 Phase 1-15 + 58 Phase 16 = 626; Phase 15 dedicated 44/44 unchanged, Phase 14 27/27 unchanged), `node --experimental-vm-modules jest --runInBand --forceExit` 0 failed, `node --experimental-vm-modules jest tests/integration/phase16-external-integrations.test.js --runInBand` 58/58, `npm run lint` 0 errors, `npx prisma validate` valid, `npx prisma migrate status` 8 migrations up to date (no Phase 16 migration — integrations reuse existing tables/filesystem/S3 REST; no new DB tables, no cloud credentials). Phase 17 — API Orchestration is COMPLETE (see above). S3 clarification: `S3StorageProvider` is real S3 REST (SigV4 `AWS4-HMAC-SHA256` + `x-amz-date`/`x-amz-content-sha256`/`host`, PUT/GET/HEAD/DELETE via `fetch` + `STORAGE_TIMEOUT_MS` 5000, idempotent retry, path/virtual-hosted via `S3_ENDPOINT`/`S3_FORCE_PATH_STYLE`/`S3_BUCKET`/`S3_REGION`/`S3_PUBLIC_BASE_URL`) vs `MockS3StorageProvider` test-only (in-memory Map, `mock-s3` provider, local HTTP S3 test server `http://127.0.0.1:{port}` with Map store + `PUT`/`GET`/`HEAD`/`DELETE` + `setFailNext(503)`/`setDelay` + request log, no cloud credentials needed, proves real HTTP). Limitations: Shipping/Maps adapters are not full domain products (minimal `getRate`/`createShipment`/`geocode`/`reverseGeocode` contracts, not full shipping/maps domain); HTTP providers configurable endpoints (`PAYMENT_PROVIDER_URL`/`EMAIL_PROVIDER_URL`/`SMS_PROVIDER_URL`/`SHIPPING_PROVIDER_URL`/`MAPS_PROVIDER_URL`/`S3_ENDPOINT`) via `src/config/env.js`; no real credentials needed (mock providers default, Http providers require URL only when `*_PROVIDER=http` else `CONFIGURATION` 500); no separate DLQ still (failed retention 24h); Redis outage sync fallback still can reintroduce latency.**

---

## Phase 19 — Performance Optimization (COMPLETE & VERIFIED — HUMAN VERIFICATION: PASS)

### Objective

Optimize existing PulseOps backend **only after functionality was proven** (Phases 1-18 complete and verified). Evidence-based optimization — no speculative changes.

### Performance Areas

1. **PostgreSQL/database optimization** — targeted index additions for tenant-scoped query patterns
2. **Query optimization** — selective field loading, removal of unnecessary includes
3. **API response optimization** — reduced payload sizes, explicit field selection
4. **Compression** — tuned threshold and level for JSON payloads
5. **Redis cache tuning** — TTL increases for stable endpoints, preserved invalidation

### Four Approved Database Indexes

| Index | Query Pattern | Rationale |
|-------|---------------|-----------|
| `ProductVariant (tenantId, price)` | `WHERE tenant_id = $1 AND price >= $2 AND price <= $3` | Price range filtering in product list; existing indexes don't cover price |
| `ProductVariant (tenantId, status, createdAt)` | `WHERE tenant_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT 20` | Status filtering + sort; avoids explicit Sort node |
| `Inventory (tenantId, quantity)` | `WHERE tenant_id = $1 AND quantity <= 10` | Low-stock threshold queries; no existing index on quantity |
| `Order (tenantId, customerId, createdAt)` | `WHERE tenant_id = $1 AND customer_id = $2 ORDER BY created_at DESC LIMIT 20` | Customer order history pagination + sort; existing indexes don't combine customer + sort |

### Rejected Index

| Index | Reason |
|-------|--------|
| `Product (tenantId, name)` | Actual product search uses `ILIKE '%term%'` (leading wildcard). Normal B-tree does not optimize leading-wildcard search. Only pg_trgm or full-text search would help — roadmap prohibits adding pg_trgm complexity. Index removed from schema, database, and migration. |

### Orders List Optimization

- **Before**: `items: true` — loaded all item fields including `attributeSnapshot` (JSON blob) in list responses
- **After**: Explicit `select` of 10 scalar fields (`id`, `productVariantId`, `productNameSnapshot`, `variantNameSnapshot`, `skuSnapshot`, `unitPrice`, `quantity`, `discount`, `tax`, `lineTotal`)
- **Excluded**: `attributeSnapshot`, `createdAt`, `orderId`, `tenantId`
- **Contract**: Preserved — list endpoint never documented returning `attributeSnapshot`; full detail via `GET /orders/:id`
- **Measurement**: Qualitative code-level optimization. No production benchmark performed. Payload reduction not measured numerically.

### Compression Tuning

```javascript
app.use(compression({
  threshold: 512,  // was default 1KB
  level: 6         // balanced CPU vs ratio
}));
```

Lower threshold catches smaller JSON responses typical of API endpoints.

### Redis TTL Tuning

| Cache Key | Before | After | Rationale |
|-----------|--------|-------|-----------|
| `PRODUCT_LIST` | 60s | 300s | Products change infrequently; invalidated on write |
| `DASHBOARD_OVERVIEW` | 60s | 300s | Dashboard tolerates 5min staleness |
| `ANALYTICS_OVERVIEW` | 60s | 300s | Overview metrics stable |
| `ANALYTICS_SALES` | 60s | 180s | Detailed analytics benefit from 3min cache |
| `ANALYTICS_ORDERS` | 60s | 180s | — |
| `ANALYTICS_INVENTORY` | 60s | 180s | — |
| `ANALYTICS_CUSTOMERS` | 60s | 180s | — |
| `ANALYTICS_REVENUE` | 60s | 180s | — |

Existing invalidation (`delByPattern` after writes) and cache-failure fallback (DB authoritative) preserved. No measured hit-rate improvement (test env uses fake Redis) — configuration tuning based on data volatility analysis.

### Database Migration

- **File**: `prisma/migrations/20260916_phase19_performance_indexes/migration.sql`
- **Contains**: 4 `CREATE INDEX IF NOT EXISTS` statements for the approved indexes
- **Status**: Applied, marked via `prisma migrate resolve --applied`
- **Verification**: `npx prisma migrate status` → "Database schema is up to date!" (9 migrations total)

### Testing Results

```
Test Suites: 19 passed, 19 total
Tests:       693 passed, 693 total
Lint:        0 errors, 0 warnings
Prisma validate: ✅ Valid
Migration status: ✅ Up to date
Application startup: ✅ Verified
```

### Performance Measurement Limitations

- **No production load testing** — index effectiveness and cache hit rates measured qualitatively
- **Test database has insufficient/empty data** for meaningful before/after query-plan benchmarking
- **No fabricated performance numbers** — index benefits based on actual query patterns and PostgreSQL planner behavior
- **Redis hit-rate improvements not measured** under production load

### Architecture & Security Preserved

```
Route
  ↓
Controller
  ↓
Service
  ↓
Repository
  ↓
PostgreSQL
```

- All new indexes include `tenantId` as leading column (tenant-aware)
- All queries remain tenant-scoped via `where: { tenantId, ... }`
- No cross-tenant data leakage possible
- Existing API contracts preserved
- Existing cache invalidation and Redis failure fallback preserved

### Scope Boundary

```text
Phase 20 — Security Hardening: NOT IMPLEMENTED
Phase 21 — Complete Testing: NOT IMPLEMENTED (beyond regression suite)
Phase 22 — Swagger/OpenAPI: NOT IMPLEMENTED
Phase 23 — Docker/CI/CD: NOT IMPLEMENTED
Roadmap: UNCHANGED
```

Phase 13 — WebSockets / Real-Time — Verified details:
- **Files:** `src/realtime/realtime.service.js` (abstraction + `REALTIME_EVENTS` + `emitRealtime` + `sanitizePayload` + helpers `emitOrderCreated`/`emitOrderUpdated`/`emitInventoryLowStock`/`emitPaymentCompleted`/`emitNotificationCreated`), `src/realtime/socket.auth.js` (`socketAuthMiddleware`, `extractToken` from `auth.token`/`Authorization`/`query.token`, `verifyAccessToken`, `USER_NOT_FOUND`/`TENANT_INACTIVE`/`TOKEN_EXPIRED`), `src/realtime/socket.server.js` (`createSocketServer`, auto-join `tenant:{tenantId}`/`user:{userId}`, guarded `join`/`subscribe`, `connected` ack, `disconnect`/`error`, `closeSocketServer`), `tests/integration/phase13-realtime.test.js` (32 tests), plus approvals `src/app/server.js` (`initSocketIO`), `src/modules/orders/orders.service.js`, `src/modules/inventory/inventory.service.js`, `src/modules/payments/payments.service.js`, `src/modules/notifications/notifications.service.js`, `package.json`/`package-lock.json` (`socket.io`/`socket.io-client` ^4.8.1)
- **Events:** `order.created` (tenant room via `OrderService.create`), `order.updated` (tenant room via `updateStatus`/`cancel`), `inventory.low_stock` (tenant room threshold 10 via `adjust`/`transfer`), `payment.completed` (tenant room via `confirm` to `COMPLETED` + webhook `payment.succeeded`), `notification.created` (user room when `userId` else tenant room via `NotificationService.createNotification`)
- **Routing:** tenant-scoped `io.to(tenant:{tenantId})`, user-specific `io.to(user:{userId})`, envelope `{event,data: sanitized, tenantId, timestamp}`, `ALLOWED_EVENTS` whitelist, `getIoInstance` null-safe, client cannot choose destination
- **Rooms/security:** authenticated only, own `tenant:{tenantId}` allowed, own `user:{userId}` allowed, another tenant/user/arbitrary blocked (`FORBIDDEN` ack + `error` emit), forged `tenantId`/`userId` never trusted, server-derived context only
- **Payloads:** minimal (`id`/`tenantId`/`status`/`total`/`currency`/`customerId`/`quantity`/`threshold` etc.), recursive sanitization strips `password`/`passwordHash`/`refreshToken`/`accessToken`/`secret`/`webhookSecret`/`provider*`/`authorization`/`cookie`/`stack`/`token` (nested), no DB `password_hash`/`refresh_tokens` leakage
- **Lifecycle:** `connection` → auto-join + `connected` emit, `connect_error` on missing/invalid/expired/malformed, `disconnect` logged, `error` handled, guarded `join`/`subscribe`, clean `closeSocketServer` in `shutdown` (`SIGTERM`/`SIGINT`)
- **Verification:** 32/32 Phase 13 (+ 497/497 full with `npm test -- --testTimeout=15000`; default 5000ms hook timeout in Phase 11/12 `beforeAll` is flaky pre-existing — isolated 35/35 and 53/53 pass, not Phase 13 failure)
- **Database:** No Phase 13 tables/migration; 8 migrations up to date
- **Limitations:** in-memory/single-instance (Redis pub/sub deferred to Phase 14), `low_stock` threshold hard-coded 10, low-stock from `adjust`/`transfer` paths only, `payment.completed` from `confirm`/webhook `COMPLETED` paths, no persistent socket session table, `query.token` fallback exists and is less secure