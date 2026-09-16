# PulseOps Backend

A production-minded, multi-tenant backend for PulseOps, built with Node.js, Express, PostgreSQL, Prisma, and Redis. The project follows a modular-monolith architecture and is being delivered incrementally so that every foundation layer is tested before business modules are introduced.

**Current status:** Phase 14 — Redis Caching is **COMPLETE and VERIFIED (HUMAN VERIFICATION: PASS)**. Phase 15 — Background Jobs / BullMQ is **NEXT**.

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
| `CORS_ORIGINS` | No | Comma-separated browser origin allow-list. |
| `LOG_LEVEL` | No | Pino log threshold. |
| `REQUEST_BODY_LIMIT` | No | Maximum JSON request size; defaults to `1mb`. |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` | No | General API rate-limit window and request count. |
| `TRUST_PROXY` | No | Set to `true` when the API runs behind a trusted reverse proxy. |
| `FAIL_ON_DEPENDENCY_ERROR` | No | Defaults to `true` in production and `false` elsewhere. When true, PostgreSQL/Redis startup failures stop the API. |

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

The same health endpoints are also exposed under `/api/v1/health`, although infrastructure probes should use the root `/health` routes.

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

Latest verification results (all passing, Phase 14 independently verified — HUMAN VERIFICATION: PASS):

- **Full test suite:** 524 passed, 0 failed (15 suites) — run as `npm test -- --testTimeout=15000` (Jest open-handle warning after success is async teardown, not a failure; Phase 14 adds 27 tests to prior 497)
- **Phase 7:** 78 passed, 0 failed (product management: categories, products, variants, attributes, images, filtering, RBAC, tenant isolation, storage)
- **Phase 8:** 36 passed, 0 failed (inventory: adjustments, transfers, movements, low-stock, concurrency, tenant isolation, RBAC)
- **Phase 9:** 34 passed, 0 failed (orders: creation, multi-item, snapshots, pricing/totals, insufficient/rollback, variant/warehouse isolation, status transitions, history, cancellation, inventory restoration, authorization, concurrency, business-agnostic)
- **Phase 10:** 40 passed, 0 failed (payments: create with server amount truth, invalid/cross-tenant order 404, duplicate pending guard, confirm PENDING→COMPLETED/FAILED, invalid transition 400, frontend status injection rejected, webhook valid/invalid sig 401/malformed 400/duplicate safely ignored/concurrent duplicate 5→1 idempotent, refunds partial/full/excessive 400/invalid state 400/cross-tenant 404/audit-preserving, Decimal money, tenant isolation, rollback)
- **Phase 11:** 35 passed, 0 failed (audit & activity logs: authentication 401, authorization 403, tenant isolation cross-tenant 404, validation malformed UUID/pagination/filters, pagination/meta, no sensitive data / sanitization `[REDACTED]`, mutation audit/activity creation for user update/delete and order create/status/cancel with correct tenant/user/action/resource/timestamps, rollback leaves no audit, API response format, safe 404)
- **Phase 12:** 53 passed, 0 failed (notifications: authentication 401, authorization 403 `notification:read`/`notification:update`, tenant isolation cross-tenant 404 + client tenant override ignored, pagination/filtering newest-first, mark-one idempotent + 404/400, read-all idempotent tenant-isolated, preferences defaults/updates/upserts/validation 400, service `createNotification`/`notify`/`dispatchViaChannel` abstraction, channel `IN_APP`/`EMAIL`/`SMS`/`PUSH` concepts, mass-assignment protection, safe errors, no sensitive data)
- **Phase 13:** 32 passed, 0 failed (websockets/real-time: authenticated `connect` + tenant `connected` ack 200, missing/invalid/expired/malformed JWT rejected, `Bearer` prefix + `Authorization` header, tenant `tenant:A` allowed/`tenant:B` blocked, `user:A1` allowed/`user:B1` blocked, arbitrary/`forged tenantId`/`subscribe` blocked, tenant A cannot receive B events and vice-versa, user private `notification.created` isolation, A1/A2 tenant-share vs private, forged `tenantId` in payload does not affect routing, five events `order.created`/`order.updated`/`inventory.low_stock`/`payment.completed`/`notification.created` (tenant + user) delivery, sensitive-field sanitization `passwordHash`/`refreshToken`/`accessToken`/`secret`/`webhookSecret`/`authorization`/`cookie`/`stack` stripped, `sanitizeForTest`, notificationService no leak, webhook/confirm/inventory low-stock integration, `unknown.event`/`missing tenantId` rejected, HTTP still 200/403)
- **Phase 14:** 27 passed, 0 failed (redis caching: cache hit avoids DB, miss loads+sets, invalidation after tenant update/delete and product create/update/delete/setCategories, expiration TTL 1s → fresh, GET/SET/DEL failure fallback to DB without 500, tenant isolation distinct keys, product key includes page/limit/search/status/category/minPrice/maxPrice/sku/barcode/sortBy/sortOrder/attributeFilters, no secrets in keys/values, TTL constants valid, HTTP cache miss then hit, tenant isolation via API, mutation clears pattern, redis-down fallback 200)
- **Lint:** ESLint 0 errors, 0 warnings
- **Prisma validate:** ✅ Valid
- **Prisma generate:** ✅ Success
- **Migration status:** Database schema up to date (8 migrations applied)
- **Phase 9 migration:** No new migration required — reused Phase 03 order tables (`orders`, `order_items`, `order_status_history`)
- **Phase 10 migration:** `20260914_phase10_payments_webhook` — creates `payment_webhook_events` (idempotency) + partial unique provider indexes + non-negative CHECKs; reuses Phase 03 `payments`/`payment_transactions`/`refunds`
- **Phase 11 migration:** No new migration — reused Phase 3 models `audit_logs`/`activity_logs` (existing indexes `tenantId+createdAt`, `tenantId+resource+resourceId`, `tenantId+action+createdAt`)
- **Phase 12 migration:** No new migration — reused Phase 3 models `notifications`/`notification_preferences`/`notification_templates` and enums `NotificationType`/`NotificationChannel` (existing indexes `tenantId+userId+isRead`, `tenantId+createdAt`, unique `tenantId+userId+channel`)
- **Phase 13 migration:** No new migration — no database tables added, existing 8 migrations remain up to date (Socket.IO in-memory, no persistence table)
- **Phase 14 migration:** No new migration — Redis is cache/shared-state layer not a DB table, 8 migrations remain up to date (no new tables, PostgreSQL remains authoritative)
- **Storage:** Local StorageService (`tenants/{tenantId}/products/{productId}/{filename}`), S3 deferred to Phase 16
- **Regression:** Phase 1 PASS, Phase 2 PASS, Phase 3 PASS, Phase 4 PASS, Phase 5 PASS, Phase 6 PASS, Phase 7 PASS, Phase 8 PASS, Phase 9 PASS, Phase 10 PASS, Phase 11 PASS, Phase 12 PASS, Phase 13 PASS, Phase 14 PASS
- **Order verification:** POST create 201 PENDING, multi-item totals (subtotal/discount/tax/shipping/total), snapshot write-once, insufficient 400 `INSUFFICIENT_STOCK` rollback (no orphan order/movement/history), valid status PENDING→CONFIRMED 200, invalid transition 400 `INVALID_STATUS_TRANSITION`, cancel PENDING→CANCELLED 200 + `ORDER_RELEASE` restoration, invalid cancel SHIPPED 400 `CANCELLATION_NOT_ALLOWED`, cross-tenant variant/warehouse/order 404, unauthorized 403, unauthenticated 401, concurrent 10× qty1 from 5 → 5 success/5 fail final 0 never negative
- **Inventory verification:** adjust 25→30→27, transfer 27→22 / 14→19, insufficient 400 `INSUFFICIENT_STOCK`, same warehouse 400 `SAME_WAREHOUSE`, cross-tenant 404, unauthorized 403, unauthenticated 401, concurrent 10×-1 from 5 → 5 success/5 fail final 0
- **Image PATCH/DELETE:** PATCH authorized owner → 200, DELETE authorized owner → 200 (DB + storage removed), cross-tenant PATCH/DELETE → 404, unauthorized PATCH/DELETE → 403, unauthenticated → 401
- **Payment verification:** POST create 201 PENDING server amount `order.total` (client amount rejected strict), invalid order 404 `ORDER_NOT_FOUND`, cross-tenant order 404, duplicate pending 400 `PAYMENT_ALREADY_PENDING`; GET `/:id` 200 tenant-scoped, cross-tenant 404 `PAYMENT_NOT_FOUND`; POST confirm PENDING→COMPLETED 200 / `simulateFailure`→FAILED, double confirm 400 `INVALID_STATE_TRANSITION`, status injection strict 400; POST webhook valid `payment.succeeded`→COMPLETED 200 duplicate:false → second 200 duplicate:true no duplicate transaction, 5 concurrent identical → 1 effect, invalid signature 401 `INVALID_WEBHOOK_SIGNATURE`, malformed 400, DB unique `tenant_id+event_id` + `event_id`; POST refund partial `PARTIALLY_REFUNDED` → full `REFUNDED`, excessive 400 `EXCESSIVE_REFUND` no new refund, PENDING refund 400 `INVALID_REFUND_STATE`, history preserved (transactions appended)
- **Audit verification:** GET `/audit-logs` 200 tenant-scoped pagination/meta, filters `action`/`resource`/`resourceId`/`userId`/`from`/`to`, invalid action/datetime 400, malformed UUID 400, invalid pagination 400, client `tenantId` override ignored, cross-tenant 404; GET `/activity-logs` 200, GET `/activity-logs/:id` 200 owner / 404 other tenant; `old_value`/`new_value` sanitized `[REDACTED]` for passwords/hashes/tokens/secrets; `ip_address`/`user_agent` captured from `req.ip`/`user-agent`
- **Notification verification:** GET `/notifications` 200 tenant/user-scoped pagination/meta newest-first, filters `isRead`/`type`/`channel`, invalid pagination 400, invalid type/channel 400, client tenant override ignored; PATCH `/:id/read` 200 idempotent second 200, 404 not-found/cross-tenant, 400 invalid UUID, forged tenant/body ignored, unauthorized 403 unauth 401; POST `/read-all` 200 `{updated:n}` 0 repeated idempotent tenant-isolated; GET `notification-preferences` 200 4 channels defaults tenant-scoped; PATCH `preferences` 200 upsert `EMAIL`/`SMS`/`IN_APP`/`PUSH` via flat or `{preferences:{}}`, invalid/empty 400, unknown channel 400, tenant injection ignored; service creates tenant-scoped, validates required, channel/type enums, provider-independent `notify`/`dispatchViaChannel`
- **WebSockets verification:** Socket.IO authenticated `connect` succeeds with `connected` `{userId, tenantId, rooms:[tenant:...,user:...]}` and `join tenant:A/user:A1` allowed, `tenant:B/user:B1/arbitrary/global/forged tenantId/subscribe` blocked `FORBIDDEN`; `order.created`/`order.updated` tenant-isolated (A cannot receive B, B cannot receive A), `notification.created` user-private (A1 cannot receive B1, A2 cannot receive A1 private but both receive tenant broadcast), forged `tenantId` in payload ignored (envelope `tenantId` server-derived); five events delivered tenant `tenant:A` or user `user:Id` with `{event,data,tenantId,timestamp}` and recursive sanitization (no `passwordHash`/`refreshToken`/`accessToken`/`secret`/`webhookSecret`/`authorization`/`cookie`/`stack`); `unknown.event`/missing audience rejected; HTTP `GET /health` 200, `GET /notifications` 200 still pass
- **Redis caching verification:** `GET /health` 200, `GET /health/redis` 200 `PONG` after `connectRedis` (503 before connect is fallback not failure), degraded mode verified — Redis down still `GET /api/v1/products` 200 via DB fallback, `GET /api/v1/products?page=1&limit=10` miss stores `pulseops:v1:tenant:{id}:products:list:*` hash, hit returns cached, `POST /api/v1/products` after hit clears pattern 0 keys, next GET repopulates 2 items, tenant B list 0 isolated, `GET /api/v1/tenants/:id` tenant/settings cache, `GET /api/v1/permissions` list + `getUserPermissions` user-scoped cache, SET failure still 200, DEL failure does not roll back DB mutation, key includes all query params (page/limit/search/status/category/minPrice/maxPrice/sku/barcode/sortBy/sortOrder/attributeFilters sorted hash 16), no secrets in values/keys, TTL 300/60 validated, expiration 1s → miss
- **Startup/health:** `GET /health` 200, `GET /health/db` 200, `GET /health/redis` 200/503, degraded mode verified; actual HTTP+Socket.IO+Redis verification passed on `http.createServer(app)` ephemeral port + ioredis

## Operational notes

At startup the API attempts to connect to PostgreSQL and Redis. In development and test, unavailable configured services leave the API running in degraded mode so liveness remains available and readiness returns `503`. Production fails fast by default; set `FAIL_ON_DEPENDENCY_ERROR=false` only when degraded startup is intentional. On `SIGINT` or `SIGTERM`, the server stops accepting connections and closes Redis and Prisma cleanly.

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
- Phase 14 provides Redis Caching — `src/common/cache/` reusable abstraction (`cache.config.js` `CACHE_TTL`/`CACHE_PREFIX pulseops:v1`, `cache.keys.js` tenant-safe keys with `sanitizeId` + `sha256` hash 16, `cache.service.js` `CacheService` with JSON serialization, `stripSensitive`, `logger.warn` fallback, `getOrSet`/`delByPattern` SCAN), existing `ioredis` reused, cache-aside with TTL 300s tenant/settings/permissions and 60s product lists, PostgreSQL authoritative, tenant isolation, invalidation after DB commit (tenant del both keys, permissions helpers, product lists delByPattern), Redis failure fallback (core DB ops continue), verified 27/27 Phase 14, 524/524 full with 15000ms timeout, 8 migrations (no new Phase 14 migration), dashboard metrics not cached by design (no dashboard).
- BullMQ, External integrations, Analytics, Swagger/OpenAPI, Docker/CI/CD are **NOT implemented yet**.
- Phase 7 uses local storage only; S3-compatible storage remains a future Phase 16 concern via StorageService abstraction; storage keys are server-generated and tenant-scoped.
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
| Phase 15 | BullMQ | ⏳ NEXT |
| Phase 16 | External Integrations | ⏳ Not started |
| Phase 17 | API Orchestration | ⏳ Not started |
| Phase 18 | Analytics | ⏳ Not started |
| Phase 19 | Performance | ⏳ Not started |
| Phase 20 | Security Hardening | ⏳ Not started |
| Phase 21 | Complete Testing | ⏳ Not started |
| Phase 22 | Swagger/OpenAPI | ⏳ Not started |
| Phase 23 | Docker/CI/CD/Deployment | ⏳ Not started |

**Phase 14 is COMPLETE and VERIFIED (HUMAN VERIFICATION: PASS) — 27/27 Phase 14 tests, 524/524 full suite with --testTimeout=15000, 15 suites, 8 migrations (no new Phase 14 migration — Redis is cache layer not DB table), Jest open-handle warning after full run is not a failure (async teardown). Phase 15 — Background Jobs / BullMQ is NEXT (NOT started, NOT implemented).**

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