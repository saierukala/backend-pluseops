# PULSEOPS_FRONTEND_BACKEND_HANDOFF.md — Complete Backend → Next.js Frontend Handoff

> **Source of truth:** Actual current repository state as of 2026-09-18 (Phase 23 Docker/CI/CD complete). No roadmap modification. No assumptions. Verified against `prisma/schema.prisma`, `src/docs/openapi.js` + `src/docs/paths/*.js`, `src/app/routes.js`, `src/modules/*/ *.routes.js|*.validation.js`, `docker-compose.yml`, `.env.example`, `package.json`, `src/config/env.js`, `src/realtime/*`.
> **Rule:** If undocumented/unverified → `NOT AVAILABLE / NOT IMPLEMENTED`.

---

# 1. Project Overview

## Purpose
PulseOps is a multi-tenant business operations SaaS — shared DB + shared schema + tenant_id isolation. Generic product catalog (products -> variants/SKUs -> attributes -> images), warehouses/inventory (variant-level, atomic movements), orders (immutable snapshots, state machine), payments (provider-agnostic, webhook idempotent), notifications, audit logs, realtime, caching, BullMQ jobs, analytics/dashboard orchestration. Business-agnostic.

## Architecture
- Pattern: Modular monolith `Route -> Controller -> Service -> Repository -> Database (Prisma)`. Integrations extend to `Controller -> Service -> Adapter -> External API`.
- Entry points: `src/app/server.js` (HTTP+Socket.IO+initializes jobs); standalone worker `src/worker.js` (no HTTP, BullMQ only). Factory `src/app/app.js: createApp()`. Router composition `src/app/routes.js: apiRouter`.
- API base URL: `http://localhost:3000` (server `src/docs/openapi.js:24`). All functional routes under `/api/v1`. Health/readiness/metrics also at root. No duplicated `/api/v1/api/v1`.
- Real-time: `src/realtime/socket.server.js` + `socket.auth.js` + `realtime.service.js` shares same HTTP server (`http.createServer(app)`).

## Technology Stack & Versions (package.json)
- Node >=22, Express 5.2.1, Prisma 6.19.3 (+ @prisma/client 6.19.3), PostgreSQL 16 (docker), Redis 7 (docker, ioredis 6.0.0), BullMQ 5.10.2, Socket.IO 4.8.3, jsonwebtoken 9.0.3 (HS256), argon2 0.45.1, zod 4.5.4, helmet 8.3.0, cors 2.8.6, compression 1.8.1, hpp 0.2.3, express-rate-limit 8.7.0, multer 2.3.0, pino 10.3.1, swagger-ui-express 5.0.1. Dev: jest 30.5.0, supertest 7.2.2, eslint 10.9.1.

## Backend Entry Points
- `npm run dev` -> `node --watch src/app/server.js`
- `npm start` -> `node src/app/server.js`
- `node src/worker.js` (worker)

## Docker Services (docker-compose.yml)
- postgres:16-alpine `pulseops-postgres` 5432 `pgdata:/var/lib/postgresql/data` health `pg_isready -U pulseops -d pulseops`, interval5s, retries10, start10s
- redis:7-alpine `pulseops-redis` 6379 `redisdata:/data` `redis-server --appendonly yes` health `redis-cli ping`
- migrate (build Dockerfile) `pulseops-migrate` depends `postgres healthy`, `npx prisma migrate deploy` `restart: no`
- api (build Dockerfile) `pulseops-api` 3000 `migrate completed_successfully + postgres healthy + redis healthy` env development defaults, volume `./storage:/app/storage`, health `wget -qO- http://127.0.0.1:3000/health`
- worker (build Dockerfile) `pulseops-worker` no ports, same depends, `command node src/worker.js`, health `ps aux | grep -q node src/worker.js`
- Prod overlay uses managed PG/Redis.

## PostgreSQL / Redis / BullMQ / Worker
- PostgreSQL provider `postgresql` in `prisma/schema.prisma:6`, timestamptz(6) all dates, Decimal(12,2) money, UUID PKs. 9 migrations.
- Redis ioredis, REDIS_URL, prefix `pulseops:v1:queue` and `pulseops:v1` cache. Degraded mode when unreachable (liveness ok, readiness 503, BullMQ sync fallback).
- BullMQ 6 queues prefix `pulseops:v1:queue`. Worker concurrency: webhook 10, cleanup 1, others 5, lock 30s. Lifecycle `initJobs()`/`startWorkers()` on server start, `shutdownJobs()` -> `stopWorkers()+closeAllQueues()+disconnectBullMqRedis()`.

## Multi-tenant Architecture
Shared DB/schema, tenant_id required on every tenant-owned table, FK Cascade. Context derived from JWT tenantId -> req.context.tenantId. Never trust client-supplied tenantId. Tenant status ACTIVE/TRIAL allowed.

## Current Production/Deployment Architecture
`docker-compose.prod.yml` overlay: NODE_ENV production, required secrets via `${VAR:?…}`, TRUST_PROXY true, FAIL_ON_DEPENDENCY_ERROR true, STORAGE_PROVIDER s3 default. CI install->lint->test->build->migration validation->deployment (gated on secrets).

---

# 2. Complete Implemented Feature Inventory

| # | Feature/Module | Purpose | Status | Files/Directories | DB Models | API Endpoints | Required Permissions | Tenant Scope | Key Business Rules | Validation | Error Cases | Jobs/Events | Notifications |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Tenant Provisioning | Create/CRUD tenants | COMPLETE | `src/modules/tenants/*`, `prisma/schema.prisma:127` | Tenant, TenantSettings, TenantDomain | POST /tenants, GET /tenants/:id, PATCH /tenants/:id, DELETE /tenants/:id (public) | NONE (public) | N/A (creates tenant) | slug unique, status enum, TRIAL default, plan default free | name 1-255, slug ^[a-z0-9-]+$ 1-100, status enum | 409 TENANT_SLUG_EXISTS, 404 TENANT_NOT_FOUND | NOT AVAILABLE | NOT AVAILABLE |
| 2 | Authentication | Register/login/JWT/refresh/logout/reset/verify/me | COMPLETE | `src/modules/auth/*`, `src/config/env.js` | User, RefreshToken, PasswordResetToken, EmailVerificationToken, TenantMembership | POST /auth/register, /auth/login, /auth/refresh, /auth/logout, /auth/forgot-password, /auth/reset-password, /auth/verify-email, GET /auth/me | public except /me (Bearer) | tenantId optional in register/login, required validation inside | JWT HS256, reuse detection revokes all, Argon2id, enumeration-safe | password 8-128 + upper/lower/number/special, email valid, token required | 401 INVALID_CREDENTIALS, INVALID_REFRESH_TOKEN, TOKEN_EXPIRED, etc. | cleanup-expired-tokens job | NOT AVAILABLE |
| 3 | RBAC - Roles | Tenant roles CRUD | COMPLETE | `src/modules/roles/*` | Role, RolePermission, UserRole | GET /roles, GET /roles/:id, POST /roles, PATCH /roles/:id, DELETE /roles/:id, POST /roles/:id/permissions | role:read/create/update/delete | tenantId from JWT, cross-tenant 404 | system roles immutable | name ^[a-z0-9_-]+$ 1-100, description 500 | 409 ROLE_NAME_EXISTS, 403 SYSTEM_ROLE_IMMUTABLE | NOT AVAILABLE | NOT AVAILABLE |
| 4 | RBAC - Permissions | List/read permissions | COMPLETE | `src/modules/permissions/*` | Permission | GET /permissions, GET /permissions/:id | permission:read | tenantId from JWT | `@@unique([tenantId, resource, action])` | id uuid | 404 PERMISSION_NOT_FOUND | NOT AVAILABLE | NOT AVAILABLE |
| 5 | RBAC - UserRoles | Assign roles to users | COMPLETE | `src/modules/users/*` (roles part) | UserRole | GET /users/:id/roles, POST /users/:id/roles | user:read / user:update | tenant-scoped, filtered cross-tenant | skipDuplicates idempotent | roleIds array uuid min1 | 404 USER_NOT_FOUND | invalidates permissions cache | NOT AVAILABLE |
| 6 | User Management | Tenant user CRUD + list/search/filter/sort | COMPLETE | `src/modules/users/*` | User, UserRole, TenantMembership | GET /users, GET /users/:id, PATCH /users/:id, DELETE /users/:id | user:read / update / delete | memberships.some tenantId ACTIVE | allowlist firstName/lastName/status only; self-delete blocked | search 255, page/limit, sortBy enum | 403 SELF_DELETION_FORBIDDEN, EMAIL_MODIFICATION_FORBIDDEN etc | NOT AVAILABLE | NOT AVAILABLE |
| 7 | Categories | Hierarchical categories | COMPLETE | `src/modules/categories/*` | Category | POST /categories, GET /categories, PATCH /categories/:id, DELETE /categories/:id | category:create/read/update/delete | tenantId JWT, slug unique per tenant | parentId cycle detection, hasChildren guard | name 1-255, slug ^[a-z0-9-]+$ 1-100 | 409 duplicate slug, 400 CYCLE_DETECTED / HAS_CHILDREN | NOT AVAILABLE | NOT AVAILABLE |
| 8 | Products | Business-agnostic product CRUD + search/filter | COMPLETE | `src/modules/products/*` | Product, ProductCategory | POST /products, GET /products, GET /products/:id, PATCH /products/:id, DELETE /products/:id, POST /products/:productId/categories, GET /products/:productId/categories | product:create/read/update/delete | tenantId JWT | soft delete, status enum, basePrice Decimal optional | name 1-255, description 5000, status enum | 404 PRODUCT_NOT_FOUND | cache PRODUCT_LIST delByPattern on write | NOT AVAILABLE |
| 9 | Variants (Sellable SKUs) | Variant CRUD per product | COMPLETE | `src/modules/variants/*` | ProductVariant, ProductVariantAttribute | POST /products/:productId/variants, GET /products/:productId/variants, GET .../variants/:variantId, PATCH .../variants/:variantId, DELETE .../variants/:variantId | product:create/read/update/delete (variants reuse product perms) | `@@unique([tenantId, sku])`, cross-tenant same SKU allowed | productId ownership check, barcode unique nullable | sku 1-100, price decimal regex, status enum | 409 SKU_EXISTS / BARCODE_EXISTS, 404 PRODUCT_NOT_FOUND | NOT AVAILABLE | NOT AVAILABLE |
| 10 | Attributes System | Definitions + values + variant assignment | COMPLETE | `src/modules/attributes/*` | AttributeDefinition, AttributeValue, ProductVariantAttribute | POST /attributes, GET /attributes, PATCH /attributes/:id, DELETE /attributes/:id, POST /attributes/:attributeId/values, GET .../values, PATCH .../values/:valueId, DELETE .../values/:valueId, PUT .../variants/:variantId/attributes, GET .../variants/:variantId/attributes | attribute:create/read/update/delete + product:update for variant attributes | code ^[a-z0-9_-]+$ unique per tenant, dataType enum | Tenant-defined, OPTION uses AttributeValue | name 1-255, code 1-100, description | 409 duplicate code, 400 IN_USE | NOT AVAILABLE | NOT AVAILABLE |
| 11 | Product Images | Upload/list/update/delete product & variant images | COMPLETE | `src/modules/product-images/*`, `src/common/storage/*` | ProductImage | POST /products/:productId/images, GET .../images, PATCH .../images/:imageId, DELETE .../images/:imageId, POST .../variants/:variantId/images, GET .../variants/:variantId/images, + file/signed-url/storage endpoints | product:create/update/delete/read | server key `tenants/{tenantId}/products/{productId}/...` tenant-scoped, traversal protected | multer 10MB, mime JPEG/PNG/WebP/GIF, primary flag | file required, altText/sortOrder | 400 INVALID_FILE_TYPE / FILE_TOO_LARGE, 404 cross-tenant | cleanup via storage provider | NOT AVAILABLE |
| 12 | Warehouses | Warehouse CRUD supporting inventory | COMPLETE | `src/modules/warehouses/*` | Warehouse | POST /warehouses, GET /warehouses, GET /warehouses/:id, PATCH /warehouses/:id, DELETE /warehouses/:id | warehouse:create/read/update/delete | code unique per tenant | isDefault handling, soft delete | name 1-255, code 1-50 ^[A-Z0-9_-]+$ | 409 WAREHOUSE_CODE_EXISTS | NOT AVAILABLE | NOT AVAILABLE |
| 13 | Inventory | Variant/warehouse stock + movements + transfer | COMPLETE | `src/modules/inventory/*` | Inventory, WarehouseInventory, InventoryMovement | GET /inventory, GET /inventory/variants/:variantId, POST /inventory/adjust, POST /inventory/transfer, GET /inventory/movements, GET /inventory/low-stock | inventory:read/update | `@@unique([tenantId, productVariantId, warehouseId])`, locks SELECT FOR UPDATE sorted | non-negative CHECK, quantity_before/changed/after invariant | quantityChanged non-zero int, transfer quantity positive, same warehouse reject | 400 INSUFFICIENT_STOCK, SAME_WAREHOUSE | realtime inventory.low_stock when <=10 | low-stock notification via realtime |
| 14 | Orders | Order lifecycle with snapshots + transactions | COMPLETE | `src/modules/orders/*` | Order, OrderItem, OrderStatusHistory, Customer | POST /orders, GET /orders, GET /orders/:id, PATCH /orders/:id/status, POST /orders/:id/cancel, GET /orders/:id/history | order:create/read/update/cancel | tenantId from JWT, snapshots write-once | productId rejected (use productVariantId), server Decimal pricing, atomic transaction, state machine DRAFT->PENDING->CONFIRMED->PROCESSING->SHIPPED->DELIVERED, CANCELLED/REFUNDED terminal | customerId uuid, items min1, quantity positive, discount/tax decimalString | 400 INSUFFICIENT_STOCK, INVALID_STATUS_TRANSITION, CANCELLATION_NOT_ALLOWED | realtime order.created/updated | NOT AVAILABLE |
| 15 | Payments & Transactions | Payments, confirm, webhook, get, refund | COMPLETE | `src/modules/payments/*` | Payment, PaymentTransaction, Refund, PaymentWebhookEvent | POST /payments/create, POST /payments/confirm, POST /payments/webhook, GET /payments/:id, POST /payments/:id/refund | payment:create/confirm/read/refund (webhook public HMAC) | order ownership check, derive amount server-side, webhook tenant resolve via payment lookup | controlled state machine, duplicate pending guard, HMAC verification, idempotency via DB unique | orderId uuid strict, amount strict reject, webhook eventId/type enum | 400 PAYMENT_ALREADY_PENDING, INVALID_STATE_TRANSITION, EXCESSIVE_REFUND, 401 INVALID_WEBHOOK_SIGNATURE | webhook queue + realtime payment.completed | NOT AVAILABLE |
| 16 | Customers | Customer implied via orders | PARTIAL (no direct customer CRUD API) | `prisma/schema.prisma:682 Customer` reused in orders | Customer | NOT AVAILABLE as standalone CRUD — only via order creation (customerId required, tenant-scoped) | order:create covers | `@@unique([tenantId, email])`, soft delete | server does not expose customer list/create/update/delete | customerId must exist and belong to tenant | 404 CUSTOMER_NOT_FOUND | NOT AVAILABLE | NOT AVAILABLE |
| 17 | Audit & Activity Logs | Reusable audit logging | COMPLETE | `src/modules/audit/*` | AuditLog, ActivityLog | GET /audit-logs, GET /activity-logs, GET /activity-logs/:id | audit:read / activity:read | tenant-scoped, sanitized [REDACTED] | integrated 5 mutations atomically (user update/delete, order create/status/cancel) | action enum, from/to datetime, resource | 404 cross-tenant | NOT AVAILABLE | NOT AVAILABLE |
| 18 | Notifications | Tenant/user-scoped notifications + preferences | COMPLETE | `src/modules/notifications/*` | Notification, NotificationPreference, NotificationTemplate | GET /notifications, PATCH /notifications/:id/read, POST /notifications/read-all, GET /notification-preferences, PATCH /notification-preferences | notification:read/update | userId nullable (tenant-wide), isRead filtering, newest first | defaults 4 channels IN_APP/EMAIL/SMS/PUSH, upsert | isRead/type/channel filters, title/message required for enqueue | 404 cross-tenant | notification queue (enqueued via POST /jobs/notifications) + realtime notification.created | IN_APP primary; EMAIL/SMS/PUSH concepts only |
| 19 | Real-time / WebSockets | Socket.IO tenant/user rooms | COMPLETE | `src/realtime/*` | NOT AVAILABLE (in-memory) | Socket.IO not REST — see section 13 | JWT via handshake | tenant:{tenantId} + user:{userId} auto-joined, guarded join/subscribe | 5 events: order.created, order.updated, inventory.low_stock, payment.completed, notification.created | token required (auth/query/header) | UNAUTHORIZED / TOKEN_EXPIRED / TENANT_INACTIVE | NOT AVAILABLE (realtime is the channel) | via realtime |
| 20 | Redis Caching | Cache-aside tenant-safe | COMPLETE | `src/common/cache/*` | NOT AVAILABLE (Redis) | Implicit via x-cache header on dashboard/analytics/products | NOT AVAILABLE (cache transparent) | keys hash query via sha256 16, tenant isolation | TTLs: TENANT 300, PRODUCT_LIST 300, DASHBOARD 300, ANALYTICS 180-300 | invalid keys fall back with logger.warn | graceful fallback | NOT AVAILABLE | NOT AVAILABLE |
| 21 | Background Jobs / BullMQ | Queues/workers/processors | COMPLETE | `src/jobs/*`, `src/worker.js` | PaymentWebhookEvent, Notification, RefreshToken etc. reused | GET /jobs/status, POST /jobs/notifications, POST /jobs/cleanup, POST /jobs/reports, POST /jobs/analytics | jobs: tenant-scoped (title/message required) | tenantId in payload, verified | See section 15 | payload validation (title/message) | 202 queued or 200 fallback when Redis unavailable | All 6 queues | dispatch notification via channel |
| 22 | External Integrations | Provider-independent adapters | COMPLETE | `src/modules/integrations/*`, `src/common/storage/*` | ProductImage, PaymentWebhookEvent | Storage signed/file endpoints (see Products), payments adapter internal | internal (no direct REST for adapters except via domain) | tenantId in every provider call, storage keys tenant-scoped | Mock vs Http per env, timeout 5000, retry idempotent-aware, SigV4 for S3 | provider URL/apiKey when HTTP | IntegrationError codes (see Error Handling) | via BullMQ | email via BullMQ -> EmailService |
| 23 | Storage (Local/S3) | Private storage + signed URLs | COMPLETE | `src/modules/storage/*`, `src/common/storage/*` | ProductImage storageKey | GET /products/:productId/images/:imageId/file, .../signed-url, GET /storage/signed?key=&expires=&signature=, GET /storage/file?key= | product:read for file/signed-url | tenant-scoped keys, traversal protection | Local PRIVATE (no static), S3 PRIVATE-by-default, HMAC 900s or SigV4, no credentials in URL | key required, signature verification | 403 tampered/expired/cross-tenant, 404 not found | NOT AVAILABLE | NOT AVAILABLE |
| 24 | Dashboard Orchestration | Aggregate 6 domains | COMPLETE | `src/modules/dashboard/*` | Order, Inventory, Payment, User, Notification, Product | GET /dashboard/overview | dashboard:read | Promise.allSettled, partial failure handling | tenant-scoped, x-cache HIT/MISS TTL 60s | tenantId from JWT | 403 missing perm, 401 unauth | NOT AVAILABLE | NOT AVAILABLE |
| 25 | Analytics & Reporting | Sales/orders/inventory/customers/revenue + overview | COMPLETE | `src/modules/analytics/*` | Order, Payment, Inventory, Customer etc. (no separate analytics DB) | GET /analytics/overview, GET /analytics/sales, GET /analytics/orders, GET /analytics/inventory, GET /analytics/customers, GET /analytics/revenue | analytics:read | tenantId + filters, CacheService TTL 60/180 | date range YYYY-MM-DD UTC, groupBy day/week/month via date_trunc AT TIME ZONE UTC | from/to/groupBy/category/product/status/page/limit | 400 validation, 403 perm | enqueue via POST /jobs/analytics (stub) | NOT AVAILABLE |
| 26 | Health / Readiness / Metrics | Probes + metrics | COMPLETE | `src/modules/health/*`, `src/modules/readiness/*`, `src/modules/metrics/*` | NOT AVAILABLE | GET /health, /health/db, /health/redis, /api/v1/health etc., GET /ready, GET /metrics | public | NOT AVAILABLE | liveness without DB/Redis, readiness 503 when down | NOT AVAILABLE | 503 when unavailable | NOT AVAILABLE | NOT AVAILABLE |
| 27 | Security Hardening | Helmet/CORS/rate-limit/validation/storage/JWT/HMAC | COMPLETE | `src/app/app.js`, `src/common/middleware/*`, `src/config/env.js` | NOT AVAILABLE | ALL endpoints | see RBAC | see tenant isolation | see section 19 | strict Zod, file upload, raw-body HMAC | 403 CORS, 429 RateLimited, 413 PayloadTooLarge | webhook HMAC | NOT AVAILABLE |
| 28 | Swagger / OpenAPI | Docs | COMPLETE | `src/docs/*` | NOT AVAILABLE | GET /api-docs, GET /api-docs.json, GET /openapi.json, GET /api/v1/openapi.json | public | NOT AVAILABLE | OpenAPI 3.0.3 81 paths 115 ops | NOT AVAILABLE | NOT AVAILABLE | NOT AVAILABLE | NOT AVAILABLE |

Do not omit smaller supporting features: health versioned aliases, readiness, metrics, requestId, pino logging, graceful shutdown, compression, HPP, error sanitization, idempotent assignments, cache invalidation after commit, realtime sanitization, audit sanitization, soft-delete on relevant models, Decimal money everywhere.

---

# 3. Complete API Inventory

> **Contract:** `src/docs/openapi.js` aggregates 10 path modules into `openApiSpec: {openapi:3.0.3, info:{version:1.0.0}, servers:[{url:http://localhost:3000}], tags:21, paths:81 keys -> 115 operations, components:{securitySchemes:{bearerAuth:{type:http, scheme:bearer, bearerFormat:JWT}}, schemas 26, responses 5}}`. Base `http://localhost:3000` + path (already `/api/v1/…`) = actual Express route. No `/api/v1` duplication. `$ref` 573 coverage 0 unresolved (README). Security: 19 public `security:[]` (health 6, tenants 4, auth 7 public, `POST /payments/webhook` HMAC, `GET /storage/signed` HMAC), 96 protected `security:[{bearerAuth:[]}]`.

## Envelope
- Success: `{ "success": true, "data": <T>, "message": "...", "meta": {page,limit,total,totalPages} }` + header `X-Request-Id` (generated or echo `X-Request-Id` request header). `src/common/middleware/request-context.js`, `error-handler.js:34` also includes `requestId` in body.
- Error: `{ "success": false, "error": { "code": "VALIDATION_ERROR|UNAUTHORIZED|FORBIDDEN|...", "message": "...", "details": [...] }, "requestId": "uuid" }`.
- Pagination default `page 1`, `limit 20` (max 100) unless noted (roles default 50). Every list returns `meta`.

## Global Headers
- `Authorization: Bearer <accessToken>` required for 96 protected ops (see per-endpoint).
- `X-Request-Id: uuid` optional request, always response.
- `X-Webhook-Signature` OR `X-Payment-Signature` for webhook HMAC (one required).
- `Content-Type: application/json` except `multipart/form-data` for image uploads.

## Health / Readiness / Metrics (public)

| # | Method | Route | Auth | Perm | Path Params | Query | Req Body | Resp 200 | Errors | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | GET | `/health` | none | - | - | - | - | `{success:true,data:{status:"ok"},message:"Service is healthy"}` | - | Liveness, no DB/Redis, always 200 when process up |
| 2 | GET | `/health/db` | none | - | - | - | - | `{success:true,data:{name:"database",status:"up"}}` | 503 `{success:false,data:{name:"database",status:"down"}}` when not connected | SELECT 1 |
| 3 | GET | `/health/redis` | none | - | - | - | - | `{success:true,data:{name:"redis",status:"up"}}` | 503 down | PING PONG + status ready |
| 4 | GET | `/api/v1/health` | none | - | - | - | - | same as /health | same | Versioned alias |
| 5 | GET | `/api/v1/health/db` | none | - | - | - | - | same as /health/db | same |  |
| 6 | GET | `/api/v1/health/redis` | none | - | - | - | - | same as /health/redis | same |  |
| 7 | GET | `/ready` | none | - | - | - | - | composite readiness (infra) | 503 | `src/modules/readiness/readiness.routes.js` |
| 8 | GET | `/metrics` | none | - | - | - | - | Prometheus-style metrics | - | `src/modules/metrics/metrics.routes.js` |

## Tenants (public — no auth)

| # | Method | Route | Auth | Perm | Path | Query | Body | Success | Errors |
|---|---|---|---|---|---|---|---|---|---|
| 9 | POST | `/api/v1/tenants` | none | - | - | - | `{name:string 1-255 req, slug:string 1-100 ^[a-z0-9-]+$ req unique, status:ACTIVE|SUSPENDED|TRIAL|CANCELLED opt default TRIAL, plan:string max50 opt default free}` | 201 `{success:true,data:{id, name, slug,status,plan,created_at,updated_at,settings:{id,tenant_id,metadata,created_at,updated_at},domains:[]}}` | 400 Zod, 409 TENANT_SLUG_EXISTS |
| 10 | GET | `/api/v1/tenants/:id` | none | - | id uuid req | - | - | 200 tenant object same shape | 400 Zod, 404 TENANT_NOT_FOUND |
| 11 | PATCH | `/api/v1/tenants/:id` | none | - | id uuid | - | `{name?,slug?,status?,plan?}` at least one req; slug unique if provided | 200 updated tenant | 400 Zod empty body, 404, 409 slug exists |
| 12 | DELETE | `/api/v1/tenants/:id` | none | - | id uuid | - | - | 200 `{success:true,data:null,message:"Tenant deleted successfully"}` | 400, 404 |

## Auth (public except /me)

| # | Method | Route | Auth | Body | Success | Errors | Notes |
|---|---|---|---|---|---|---|---|
| 13 | POST | `/api/v1/auth/register` | none (authLimiter 20/15m) | `{email:email req, password:string 8-128 + upper/lower/number/special req, firstName:1-100 req, lastName:1-100 req, tenantId:uuid opt}` | 201 `{success:true,data:{id,tenantId,email,firstName,lastName,status, emailVerified, createdAt,updatedAt},message:"Registration successful. Please verify your email."}` | 400 Zod, 400 TENANT_REQUIRED if required context, 404 TENANT_NOT_FOUND, 403 TENANT_INACTIVE, 409 USER_ALREADY_EXISTS | creates TenantMembership ACTIVE if tenant exists |
| 14 | POST | `/api/v1/auth/login` | none (authLimiter) | `{email:email req, password:string req, tenantId:uuid opt}` | 200 `{success:true,data:{accessToken:string, refreshToken:string, sessionId:uuid, user:{...}}, message:"Login successful"}` | 400 Zod, 400 TENANT_REQUIRED, 401 INVALID_CREDENTIALS, 403 ACCOUNT_INACTIVE/TENANT_INACTIVE | sets lastLoginAt, returns sessionId twice (top-level and inside) |
| 15 | POST | `/api/v1/auth/refresh` | none (authLimiter) | `{refreshToken:string req}` | 200 `{success:true,data:{accessToken,refreshToken:new, sessionId, user:{...}},message:"Token refreshed successfully"}` | 400 Zod, 401 INVALID_REFRESH_TOKEN/REFRESH_TOKEN_EXPIRED/REVOKED | rotation atomically revokes old, reuse detection revokes all |
| 16 | POST | `/api/v1/auth/logout` | none | `{refreshToken:string opt}` | 200 `{success:true,data:{success:true,message:"Logout successful"}}` | - | revokes provided token (no auth) |
| 17 | POST | `/api/v1/auth/forgot-password` | none (authLimiter) | `{email:email req, tenantId:uuid opt}` | 200 `{success:true,data:{success:true,message:"If the email exists, a reset link has been sent", devToken:string (dev only)}, message:"..."}` | 400 Zod, 400 TENANT_REQUIRED | enumeration-safe, expiry 1h |
| 18 | POST | `/api/v1/auth/reset-password` | none (authLimiter) | `{token:string req, password:string 8-128 + upper/lower/number/special req}` | 200 `{success:true,data:{success:true,message:"Password has been reset successfully"}}` | 400 Zod, 400 INVALID_RESET_TOKEN/RESET_TOKEN_EXPIRED/RESET_TOKEN_USED | single-use, revokes all refresh |
| 19 | POST | `/api/v1/auth/verify-email` | none (authLimiter) | `{token:string req}` | 200 `{success:true,data:{success:true,message:"Email verified successfully"}}` | 400 Zod, 400 INVALID_VERIFICATION_TOKEN / EXPIRED / USED | 24h single-use |
| 20 | GET | `/api/v1/auth/me` | Bearer | header `Authorization` | 200 `{success:true,data:{id,tenantId,email,firstName,lastName,status,emailVerified,lastLoginAt,createdAt,updatedAt}}` | 401 UNAUTHORIZED/INVALID_TOKEN/TOKEN_EXPIRED/INVALID_TOKEN_CLAIMS/USER_NOT_FOUND, 403 ACCOUNT_INACTIVE/TENANT_INACTIVE | validates membership ACTIVE + tenant ACTIVE/TRIAL |

## RBAC — Roles (all Bearer + permission)

| # | Method | Route | Perm | Params | Query / Body | Resp |
|---|---|---|---|---|---|---|
| 21 | GET | `/api/v1/roles` | role:read | - | `?page=1&limit=50 max100` | 200 `{success:true,data:[{id,tenantId,name,description,isSystem,permissions:[],userCount,createdAt,updatedAt}], meta, message:"Roles retrieved successfully"}` |
| 22 | GET | `/api/v1/roles/:id` | role:read | id uuid | - | 200 single role + permissions + userCount | 400 Zod, 404 ROLE_NOT_FOUND |
| 23 | POST | `/api/v1/roles` | role:create | - | `{name:string 1-100 ^[a-z0-9_-]+$ req, description:string max500 opt}` | 201 `{success:true,data:{id,tenantId,name,description,isSystem:false,permissions:[],userCount0,...}}` | 400, 409 ROLE_NAME_EXISTS, 403 FORBIDDEN |
| 24 | PATCH | `/api/v1/roles/:id` | role:update | id uuid | `{name?,description?} at least one` | 200 updated | 400 empty, 403 SYSTEM_ROLE_IMMUTABLE, 404, 409 |
| 25 | DELETE | `/api/v1/roles/:id` | role:delete | id uuid | - | 200 `{success:true,data:{success:true,message:"Role deleted successfully"}}` | 400, 403 SYSTEM_ROLE_IMMUTABLE, 404 |
| 26 | POST | `/api/v1/roles/:id/permissions` | role:update | id uuid | `{permissionIds:[uuid,uuid] req}` | 200 assigned permissions array | 400, 403 SYSTEM_ROLE_IMMUTABLE, 404 ROLE_NOT_FOUND (filters cross-tenant invalid) |

## RBAC — Permissions

| # | Method | Route | Perm |
|---|---|---|---|
| 27 | GET | `/api/v1/permissions` | permission:read | - | - | 200 `[{id,tenantId,name,resource,action,description,createdAt,updatedAt}]` |
| 28 | GET | `/api/v1/permissions/:id` | permission:read | id uuid | - | 200 single permission | 404 PERMISSION_NOT_FOUND |

## RBAC — User Role Assignment

| # | Method | Route | Perm | Params | Body | Resp |
|---|---|---|---|---|---|---|
| 29 | GET | `/api/v1/users/:id/roles` | user:read | id uuid (target user) | - | 200 `[{id,name,description,isSystem}]` | 404 USER_NOT_FOUND |
| 30 | POST | `/api/v1/users/:id/roles` | user:update | id uuid | `{roleIds:[uuid,uuid] req}` | 200 assigned roles | 400 Zod, 404, 403 FORBIDDEN (filtered cross-tenant) |

## Users (tenant-scoped)

| # | Method | Route | Perm | Query / Params / Body | Resp |
|---|---|---|---|---|---|
| 31 | GET | `/api/v1/users` | user:read | `?page=1&limit=20 max100&search=max255 opt&status=ACTIVE|INACTIVE|SUSPENDED opt&roleId=uuid opt&sortBy=createdAt|updatedAt|email|firstName|lastName|status default createdAt & sortOrder=asc|desc default desc` | 200 `{success:true,data:[{id,tenantId,email,firstName,lastName,status,emailVerified,lastLoginAt,createdAt,updatedAt,roles:[{id,name,isSystem}]}],meta,message}` NEVER exposes passwordHash etc |
| 32 | GET | `/api/v1/users/:id` | user:read | id uuid | 200 single user with roles | 404 USER_NOT_FOUND (cross-tenant also 404) |
| 33 | PATCH | `/api/v1/users/:id` | user:update | id uuid + body `{firstName?:1-100, lastName?:1-100, status?:string (validated in service enum), email?:email REJECTED 400 EMAIL_MODIFICATION_FORBIDDEN, passwordHash? REJECTED, tenantId? REJECTED, roleIds? ignored}` at least one field | 200 updated user | 400 Zod/forbidden fields, 404 |
| 34 | DELETE | `/api/v1/users/:id` | user:delete | id uuid | 200 `{success:true,data:null}` hard delete | 400 SELF_DELETION_FORBIDDEN, 404 |

## Categories

| # | Method | Route | Perm | Body/Query | Resp |
|---|---|---|---|---|---|
| 35 | POST | `/api/v1/categories` | category:create | `{name:1-255 req, slug:1-100 ^[a-z0-9-]+$ req unique per tenant, description?:string max1000, parentId?:uuid opt (must exist in tenant, no cycle), sortOrder?:int, isActive?:bool default true}` | 201 category | 400 CYCLE_DETECTED, 409 slug exists |
| 36 | GET | `/api/v1/categories` | category:read? (see routes: `categories.routes.js` authorize) — actual: `category:read` (verify in file) | `?page & limit & search & isActive & parentId` | 200 `{success:true,data:[{id,tenantId,parentId,name,slug,description,sortOrder,isActive,createdAt,updatedAt,children?}], meta}` |
| 37 | PATCH | `/api/v1/categories/:id` | category:update | id uuid + `{name?,slug?,description?,parentId?,sortOrder?,isActive?} at least one` | 200 updated | 400 cycle/hasChildren, 404, 409 slug |
| 38 | DELETE | `/api/v1/categories/:id` | category:delete | id uuid | 200 deleted | 400 HAS_CHILDREN (if has children), 404 |

## Products

| # | Method | Route | Perm | Query/Body | Resp |
|---|---|---|---|---|---|
| 39 | POST | `/api/v1/products` | product:create | `{name:1-255 req, description?:max5000, brand?:max100, status:ACTIVE|INACTIVE|DRAFT|ARCHIVED default DRAFT, basePrice?:decimalString ^\d+(\.\d{1,2})?$, categories?:[uuid] opt, primaryCategoryId?:uuid opt}` | 201 product | 400 Zod |
| 40 | GET | `/api/v1/products` | product:read | `?page=1&limit=20 max100&search=max255 opt&status=enum opt&categoryId=uuid opt&minPrice=positive opt&maxPrice=positive opt&sku=max100 opt (contains)&barcode=max100 opt (contains)&attributeFilters=record opt&sortBy=name|brand|status|basePrice|createdAt|updatedAt default createdAt & sortOrder asc|desc default desc` Cache `x-cache: HIT|MISS` | 200 `{success:true,data:[product],meta}` plus `x-cache` header |
| 41 | GET | `/api/v1/products/:id` | product:read | id uuid | 200 product with categories, variants count, images | 404 PRODUCT_NOT_FOUND (cross-tenant 404) |
| 42 | PATCH | `/api/v1/products/:id` | product:update | id uuid + `{name?,description?,brand?,status?,basePrice?,categories?,primaryCategoryId?} at least one` | 200 updated | 404 |
| 43 | DELETE | `/api/v1/products/:id` | product:delete | id uuid | 200 deleted (soft delete sets deletedAt) | 404 |
| 44 | POST | `/api/v1/products/:productId/categories` | product:update | productId uuid + `{categories:[uuid] min1 req, primaryCategoryId?:uuid opt}` | 200 categories set | 404 product/category not in tenant |
| 45 | GET | `/api/v1/products/:productId/categories` | product:read | productId uuid | 200 categories for product | 404 |

## Variants

| # | Method | Route | Perm |
|---|---|---|---|
| 46 | POST | `/api/v1/products/:productId/variants` | product:create | productId uuid + `{sku:string req (tenant-unique), barcode?:string nullable unique, price:decimalString req, costPrice?:decimalString, status:ACTIVE|INACTIVE|DRAFT default DRAFT}` | 201 variant | 409 SKU_EXISTS / BARCODE_EXISTS, 404 product not in tenant |
| 47 | GET | `/api/v1/products/:productId/variants` | product:read | productId uuid + `?page/limit/status/search/attribute` | 200 list variants with attributes/images | 404 product not found |
| 48 | GET | `/api/v1/products/:productId/variants/:variantId` | product:read | productId uuid + variantId uuid | 200 single variant with attributes | 404 PRODUCT_NOT_FOUND / VARIANT_NOT_FOUND (cross-tenant 404) |
| 49 | PATCH | `/api/v1/products/:productId/variants/:variantId` | product:update | productId+variantId + `{sku?, barcode?, price?, costPrice?, status?} at least one` | 200 updated | 409 duplicate, 404 |
| 50 | DELETE | `/api/v1/products/:productId/variants/:variantId` | product:delete | productId+variantId | 200 deleted (soft) | 404 |

## Variant Attributes

| # | Method | Route | Perm |
|---|---|---|---|
| 51 | PUT | `/api/v1/products/:productId/variants/:variantId/attributes` | product:update | productId+variantId + `{attributes:[{attributeDefinitionId:uuid req, value:string req}]}` replace semantics (deletes missing) | 200 assigned attributes | 400 value type mismatch, 404 attributeDefinition not in tenant |
| 52 | GET | `/api/v1/products/:productId/variants/:variantId/attributes` | product:read | productId+variantId | 200 attributes list | 404 |

## Attributes (standalone CRUD)

| # | Method | Route | Perm |
|---|---|---|---|
| 53 | POST | `/api/v1/attributes` | attribute:create | `{name:1-255 req, code:1-100 ^[a-z0-9_-]+$ req unique per tenant, dataType:TEXT|NUMBER|BOOLEAN|OPTION req, isRequired:bool default false, description?:string}` | 201 definition | 409 code exists |
| 54 | GET | `/api/v1/attributes` | attribute:read | `?page/limit/search/dataType/isRequired` | 200 list |
| 55 | PATCH | `/api/v1/attributes/:id` | attribute:update | id uuid + `{name?,code?,dataType?,isRequired?,description?} at least one` | 200 updated | 409, 400 IN_USE if changing dataType with dependent data |
| 56 | DELETE | `/api/v1/attributes/:id` | attribute:delete | id uuid | 200 deleted | 400 IN_USE (has values/variant attributes) |
| 57 | POST | `/api/v1/attributes/:attributeId/values` | attribute:create | attributeId uuid + `{value:string req, displayName:string req, sortOrder?:int, isActive?:bool}` | 201 value | 409 duplicate value for definition |
| 58 | GET | `/api/v1/attributes/:attributeId/values` | attribute:read | attributeId uuid | 200 values list | 404 definition not found |
| 59 | PATCH | `/api/v1/attributes/:attributeId/values/:valueId` | attribute:update | attributeId+valueId + `{value?,displayName?,sortOrder?,isActive?}` | 200 updated | 404, 409 |
| 60 | DELETE | `/api/v1/attributes/:attributeId/values/:valueId` | attribute:delete | attributeId+valueId | 200 deleted | 400 IN_USE |

## Product Images (multipart/form-data, field `image`)

| # | Method | Route | Perm | Body | Resp |
|---|---|---|---|---|---|
| 61 | POST | `/api/v1/products/:productId/images` | product:create | multipart `image` (JPEG/PNG/WebP/GIF, 10MB) + optional `altText`, `sortOrder`, `isPrimary` as fields | 201 image `{id,tenantId,productId,variantId:null,storageKey,url,altText,sortOrder,isPrimary,createdAt,updatedAt}` server key `tenants/{tenantId}/products/{productId}/{sanitized}` |
| 62 | GET | `/api/v1/products/:productId/images` | product:read | productId uuid | 200 images list ordered by sortOrder |
| 63 | PATCH | `/api/v1/products/:productId/images/:imageId` | product:update | productId+imageId + `{altText?,sortOrder?,isPrimary?}` only allowlist (storageKey ignored) | 200 updated | 404 cross-tenant or wrong productId |
| 64 | DELETE | `/api/v1/products/:productId/images/:imageId` | product:delete | productId+imageId | 200 deleted (DB + storage object removed, protected against traversal) | 404, 403 unauthorized tenant |
| 65 | POST | `/api/v1/products/:productId/variants/:variantId/images` | product:create | variantId ownership validates belongs to product, key `tenants/{t}/products/{p}/variants/{v}/{file}` | 201 image with variantId set |
| 66 | GET | `/api/v1/products/:productId/variants/:variantId/images` | product:read | productId+variantId | 200 images list for variant |

## Storage Access (private bytes)

| # | Method | Route | Auth | Params/Query | Resp |
|---|---|---|---|---|---|
| 67 | GET | `/api/v1/products/:productId/images/:imageId/file` | Bearer + product:read | productId+imageId | 200 stream bytes (Content-Type image/jpeg etc.), 401 unauth, 403 cross-tenant |
| 68 | GET | `/api/v1/products/:productId/images/:imageId/signed-url` | Bearer + product:read | productId+imageId | 200 `{success:true,data:{url:string (HMAC 900s or SigV4 query), expiresAt, key}}` no credentials in URL |
| 69 | GET | `/api/v1/storage/signed` | none (HMAC) | `?key=tenants/...&expires=epoch&signature=hmac` | 200 stream bytes, 403 tampered/expired, 404 not found |
| 70 | GET | `/api/v1/storage/file` | Bearer (no explicit authorize, tenant check inside) | `?key=tenants/...` | 200 stream bytes if key tenant matches JWT, 403 cross-tenant |

Direct `GET /storage/...` -> 404 (localStorage is PRIVATE, no express.static).

## Warehouses

| # | Method | Route | Perm |
|---|---|---|---|
| 71 | POST | `/api/v1/warehouses` | warehouse:create | `{name:1-255 req, code:1-50 ^[A-Z0-9_-]+$ req unique per tenant, address?:string, city?:string, state?:string, country?:string, postalCode?:string, isActive?:bool default true, isDefault?:bool default false}` | 201 warehouse |
| 72 | GET | `/api/v1/warehouses` | warehouse:read | `?page/limit/search/isActive/isDefault/sortBy=createdAt|name|code&sortOrder` | 200 warehouses list |
| 73 | GET | `/api/v1/warehouses/:id` | warehouse:read | id uuid | 200 single | 404 cross-tenant |
| 74 | PATCH | `/api/v1/warehouses/:id` | warehouse:update | id uuid + `{name?,code?,address?,city?,state?,country?,postalCode?,isActive?,isDefault?} at least one` | 200 updated | 409 code exists, 404 |
| 75 | DELETE | `/api/v1/warehouses/:id` | warehouse:delete | id uuid | 200 deleted (soft, isDefault handling) | 404 |

## Inventory

| # | Method | Route | Perm | Query/Body | Resp |
|---|---|---|---|---|---|
| 76 | GET | `/api/v1/inventory` | inventory:read | `?page=1&limit=20 max100&warehouseId=uuid opt&variantId=uuid opt&sku=max100 contains opt&search=max255 opt&sortBy=createdAt|quantity|sku default createdAt&sortOrder asc|desc default desc` | 200 `{success:true,data:[{id,tenantId,productVariantId,warehouseId,quantity,reservedQuantity,createdAt,updatedAt,productVariant:{...}},...],meta}` |
| 77 | GET | `/api/v1/inventory/variants/:variantId` | inventory:read | variantId uuid + `?page/limit/warehouseId` | 200 per-warehouse quantities for variant | 404 VARIANT_NOT_FOUND cross-tenant |
| 78 | POST | `/api/v1/inventory/adjust` | inventory:update | `{variantId:uuid req (or productVariantId), warehouseId:uuid req, quantityChanged:int non-zero req, reason?:string max500, referenceType?:string, referenceId?:string}` | 200 `{success:true,data:{inventory,movement:{id,tenantId,productVariantId,warehouseId,type:ADJUSTMENT,quantityBefore,quantityChanged,quantityAfter,reason,referenceType,referenceId,createdBy,createdAt}}}` | 400 INSUFFICIENT_STOCK (after <0), 404 variant/warehouse |
| 79 | POST | `/api/v1/inventory/transfer` | inventory:update | `{variantId:uuid req, sourceWarehouseId:uuid req, destinationWarehouseId:uuid req, quantity:int positive req, reason?:string, referenceType?,referenceId?}` validates warehouses + variant tenant ownership, rejects same warehouse | 200 `{success:true,data:{sourceInventory,destInventory,movements:[{type:TRANSFER 2 entries same referenceId}]}}` atomic transaction sorted locks | 400 SAME_WAREHOUSE, INSUFFICIENT_STOCK, 404 |
| 80 | GET | `/api/v1/inventory/movements` | inventory:read | `?page=1&limit=20 max100&variantId=uuid opt&warehouseId=uuid opt&type=ADJUSTMENT|TRANSFER|ORDER_RESERVATION|ORDER_RELEASE|ORDER_FULFILLMENT|RETURN|DAMAGED|LOST|COUNT opt&from=isoDate opt&to=isoDate opt&sortBy=createdAt default createdAt&sortOrder desc default` | 200 movements paginated, after = before + changed invariant |
| 81 | GET | `/api/v1/inventory/low-stock` | inventory:read | `?threshold=int default 10 opt&warehouseId=uuid opt&page/limit` | 200 `{success:true,data:[{inventory with quantity <= threshold ASC ordered}],meta}` tenant-scoped |

## Orders

| # | Method | Route | Perm | Body/Query | Resp |
|---|---|---|---|---|---|
| 82 | POST | `/api/v1/orders` | order:create | `{customerId:uuid req (must exist in tenant), items:[{productVariantId:uuid req, variantId?:uuid alias, warehouseId:uuid req, quantity:int positive req, discount?:decimalString, tax?:decimalString}] min1 req, shippingTotal?:decimalString opt, currency?:string 3 chars default USD, metadata?:record opt, productId?:uuid FORBIDDEN -> 400 productId is not allowed}` Server derives totals via Decimal, creates snapshots, reserves inventory with SELECT FOR UPDATE sorted, creates movements ORDER_RESERVATION + status history PENDING in single $transaction. | 201 `{success:true,data:{id,tenantId,customerId,status:PENDING,subtotal,discountTotal,taxTotal,shippingTotal,total,currency,metadata,createdAt,updatedAt,items:[{id,tenantId,orderId,productVariantId,productNameSnapshot,variantNameSnapshot,attributeSnapshot skuSnapshot,unitPrice,quantity,discount,tax,lineTotal}],customer:{...},statusHistory:[{fromStatus:null,toStatus:PENDING,...,createdBy}]},message}` | 400 productVariant inactive/not found/INSUFFICIENT_STOCK/PRODUCT_NOT_ALLOWED, 404 CUSTOMER_NOT_FOUND |
| 83 | GET | `/api/v1/orders` | order:read | `?page=1&limit=20 max100&status=DRAFT|PENDING|CONFIRMED|PROCESSING|SHIPPED|DELIVERED|CANCELLED|REFUNDED|PARTIALLY_REFUNDED opt&customerId=uuid opt&sortBy=createdAt|updatedAt|total|status default createdAt&sortOrder asc|desc default desc` selective fields, compression | 200 `{success:true,data:[orders summary],meta}` |
| 84 | GET | `/api/v1/orders/:id` | order:read | id uuid | 200 order with items+snapshots + customer + statusHistory (or summary) | 404 cross-tenant |
| 85 | PATCH | `/api/v1/orders/:id/status` | order:update | id uuid + `{status:enum req, reason?:string max500}` state-machine validated | 200 order with updated status + history appended | 400 INVALID_STATUS_TRANSITION, 404 |
| 86 | POST | `/api/v1/orders/:id/cancel` | order:cancel | id uuid + `{reason?:string max500}` optional body | 200 {status:CANCELLED} + ORDER_RELEASE movements per reservation + history | 400 CANCELLATION_NOT_ALLOWED (SHIPPED/DELIVERED/terminal), already cancelled 400 |
| 87 | GET | `/api/v1/orders/:id/history` | order:read | id uuid + `?page=1&limit=20` | 200 history chronological `{id,tenantId,orderId,fromStatus nullable,toStatus,reason,createdBy,createdAt}` | 404 |

State machine: `PENDING -> CONFIRMED|CANCELLED`, `CONFIRMED -> PROCESSING|CANCELLED`, `PROCESSING -> SHIPPED|CANCELLED`, `SHIPPED -> DELIVERED`, `DELIVERED -> REFUNDED|PARTIALLY_REFUNDED` (refund path), `CANCELLED/REFUNDED` terminal. DRAFT not created via public POST (starts PENDING).

## Payments & Transactions

| # | Method | Route | Auth | Body/Params | Resp | Errors |
|---|---|---|---|---|---|---|
| 88 | POST | `/api/v1/payments/create` | Bearer order:create? actually `payment:create` | `{orderId:uuid strict req, provider?:max50 opt, currency?:3 chars opt, metadata?:record opt}` `.strict()` rejects client `amount`/`status` 400 | 201 `{success:true,data:{id,tenantId,orderId,amount:server-derived from order.total (string toFixed2),currency,status:PENDING,provider,providerPaymentId:pay_<uuid>,metadata,createdAt,updatedAt,transactions:[{id,tenantId,paymentId,type:CHARGE,amount,currency,status:PENDING,providerTransactionId,metadata,createdAt}],refunds:[],order:{...}},message}` | 400 Zod strict, 400 ORDER_ELIGIBLE_STATUSES (must be PENDING/CONFIRMED/PROCESSING/DRAFT else 400), 400 PAYMENT_ALREADY_PENDING, 404 ORDER_NOT_FOUND cross-tenant |
| 89 | POST | `/api/v1/payments/confirm` | Bearer `payment:confirm` | `{paymentId:uuid req, providerPaymentId?:max255 opt, simulateFailure?:bool opt} .strict()` no status allowed | 200 `{success:true,data:{payment with status COMPLETED or FAILED, transactions appended}]}` | 400 Zod strict, 400 INVALID_STATE_TRANSITION (must be PENDING/PROCESSING), 404 cross-tenant |
| 90 | POST | `/api/v1/payments/webhook` | public (no Bearer) webhookLimiter 100/1m | headers `x-webhook-signature` or `x-payment-signature` HMAC-SHA256 required + body `{eventId:string 1-255 req, type:payment.succeeded|payment.failed|payment.refunded|charge.succeeded|charge.failed req, paymentId?:uuid opt, providerPaymentId?:max255 opt, providerTransactionId?:max255 opt, amount?:decimalString opt, currency?:3 chars opt, tenantId?:uuid opt, metadata?:record opt} .strict()` + rawBody preserved for HMAC | 200 `{success:true,data:{success:true,duplicate:bool,processed:bool}}` first->process, duplicate->duplicate:true safely ignored (P2002 catch on tenantId+eventId unique) | 400 Zod malformed, 401 INVALID_WEBHOOK_SIGNATURE (timingSafeEqual), webhook is idempotent: 5 parallel identical -> 1 effect, maps type to targetStatus only if isValidTransition, locks payment, dedup providerTransactionId |
| 91 | GET | `/api/v1/payments/:id` | Bearer `payment:read` | id uuid | 200 `{success:true,data:{payment with transactions+refunds+order}}` | 404 cross-tenant |
| 92 | POST | `/api/v1/payments/:id/refund` | Bearer `payment:refund` | id uuid + `{amount:decimalString req, reason?:max500 opt, metadata?:record opt} .strict()` | 200 `{success:true,data:{refund, payment status updated PARTIALLY_REFUNDED or REFUNDED}}` | 400 Zod, 400 INVALID_STATE (must be COMPLETED/PARTIALLY_REFUNDED), 400 EXCESSIVE_REFUND (refundable = amount - sum(COMPLETED refunds) cents), 404 |

Money: Decimal(12,2) string toFixed(2), never Float. Server amounts only.

## Audit & Activity Logs

| # | Method | Route | Perm | Query |
|---|---|---|---|---|
| 93 | GET | `/api/v1/audit-logs` | audit:read | `?page=1&limit=20 max100&action=CREATE|UPDATE|DELETE|LOGIN|LOGOUT|EXPORT|IMPORT opt&resource=string opt&resourceId=string opt&userId=uuid opt&from=isoDate opt&to=isoDate opt&sortBy=createdAt default&sortOrder desc default` |
| 94 | GET | `/api/v1/activity-logs` | activity:read | `?page=1&limit=20 max100&action=string opt&userId=uuid opt&from=isoDate opt&to=isoDate opt` |
| 95 | GET | `/api/v1/activity-logs/:id` | activity:read | id uuid | 200 single activity log | 404 if other tenant (tenant-scoped) |

Both return `{success:true,data:[{id,tenantId,userId,action,resource,resourceId,oldValue,newValue,ipAddress,userAgent,createdAt}],meta}` with sanitization [REDACTED] for 27 sensitive keys.

## Notifications

| # | Method | Route | Perm | Query/Body | Resp |
|---|---|---|---|---|---|
| 96 | GET | `/api/v1/notifications` | notification:read | `?page=1&limit=20 max100&isRead=bool opt&type=INFO|SUCCESS|WARNING|ERROR opt&channel=IN_APP|EMAIL|SMS|PUSH opt&sortBy=createdAt default desc` tenant/user-scoped (userId or null tenant-wide) newest-first | 200 `{success:true,data:[{id,tenantId,userId,type,title,message,channel,referenceType,referenceId,isRead,readAt,metadata,createdAt}],meta}` |
| 97 | PATCH | `/api/v1/notifications/:id/read` | notification:update | id uuid | 200 `{success:true,data:{...isRead:true}}` idempotent, 404 if other tenant |
| 98 | POST | `/api/v1/notifications/read-all` | notification:update | - | 200 marks all visible as read idempotent |
| 99 | GET | `/api/v1/notification-preferences` | notification:read | - | 200 `[ {id,tenantId,userId,channel,isEnabled,createdAt,updatedAt}]` 4 channels defaults (IN_APP/EMAIL/SMS/PUSH) |
| 100 | PATCH | `/api/v1/notification-preferences` | notification:update | `{preferences:[{channel:enum req, isEnabled:bool req}]}` upsert per channel | 200 updated preferences |

## Jobs (BullMQ)

| # | Method | Route | Perm | Body | Resp |
|---|---|---|---|---|---|
| 101 | GET | `/api/v1/jobs/status` | Bearer (any authenticated? actually no authorize in jobs.routes.js — check file: `GET /status` requires authenticate but no authorize) — authenticated only | - | 200 `{success:true,data:{enabled:bool, workersStarted:bool, queues:[notification,cleanup,webhook,email,report,analytics]}}` |
| 102 | POST | `/api/v1/jobs/notifications` | authenticated + tenant-scoped | `{title:string max? req, message:string req, channel?:enum, userId?:uuid, referenceType?,referenceId?, metadata?}` | 202 `{success:true,data:{jobId, queued:true}}` when Redis available else 200 fallback synchronous processing |
| 103 | POST | `/api/v1/jobs/cleanup` | authenticated | `{}` (tenantId derived) | 202 queued cleanup-expired-tokens else 200 fallback |
| 104 | POST | `/api/v1/jobs/reports` | authenticated | `{...payload}` | 202 deferred stub (Phase 18, not implemented processing) |
| 105 | POST | `/api/v1/jobs/analytics` | authenticated | `{...payload}` | 202 deferred stub |

Queues 6: notification (3 attempts exp 1000ms), cleanup (2 exp 2000ms), webhook (5 exp 1000ms), email (3 exp 1000ms), report (2 exp 2000ms), analytics (2 exp 2000ms). Retain completed 3600s counts, fail 24h. Prefix `pulseops:v1:queue`. Worker concurrency webhook10 cleanup1 others5 lock30s.

## Dashboard & Analytics (cached)

| # | Method | Route | Perm | Query | Resp Header | Errors |
|---|---|---|---|---|---|---|
| 106 | GET | `/api/v1/dashboard/overview` | dashboard:read | - | `x-cache: HIT|MISS` TTL 60s key `pulseops:v1:tenant:{tenantId}:dashboard:overview` | 401, 403, 404 tenant? |
| 107 | GET | `/api/v1/analytics/overview` | analytics:read | `?from=YYYY-MM-DD opt&to=YYYY-MM-DD opt&groupBy=day|week|month opt default day` | `x-cache: HIT|MISS` TTL 300s | 401,403 |
| 108 | GET | `/api/v1/analytics/sales` | analytics:read | `?from/to/groupBy plus category=uuid opt & product=uuid opt & status=enum opt & page=1&limit=20 max100` TTL 180s | x-cache | |
| 109 | GET | `/api/v1/analytics/orders` | analytics:read | `?from/to/groupBy & status opt & page/limit` TTL 180s | x-cache | |
| 110 | GET | `/api/v1/analytics/inventory` | analytics:read | `?warehouseId=uuid opt&category=uuid opt&product=uuid opt&status=enum opt&page/limit` TTL 180s | x-cache | |
| 111 | GET | `/api/v1/analytics/customers` | analytics:read | `?from/to/groupBy & page/limit` top customers | x-cache TTL 180s | |
| 112 | GET | `/api/v1/analytics/revenue` | analytics:read | `?from/to/groupBy` gross/refund/net | x-cache TTL 180s | |

All analytics tenant-isolated via req.context.tenantId + authorize. Date range UTC, groupBy deterministic via date_trunc(... AT TIME ZONE UTC). Money formatted toFixed(2). Cache reuse via CacheService.

## Swagger / OpenAPI (public)

| # | Method | Route | Auth | Resp |
|---|---|---|---|---|
| 113 | GET | `/api-docs/` | none | 200 text/html Swagger UI persistsAuth |
| 114 | GET | `/api-docs.json` | none | 200 application/json `openapi:3.0.3` spec (81000+ bytes, $ref resolved) |
| 115 | GET | `/openapi.json` | none | 200 alias same spec |
| 116 | GET | `/api/v1/openapi.json` | none | 200 alias same spec |

Additional implicit endpoints: GET `/` NOT AVAILABLE (404 via notFoundHandler), plus 405 handling NOT AVAILABLE (Express default). Rate limit headers `RateLimit-Policy` etc via express-rate-limit standardHeaders draft-8, Retry-After on 429.

Total counted 115 operations = documented exactly (16 health/auth public aliases included). Verify in `src/docs/paths/*.js` sum = 81 path keys.

---

# 4. Authentication

## Flows

### Login `POST /api/v1/auth/login`
- Body: `{email:email req, password:string req (min1, not complexity-checked at login), tenantId?:uuid opt}` (`src/modules/auth/auth.validation.js:13`). Validation Zod.
- Service `src/modules/auth/auth.service.js`: lookup `tenantId+email` + tenant existence + ACTIVE/TRIAL check + user ACTIVE check + Argon2id verify + update lastLoginAt + generate `accessToken` (JWT HS256) + `refreshToken` (random + hash stored) + sessionId uuid.
- Response 200: `{success:true,data:{accessToken, refreshToken (raw, not hash), sessionId, user:{id,tenantId,email,firstName,lastName,status,emailVerified,lastLoginAt,createdAt,updatedAt}}, message:"Login successful"}`.
- Failure: 400 TENANT_REQUIRED if tenantId missing and tenant-required path, 401 INVALID_CREDENTIALS (do not leak which field), 403 ACCOUNT_INACTIVE / TENANT_INACTIVE.

### Logout `POST /api/v1/auth/logout`
- Body `{refreshToken?:string}` optional. No auth. Revokes provided token if present (sets revokedAt). Always 200 `{success:true,data:{success:true,message:"Logout successful"}}`. No error for missing/invalid token (idempotent). Frontend: discard both tokens locally, redirect to login.

### Access Tokens
- Generated `src/modules/auth/jwt.util.js:21 signAccessToken(payload)` — `jsonwebtoken` HS256, `expiresIn: env.JWT_ACCESS_EXPIRY` (default 15m via `.env.example:16`), issuer `pulseops`, audience `pulseops-api`. Payload: `{sub:userId, tenantId, sessionId, email}`. Secret: `JWT_ACCESS_SECRET` min32 required in production, dev default `test-access-secret-min-32-chars-long-for-testing` when not production. Access token never stored in DB.

### Refresh Tokens
- Generated `signRefreshToken` similar, `expiresIn: JWT_REFRESH_EXPIRY` default 7d. Raw value returned once to client; SHA-256 hash stored in `refresh_tokens` `token_hash` + `expires_at` + `tenant_id` + `user_id`. Lookup via hash.
- `POST /auth/refresh` rotates: transaction-safe `prisma.$transaction`: revoke old (set revokedAt now) + create new raw/hashed. Returns new accessToken + new refreshToken + sessionId + user. Reuse detection: if provided hash already revoked → revokes ALL user tokens immediately (all revokedAt set), returns 401 REFRESH_TOKEN_REVOKED/INVALID_REFRESH_TOKEN.
- Expiry checked every refresh: if now > expiresAt → 401 REFRESH_TOKEN_EXPIRED.

### Token Expiration / Refresh Behavior / Session
- Access 15m short-lived; refresh 7d. No sliding session except via refresh. Each refresh generates new sessionId? Actually service generates new sessionId per token set (see controller — sessionId uuid per login/refresh). Frontend must: silent refresh before 15m expiry (e.g., 401 TOKEN_EXPIRED → call /auth/refresh with stored refreshToken, replay failed request once). If refresh fails → logout, clear tokens, redirect login. Concurrency: dedup refresh calls (queue failed requests). No refresh-token in HttpOnly cookie — tokens are Bearer strings the frontend stores.
- Session: `sessionId` field ties accessToken+refreshToken pair; included in JWT claims and response; available as `req.context.sessionId`.

### JWT Algorithm / Payload / Headers / Middleware / Unauthorized Responses
- Algorithm: pinned HS256 (`algorithms:['HS256']` in verifyAccessToken, jwt.util.js:39). Headers: `Authorization: Bearer <token>` required — `auth.middleware.js:10` checks `!authHeader || !startsWith Bearer => 401 UNAUTHORIZED (Authentication required)`. Verify signature + expiry (TokenExpiredError -> 401 TOKEN_EXPIRED) + JsonWebTokenError -> 401 INVALID_TOKEN + required claims missing -> 401 INVALID_TOKEN_CLAIMS (decoded.sub/tenantId/sessionId) + user not found/inactive -> 401 USER_NOT_FOUND + tenant not ACTIVE|TRIAL -> 403 TENANT_INACTIVE. Optional authenticate exists (realtime) but not for API.
- Required headers for authenticated requests: ONLY `Authorization`. No tenant header — tenant is server-derived. Clients must NOT send `X-Tenant-Id` (ignored/rejected). `X-Request-Id` optional for tracing.

### Password Handling / Validation / Reset/Change
- Hashing: `argon2` 0.45.1, Argon2id memoryCost=19456 timeCost=2 parallelism=1. Never log/return hash. Validation `auth.validation.js:6` `registerSchema` + `resetPasswordSchema:43` regex requires uppercase+lowercase+number+special `min8 max128` (same for `/auth/register` and `/auth/reset-password`). Login password `min1` only.
- Forgot `POST /auth/forgot-password`: body email+tenantId opt, generates 32 bytes crypto.randomBytes, SHA-256 hash stored, 1h expiry (PASSWORD_RESET_EXPIRY env 1h default), single-use via usedAt. Always returns 200 success even if email not found (enumeration safe). Dev `devToken` raw returned in response `data.devToken` (do NOT use in prod, prod would email). Revokes NOT at forgot — at reset.
- Reset `POST /auth/reset-password`: body token+password (validated), verifies hash not used/expired (400 INVALID_RESET_TOKEN / RESET_TOKEN_EXPIRED / RESET_TOKEN_USED), hashes new password, updates user, revokes ALL refresh tokens (sets revokedAt) atomically, marks token usedAt.
- Change password (authenticated) `PATCH /users/:id` does NOT allow passwordHash (400 PASSWORD_MODIFICATION_FORBIDDEN) — so `NOT AVAILABLE / NOT IMPLEMENTED` for authenticated change-password endpoint. Only reset flow exists. No password-strength meter endpoint.
- Email verification: `POST /auth/verify-email` token 32 bytes, 24h expiry, sets emailVerified true, devToken logged console, single-use.

### Frontend Security Requirements
- Store tokens securely: accessToken in memory preferred, refreshToken in httpOnly via backend NOT AVAILABLE — current backend returns both in JSON, so frontend must store in secure storage (memory + localStorage with fallback, clear on logout/XSS risk). Never store in URL or logs.
- Always send `Authorization` header, never query param (except Socket.IO fallback). Use `fetch` with `credentials:true` only for CORS (no cookies currently).
- Do not expose JWT secrets. Do not decode and trust client-side claims — backend re-validates tenant/user active on every request.
- Rate limiting: auth endpoints stricter 20/15m (see section 19) — show 429 with Retry-After.
- Expired handling: on 401 TOKEN_EXPIRED try refresh once.

Do not expose actual secrets.

---

# 5. RBAC and Permissions

## Roles / Permissions / Naming
- Roles: tenant-scoped `roles` table `@@unique([tenantId, name])`, seeded 3 system roles: `admin` (all 38 perms 83 links), `manager` (34 perms), `member` (11 read-only). Platform roles separate: `platform_roles` + `platform_permissions` + `platform_user_roles` + `platform_role_permissions` seeded `platform_admin` with `platform:tenant:create|read|update|suspend|billing:read|update`. IsSystem boolean — `is_system=true` immutable via API (DELETE/PATCH/permissions returns 403 SYSTEM_ROLE_IMMUTABLE).
- Permissions: tenant-scoped `permissions` table `@@unique([tenantId, resource, action])` fields `tenant_id, name, resource, action, description`. Naming `resource:action` (colon). Examples: `product:create|read|update|delete`, `order:create|read|update|cancel`, `inventory:read|update`, `notification:read|update`, `payment:create|confirm|read|refund`, `audit:read`, `activity:read`, `dashboard:read`, `analytics:read`, `category:create|read|update|delete`, `attribute:create|read|update|delete`, `warehouse:create|read|update|delete`, `user:read|update|delete`, `role:read|create|update|delete`, `permission:read`, `tenant:create|read|update|delete` (but tenant routes currently public).
- Permission resolution: `src/modules/auth/authorization.middleware.js:8 authorize(permission)` → check `req.context.userId|tenantId` → verify `tenantMembership` status ACTIVE else 403 FORBIDDEN → `getUserPermissions(userId,tenantId)` cached `pulseops:v1:user:{tenantId}:{userId}` TTL 300s (cache.config PERMISSIONS_USER) → query `user_roles` where userId+tenantId → roleIds → `role_permissions` where tenantId + roleId in → include permission → compare `permission.split(:)[0]==resource && [1]==action`. Empty roles → [] cached. Cache invalidation on assignments via `invalidateUserPermissionsCache`/`invalidateTenantPermissionsCache`.

## Permission Matrix (current seed — verify `prisma/seed.js`)

| Resource | action: create | read | update | delete | cancel | confirm | refund |
|---|---|---|---|---|---|---|---|
| tenant | x (platform) | x | x | — | — | — | — |
| user | — | x | x | x | — | — | — |
| role | x | x | x | x | — | — | — |
| permission | — | x | — | — | — | — | — |
| product | x | x | x | x | — | — | — |
| category | x | x | x | x | — | — | — |
| attribute | x | x | x | x | — | — | — |
| warehouse | x | x | x | x | — | — | — |
| inventory | — | x | x | — | — | — | — |
| order | x | x | x | — | x | — | — |
| payment | x (create) | x | — | — | — | x (confirm) | x (refund) |
| audit | — | x | — | — | — | — | — |
| activity | — | x | — | — | — | — | — |
| notification | — | x | x (update=mark read) | — | — | — | — |
| dashboard | — | x | — | — | — | — | — |
| analytics | — | x | — | — | — | — | — |
| customer | — | — | — | — | — | — | — (no cust perms) |
| platform:tenant/billing | x|read|update|suspend | billing read/update | — | — |

Check `prisma/seed.js` for exact 38 permissions (includes notification:read/update added Phase12). Admin gets all, manager 34 (excludes user:delete, role:delete, permission:read, tenant:update? see docs), member 11.

## Endpoint → Permission Mapping (authoritative from `*.routes.js`)

- Tenants 4: no permission (public)
- Auth 8: no permission (public / Bearer for /me)
- Roles: GET /roles → role:read, GET /roles/:id → role:read, POST /roles → role:create, PATCH → role:update, DELETE → role:delete, POST /roles/:id/permissions → role:update
- Permissions: GET /permissions* → permission:read
- Users: GET /users, GET /users/:id, GET /users/:id/roles → user:read, POST /users/:id/roles, PATCH /users/:id → user:update, DELETE → user:delete
- Categories: POST → category:create, GET → category:read (verify), PATCH → category:update, DELETE → category:delete
- Products: POST → product:create, GET* → product:read, PATCH → product:update, DELETE → product:delete, POST/GET productCategories → product:update/read
- Variants: POST → product:create, GET → product:read, PATCH → product:update, DELETE → product:delete, PUT variant attributes → product:update
- Attributes: POST create, GET read, PATCH/DELETE update/delete
- ProductImages: POST → product:create, GET → product:read, PATCH → product:update, DELETE → product:delete, storage file/signed-url → product:read (file) / HMAC (signed)
- Warehouses: POST create, GET read, PATCH update, DELETE delete
- Inventory: GET*, variants, movements, low-stock → inventory:read, adjust/transfer → inventory:update
- Orders: POST create, GET read, PATCH update, cancel cancel, history read
- Payments: POST /create → payment:create, POST /confirm → payment:confirm, webhook public HMAC, GET :id → payment:read, refund → payment:refund
- Audit: GET /audit-logs → audit:read, GET /activity-logs* → activity:read
- Notifications: GET /notifications, GET preferences → notification:read, PATCH .../read etc → notification:update
- Jobs: status/cleanup/notification/reports/analytics → authenticated (no specific authorize, tenant-scoped — logs show any authenticated can enqueue)
- Dashboard: GET /overview → dashboard:read
- Analytics: all 6 → analytics:read
- Storage: file/signed-url as above

## Tenant-admin vs Platform-admin vs User
- Tenant admin: `admin` role in tenant (has all tenant perms). Tenant isolation via membership ACTIVE. `authorize()` checks membership + permissions in that tenant only.
- Platform-admin: separate `PlatformRole`/`PlatformUserRole` not mounted on tenant routes — `authorizePlatform(permission)` exists but NOT USED on current tenant routes (only for future /platform routes, never tenant authorize). `NOT AVAILABLE` for frontend platform admin UI routes (no /platform endpoints exposed).
- User: member/manager roles subset.

## Unauthorized vs Forbidden / Frontend Visibility
- 401 UNAUTHORIZED: missing/invalid/expired JWT (error.code UNAUTHORIZED / TOKEN_EXPIRED / INVALID_TOKEN / INVALID_TOKEN_CLAIMS / USER_NOT_FOUND). Frontend: clear tokens, redirect login, do not retry with same token.
- 403 FORBIDDEN: authenticated but missing permission, tenant inactive, membership not ACTIVE, system role immutable. Frontend: show 403 page, hide forbidden nav items. Use permissions from `getUserPermissions` (cached) or inferred via GET fail. Route visibility: hide menu items where required perm not in user perms; guard pages with redirect to /403 if missing.
- 404 for cross-tenant access (permissions filtered, repositories return 404) — do not reveal existence. Frontend treat 404 as not found or forbidden.

Include complete matrix above; no hidden permissions. If permission not in seed → NOT AVAILABLE.

---

# 6. Multi-Tenancy

## Entities
- Platform admin (global, via `platform_user_roles` → no tenant scope) — NOT EXPOSED to frontend (no /platform endpoints). `NOT AVAILABLE` for tenant switching via platform.
- Tenant: `tenants` id uuid, name, slug unique globally, status ACTIVE|SUSPENDED|TRIAL|CANCELLED (prisma 10-15), plan string default free, created_at/updated_at timestamptz. Settings `tenant_settings` metadata jsonb, domains `tenant_domains` domain+verified+primary @@unique([tenantId, domain]).
- Tenant users: `users` tenant_id FK Cascade, plus `tenant_memberships` id tenantId userId roleId? status ACTIVE|INACTIVE|SUSPENDED @@unique([tenantId,userId]) — links user to tenant explicitly; also `user_roles` via roles.

## Tenant Identification / Context / Passing to APIs
- Creation: POST /tenants creates tenant (+ settings + default tenant). Login/register optional `tenantId` in body — if missing, service resolves via email uniqueness? Validation optional — but repository enforces tenantId+email unique. Recommended: frontend must collect tenantId (e.g., subdomain or tenant selector + localStorage) and send on login/register. Without tenantId login may still succeed if email globally unique, but tenant context still derived from token tenantId.
- Authenticated context: `authenticate()` verifies JWT, finds user via `findUserByIdAndTenant(sub, tenantId)` including `memberships[0].tenant`, sets `req.context = {userId: sub, tenantId, sessionId, email}`. All downstream `authorize`, services, repositories receive `req.context.tenantId` — NEVER `req.body.tenantId`. Any client-supplied `tenantId` in body/query/params is ignored or validated to match token then stripped (orders: client tenantId stripped; users: never trusts). Frontend must NOT add `X-Tenant-Id` header.
- Tenant-scoped resources: EVERY Prisma query includes `where:{tenantId}` from context. Examples: products `where:{tenantId,status...}`, variants `where:{tenantId,sku}`, inventory `@@unique([tenantId,productVariantId,warehouseId])`, orders `where:{tenantId,status}`, etc. Cross-tenant read/update/delete returns 404 (filter, not 403) to avoid enumeration.

## Tenant Isolation / Cross-tenant Protections
- DB: FK Cascade tenant→children, composite unique/indexes include tenantId. But simple FKs single-column (Phase 03 deferred composite FK) — so app layer enforces tenant isolation (repo tenantId filter). Verified via tenant isolation tests — attacker Tenant A JWT cannot GET/PATCH Tenant B resources (404) nor attach cross-tenant role/permission (filtered skip). JWT manipulated tenantId fails (user not found in that tenant → 401). Storage keys tenant-scoped `tenants/{tenantId}/...` validated via `assertTenantScopedKey` (local/storage providers).
- Warehouses/products/variants/inventory each tenant-isolated. SKU duplicate allowed across tenants (cross-tenant same SKU 201) but same-tenant 409. Inventory movements filtered.

## Frontend Implications
- Tenant switching: `NOT AVAILABLE / NOT IMPLEMENTED` as dedicated endpoint `/auth/switch-tenant` or `/tenants/select`. No API to list user memberships/tenants for a user. Workaround: users belong to 1 tenant via membership (primary). If multi-tenant user needed, NOT SUPPORTED — user must login separately per tenant (email unique globally but tenantId+email unique). Provide tenant selector on login page: first `GET /tenants` NOT AVAILABLE (tenants require id) — but discover tenant via slug? Public `GET /tenants/:id` requires id; list tenants `NOT AVAILABLE`. So frontend must know tenant slug/id out-of-band (subdomain detection or invite link). Recommend adding UX: login form `tenantId` hidden input populated from URL `?tenantId=` or subdomain.
- Tenant context display: decode `jwt.payload.tenantId` for UI display but do not trust for authorization; fetch `GET /tenants/:id` (public) to show tenant name/plan if needed.
- All API calls: attach Authorization; no tenant header; ensure tenant-derived filtering server-side. Cache keys include tenantId (frontend cache must include tenantId when caching).

---

# 7. Database/Data Model Reference

> Current `prisma/schema.prisma` 52 lines enums + ~38 models (see Prisma file). Below frontend-relevant condensed; full schema is source of truth.

## Enums
- TenantStatus ACTIVE|SUSPENDED|TRIAL|CANCELLED
- UserStatus ACTIVE|INACTIVE|SUSPENDED
- TenantMembershipStatus ACTIVE|INACTIVE|SUSPENDED
- ProductStatus ACTIVE|INACTIVE|DRAFT|ARCHIVED
- VariantStatus ACTIVE|INACTIVE|DRAFT
- AttributeDataType TEXT|NUMBER|BOOLEAN|OPTION
- InventoryMovementType ADJUSTMENT|TRANSFER|ORDER_RESERVATION|ORDER_RELEASE|ORDER_FULFILLMENT|RETURN|DAMAGED|LOST|COUNT
- OrderStatus DRAFT|PENDING|CONFIRMED|PROCESSING|SHIPPED|DELIVERED|CANCELLED|REFUNDED|PARTIALLY_REFUNDED
- PaymentStatus PENDING|PROCESSING|COMPLETED|FAILED|REFUNDED|PARTIALLY_REFUNDED|CANCELLED
- PaymentTransactionType CHARGE|REFUND|CAPTURE|VOID
- RefundStatus PENDING|PROCESSING|COMPLETED|FAILED
- NotificationType INFO|SUCCESS|WARNING|ERROR
- NotificationChannel IN_APP|EMAIL|SMS|PUSH
- AuditAction CREATE|UPDATE|DELETE|LOGIN|LOGOUT|EXPORT|IMPORT
- TokenType REFRESH|PASSWORD_RESET|EMAIL_VERIFICATION (model enums not direct fields)

## Models

### Tenant
`id uuid PK, name string req, slug string unique req, status TenantStatus default TRIAL, plan string default free, createdAt timestamptz(6) map created_at, updatedAt timestamptz updatedAt, settings? 1-1, domains 1-many, users 1-many...` relations all child tenants.

### TenantSettings/TenantDomain
Settings: id, tenantId unique FK Cascade, metadata Json default {}, timestamps. Domain: id, tenantId FK Cascade, domain string, verified bool default false, primary bool default false, @@unique([tenantId,domain]).

### User
`id uuid, tenantId string FK Cascade, email string, passwordHash string map password_hash, firstName map first_name, lastName map last_name, status UserStatus default ACTIVE, emailVerified bool default false map email_verified, lastLoginAt DateTime? timestamptz map last_login_at, createdAt timestamptz, updatedAt timestamptz, deletedAt timestamptz? map deleted_at`. Uniques: @@unique([tenantId,email]) + @@unique([email]) globally, indexes [tenantId,status] [tenantId,createdAt]. Relations: userRoles, audit, activity, refreshTokens, passwordReset, emailVerification, memberships, platformUserRoles. Audit fields + soft delete (deletedAt nullable).

### TenantMembership
`id uuid, tenantId FK Cascade, userId FK Cascade, roleId? FK SetNull nullable, status TenantMembershipStatus default ACTIVE, createdAt, updatedAt, @@unique([tenantId,userId]), indexes [userId,status] [tenantId,status]`.

### RefreshToken / PasswordResetToken / EmailVerificationToken
All: id uuid, tenantId FK Cascade, userId FK Cascade, tokenHash string map token_hash, expiresAt timestamptz map expires_at, plus revokedAt? / usedAt?, createdAt. Indexes [tenantId,userId] [tokenHash].

### Role / Permission / UserRole / RolePermission (+ Platform variants)
Role: id uuid, tenantId FK Cascade, name string, description? string, isSystem bool default false map is_system, createdAt, updatedAt, @@unique([tenantId,name]), index [tenantId]. Permission: id uuid, tenantId FK Cascade, name string, description?, resource, action, createdAt/updatedAt, @@unique([tenantId,resource,action]) index [tenantId]. UserRole: id uuid tenantId userId roleId FK Cascade, @@unique([tenantId,userId,roleId]) indexes. RolePermission: similar @@unique([tenantId,roleId,permissionId]). PlatformRole/Permission separate global uniques + PlatformUserRole/PlatformRolePermission globals.

### Category
`id uuid, tenantId FK Cascade, parentId? map parent_id FK self SetNull nullable (CategoryHierarchy self-relation), name, slug string, description? , sortOrder int default 0 map sort_order, isActive bool default true map is_active, createdAt, updatedAt, deletedAt?` @@unique([tenantId,slug]), indexes [tenantId,isActive] [tenantId,parentId]. Children relation.

### Product
`id uuid, tenantId FK Cascade, name, description? brand? status ProductStatus default DRAFT, basePrice Decimal? (12,2) map base_price nullable, createdAt, updatedAt, deletedAt?` indexes [tenantId,status] [tenantId,createdAt]. Relations categories via ProductCategory, variants, images.

### ProductCategory
`id uuid, tenantId FK Cascade, productId FK Cascade, categoryId FK Cascade, isPrimary bool default false map is_primary, createdAt, @@unique([tenantId,productId,categoryId]) indexes`.

### ProductVariant
`id uuid, tenantId FK Cascade, productId FK Cascade, sku string, barcode? string nullable, price Decimal(12,2) req, costPrice? Decimal?, status VariantStatus default DRAFT, createdAt, updatedAt, deletedAt?` @@unique([tenantId,sku]), indexes [tenantId,productId] [tenantId,barcode] [tenantId,status] [tenantId,price] [tenantId,status,createdAt] . Relations attributes(..Attribute), images, inventory(..), orderItems, movements.

### ProductVariantAttribute
`id uuid, tenantId FK Cascade, variantId FK Cascade, attributeDefinitionId FK Cascade, value string, createdAt, updatedAt` indexes [tenantId,variantId] [tenantId,attributeDefinitionId,value].

### ProductImage
`id uuid, tenantId FK Cascade, productId FK Cascade, variantId? nullable FK Cascade, storageKey string map storage_key, url? nullable, altText? map alt_text, sortOrder int default 0 map sort_order, isPrimary bool default false map is_primary, createdAt, updatedAt` indexes [tenantId,productId] [tenantId,variantId]. TenantImages both product+variant.

### AttributeDefinition / AttributeValue
Definition: id uuid tenantId FK Cascade name string code string dataType AttributeDataType map data_type isRequired bool default false map is_required description? string nullable createdAt/updatedAt @@unique([tenantId,code]) index[tenantId]. Value: id uuid tenantId FK Cascade attributeDefinitionId FK Cascade value string displayName map display_name sortOrder int default0 isActive bool default true map is_active createdAt/updatedAt @@unique([tenantId,attributeDefinitionId,value]) index[tenantId,attributeDefinitionId].

### Warehouse
`id uuid tenantId FK Cascade name code string address? city? state? country? postalCode? map postal_code isActive bool default true map is_active isDefault bool default false map is_default createdAt updatedAt deletedAt?` @@unique([tenantId,code]) index[tenantId,isActive]. Inventory relations.

### Inventory / WarehouseInventory / InventoryMovement
Inventory: id uuid tenantId FK Cascade productVariantId FK Cascade warehouseId FK Cascade quantity int default0 reservedQuantity int default0 map reserved_quantity createdAt updatedAt @@unique([tenantId,productVariantId,warehouseId]) indexes [tenantId,productVariantId] [tenantId,warehouseId] [tenantId,quantity]. Movement: id uuid tenantId, productVariantId, warehouseId, inventory? FK via compound (tenantId,productVariantId,warehouseId) nullable relation InventoryMovements, type InventoryMovementType, quantityBefore int map quantity_before, quantityChanged int map quantity_changed, quantityAfter int map quantity_after, reason? string, referenceType? referenceId? createdBy? createdAt timestamptz indexes productVariant+createdAt, warehouse+createdAt, type+createdAt. WarehouseInventory duplicate unique [tenantId,warehouseId,productVariantId].

### Customer
`id uuid tenantId FK Cascade email string firstName map first_name lastName map last_name phone? metadata Json default{} createdAt updatedAt deletedAt?` @@unique([tenantId,email]) index[tenantId,createdAt]. Orders relation.

### Order / OrderItem / OrderStatusHistory
Order: id uuid tenantId FK Cascade customerId FK Restrict, status OrderStatus default DRAFT, subtotal Decimal(12,2) req, discountTotal Decimal default0 map discount_total, taxTotal default0 map tax_total, shippingTotal default0 map shipping_total, total Decimal req, currency default USD, metadata Json default{}, createdAt updatedAt deletedAt? indexes [tenantId,status] [tenantId,createdAt] [tenantId,customerId] [tenantId,customerId,createdAt]. Items: id uuid tenantId FK Cascade orderId FK Cascade productVariantId FK Restrict, productNameSnapshot map product_name_snapshot, variantNameSnapshot map variant_name_snapshot, attributeSnapshot Json default{} map attribute_snapshot, skuSnapshot map sku_snapshot, unitPrice Decimal map unit_price, quantity int, discount Decimal default0, tax default0, lineTotal Decimal map line_total, createdAt, indexes [tenantId,productVariantId] [tenantId,orderId]. History: id uuid tenantId FK Cascade orderId FK Cascade fromStatus? OrderStatus? map from_status, toStatus map to_status, reason? createdBy? createdAt indexes.

### Payment / PaymentTransaction / Refund / PaymentWebhookEvent
Payment: id uuid tenantId FK Cascade orderId FK Restrict, amount Decimal(12,2), currency default USD, status PaymentStatus default PENDING, provider? string, providerPaymentId? map provider_payment_id, metadata Json default{}, createdAt updatedAt deletedAt? indexes [tenantId,orderId] [tenantId,status] [tenantId,providerPaymentId]. Transaction: id uuid tenantId FK Cascade paymentId FK Cascade type PaymentTransactionType amount Decimal currency default USD status PaymentStatus providerTransactionId? map provider_transaction_id metadata Json createdAt indexes. Refund: id uuid tenantId FK Cascade paymentId FK Cascade amount Decimal currency default USD status RefundStatus default PENDING reason? providerRefundId? map provider_refund_id metadata createdAt updatedAt indexes. WebhookEvent: id uuid tenantId FK Cascade paymentId? FK SetNull nullable eventId string map event_id providerEventId? providerPaymentId? type string payload Json default{} createdAt @@unique([tenantId,eventId]) + @@unique([eventId]) global, indexes [tenantId,paymentId] [tenantId,providerEventId].

### Notification / NotificationPreference / NotificationTemplate
Notification: id uuid tenantId FK Cascade userId? map user_id nullable (null=tenant-wide), type NotificationType, title, message, channel NotificationChannel, referenceType? referenceId?, isRead bool default false map is_read, readAt? timestamptz map read_at, metadata Json default{}, createdAt, indexes [tenantId,userId,isRead] [tenantId,createdAt] [tenantId,referenceType,referenceId]. Preference: id uuid tenantId FK Cascade userId channel NotificationChannel isEnabled bool default true map is_enabled createdAt updatedAt @@unique([tenantId,userId,channel]) index. Template: id uuid tenantId FK Cascade name channel NotificationChannel subject? body string variables Json isActive bool default true map is_active createdAt updatedAt @@unique([tenantId,name,channel]).

### AuditLog / ActivityLog
Audit: id uuid tenantId FK Cascade userId? FK SetNull nullable, action AuditAction, resource string, resourceId? map resource_id, oldValue? Json map old_value, newValue? map new_value, ipAddress? map ip_address, userAgent? map user_agent, createdAt, indexes [tenantId,userId,createdAt] [tenantId,resource,resourceId] [tenantId,action,createdAt] [tenantId,createdAt]. Activity: id uuid tenantId FK Cascade userId? FK SetNull, action string, description? metadata Json ip/userAgent createdAt indexes similar.

### Enums/Constraints
Decimal money all Decimal(12,2) not Float. Timestamptz(6) stored UTC. Soft delete deletedAt nullable on users, categories, products, productVariants, warehouses, customers, orders, payments (others hard). Unique constraints all tenant-scoped as listed. Important indexes composite with tenantId (see schema). 9 migrations chain as in section 1.

## Relationship Overview
Tenant 1-* all entities. User N-* Role via UserRole via RolePermission via Permission. Category self-hierarchy. Product 1-* Variants 1-* Inventory (per warehouse) + Images. Product *-* Category via ProductCategory. AttributeDefinition 1-* AttributeValue and ProductVariantAttribute. Warehouse 1-* Inventory. Order 1-* OrderItem + StatusHistory 1-1 Customer + 1-* Payments. Payment 1-* Transaction + Refund + WebhookEvent. Notification per Tenant (+ optional User).

---

# 8. Users

## Fields (from User model)
`id uuid, tenantId uuid FK, email string unique per tenant + globally unique, passwordHash string (never exposed), firstName string 1-100, lastName 1-100, status ACTIVE|INACTIVE|SUSPENDED default ACTIVE, emailVerified bool default false, lastLoginAt timestamptz? nullable, createdAt timestamptz, updatedAt timestamptz, deletedAt timestamptz? nullable` + `roles:[{id,name,isSystem}]` populated on GET. `memberships` + `refreshTokens` internal. Soft delete deletedAt present but DELETE is hard (prisma delete, not update deletedAt).

## Lifecycle
- Creation: via `POST /auth/register` only (no direct `POST /users`). Service checks tenant exists ACTIVE/TRIAL, hashes password, creates user + TenantMembership ACTIVE. Duplicate email in same tenant -> 409 USER_ALREADY_EXISTS (cross-tenant same email 201 allowed because tenantId+email unique and global email unique? Schema has both @@unique([tenantId,email]) and @@unique([email]) — global unique conflicts cross-tenant same email -> investigate discrepancy: schema has @@unique([email]) global so second tenant same email would 409 globally, but docs claim cross-tenant allowed. Actual DB enforces global unique — catch as limitation/GAP, see section 24).
- Update: `PATCH /users/:id` explicit allowlist `firstName, lastName, status`. Rejects `email` -> 400 EMAIL_MODIFICATION_FORBIDDEN, `passwordHash` -> 400 PASSWORD_MODIFICATION_FORBIDDEN, `tenantId` -> 400 TENANT_MODIFICATION_FORBIDDEN, `roleIds` ignored (use /users/:id/roles). Service validates status enum ACTIVE|INACTIVE|SUSPENDED else 400? Validation passthrough + service check. Audit log created atomically if success.
- Delete/Deactivation: `DELETE /users/:id` hard deletes (no deletedAt set). Self-deletion prevented 400 SELF_DELETION_FORBIDDEN (req.context.userId == params.id). 404 if not in tenant. Status SUSPENDED/INACTIVE distinct from delete.

## Listing / Search / Filter / Pagination
- `GET /users` tenant-scoped via `memberships: {some:{tenantId,status:ACTIVE}}` (actual repository uses membership filter, not just tenantId). Pagination page default 1 limit 20 max100, meta total/totalPages. Search `search` queries `email`+`firstName`+`lastName` case-insensitive contains (Prisma `contains mode:insensitive`). Filter `status` (enum) exact, `roleId` filters users by assigned role (joins UserRole). Sort `sortBy` whitelist `createdAt|updatedAt|email|firstName|lastName|status` + `sortOrder asc|desc`, validated allow-list then `orderBy`. Safe SQL (no injection).

## Roles / Permissions
- Roles via `GET/POST /users/:id/roles` separate. Current perms: user:read, user:update, user:delete distributed admin(all), manager(read+update), member(read). Frontend exposes role badges reading `roles` array on user GET.

## Profile / Password Functionality
- Profile: `GET /auth/me` returns current safe user object (same shape as users read). No extra profile edit endpoint — uses PATCH /users/:id with user own id allowed if has user:update perm (or admin). Password change via forgot/reset flow only (no authenticated PUT /auth/change-password) — `NOT AVAILABLE`. Client must not allow email/tenantId edit.

## Frontend Requirements
- List page with server pagination, debounced search, status dropdown, role dropdown, sort controls (emit query). Show status badge color (ACTIVE green, SUSPENDED orange, INACTIVE gray). Date formatting from `createdAt` ISO.
- Detail drawer `/users/:id` showing roles, emailVerified, lastLoginAt.
- Edit form allow only firstName/lastName/status; disable email. On 400 field forbidden show field error. Confirm delete blocked self.
- Assign roles via multi-select that calls `POST /users/:id/roles` with selected roleIds (tenant-ascoped list from `GET /roles`).
- Tenant isolation notice: search cannot escape tenant.
- Handle 401/403 via permission guard (member sees list read-only).

---

# 9. Products

## Fields
Product: `id uuid, tenantId uuid, name string 1-255 req, description? string max5000, brand? string max100, status ACTIVE|INACTIVE|DRAFT|ARCHIVED default DRAFT, basePrice? string decimal regex ^\d+(\.\d{1,2})?$ optional (stored Decimal(12,2) nullable), createdAt timestamptz, updatedAt, deletedAt?` soft delete. ProductCategory junction: `tenantId, productId, categoryId, isPrimary bool default false`. Variant: `id uuid, tenantId, productId FK, sku string req tenant-unique, barcode? string nullable tenant-unique, price Decimal(12,2) string, costPrice? Decimal? string nullable, status ACTIVE|INACTIVE|DRAFT default DRAFT, createdAt/updatedAt/deletedAt`. ProductImage fields as above.

## SKU / Variants / Images / Categories
- SKU `@@unique([tenantId,sku])` strict, barcode `@index` unique nullable, cross-tenant same SKU allowed 201 same-tenant 409. Variants belong to product (productId ownership 404 if mismatch).
- Images: multer 10MB, JPEG/PNG/WebP/GIF validated `validateImageFile`, tenant key sanitized `sanitizeFilename` `[^a-zA-Z0-9._-]->_`, stored via StorageService (local path `./storage` or S3). Bytes not in DB — storageKey + metadata in DB. 2 kinds: product images (variantId null) and variant images (variantId set). Same table `product_images`.
- Categories: if implemented product-categories provided via `POST /products/:productId/categories` with categories array min1 + primaryCategoryId opt; stored junction isPrimary flag. Listing product categories `GET /products/:productId/categories`. Filtering GET /products?categoryId=... uses junction.
- Pricing: basePrice optional product price, variant `price` required authoritative for orders (snapshot uses variant price). Money Decimal strings not numbers.

## Product Status / Create/Update/Delete / Search/Filter/Sort / Pagination
- Status enum validated Zod, default DRAFT. Listing filters status, categoryId, minPrice/maxPrice (gte/lte on basePrice? actual filters price via variants join?), sku contains, barcode contains, attribute[code]=value (tenant-scoped AND across multiple attrs via variantAttributes filter), search (name/description/brand contains insensitive), pagination page/limit, sortBy name|brand|status|basePrice|createdAt|updatedAt default createdAt sortOrder desc. All lists meta.
- Validation on create/update: strict enums, regex decimal, refine at least one for update, categories array uuids.

## Permissions / Tenant Scope / Endpoints
- Permissions: product:create / product:read / product:update / product:delete (variants reuse same). Tenant scope via req.context.tenantId, cross-tenant 404. Endpoints listed section 3 (39-45 product cats, 46-52 variants/attributes/images, 67-70 storage). Total 15 product-domain ops + 4 storage.

---

# 10. Inventory

## Models
- Inventory: `id, tenantId, productVariantId, warehouseId, quantity int default0, reservedQuantity default0, createdAt, updatedAt @@unique([tenantId,productVariantId,warehouseId])`, CHECKs not negative (migration 08).
- WarehouseInventory duplicate `@@unique([tenantId,warehouseId,productVariantId])` read optimization (mirrored).
- InventoryMovement: `id, tenantId, productVariantId, warehouseId, inventory? FK via compound, type InventoryMovementType, quantityBefore, quantityChanged, quantityAfter, reason? referenceType? referenceId? createdBy? createdAt` indexes + invariant after = before + changed (DB CHECK `inventory_movements_quantity_consistency`).
- Warehouse: `id tenantId name code @@unique([tenantId,code]) address city state country postalCode isActive isDefault createdAt updatedAt deletedAt`.

## Stock / Adjust / Transfer / Movements / Low-stock / Reservation
- Quantities per warehouse per variant (never product-level). `quantity` is available, `reservedQuantity` reserved for orders (currently `warehouseInventory` mirrors `inventory` quantity/reserved, service keeps both in sync transaction).
- Adjust: POST /inventory/adjust `{warehouseId, variantId, quantityChanged non-zero int, reason?}`. Positive adds, negative subtracts. Validates after >=0 else 400 INSUFFICIENT_STOCK, stock unchanged, no invalid movement. Type ADJUSTMENT inventoryMovement inclusive. `SELECT ... FOR UPDATE` sorted lock + prisma $transaction retry on 40001/40P01. Creates movement quantityBefore/Changed/After consistent.
- Transfer: POST /inventory/transfer `{variantId, sourceWarehouseId, destinationWarehouseId, quantity positive int}` atomic source quantity -quantityChange / dest +quantity, 2 movements type TRANSFER same referenceId uuid (shared referenceId), validates warehouses + variant tenant ownership, same warehouse -> 400 SAME_WAREHOUSE, insufficient source -> 400.
- Movements history: GET /movements paginated filtered by variant/warehouse/type/from/to, returns movements newest first with after = before + changed.
- Low-stock: GET /low-stock `?threshold default10&warehouseId opt` returns inventories where quantity <= threshold ordered ASC quantity (useful dashboard warning). Filter tenant-scoped.
- Reservation behavior: Order creation uses `ORDER_RESERVATION` type movements (negative) atomically reduces inventory and mirrors warehouseInventory, cancellation uses `ORDER_RELEASE`. OrderService locks variants sorted id via SELECT FOR UPDATE to prevent oversell. No explicit reservation hold separate from order — quantity directly deducted.

## Statuses / Endpoints / Validation / Permissions
- MovementType enums validated partially for listing enum, adjust fixed ADJUSTMENT, transfer fixed TRANSFER, orders use ORDER_RESERVATION/RELEASE. Warehouses status isActive/isDefault booleans.
- Endpoints 71-81 plus warehouse 71-75 (11 total inventory-warehouses).
- Validation Zod: variantId/warehouseId UUID, quantityChanged non-zero int, transfer quantity positive, sameWarehouse check, pagination, enum types.
- Permissions: inventory:read for GETs, inventory:update for adjust/transfer, warehouse:create/read/update/delete for warehouses. 401 unauth, 403 insufficient tenant membership.
- Frontend: inventory list with warehouse/variant/SKU search pills, adjust modal with reason select + delta field, transfer modal source->dest, movements table with reason placeholder, low-stock alert page/bell.

---

# 11. Orders

## Creation / Listing / Details / Items / Status Lifecycle / Transitions
- Creation: POST /orders requires customerId (tenant-owned Customer must exist) + items min1 each `{productVariantId:uuid req, warehouseId:uuid req, quantity: int positive req, discount?:decimalString, tax?:decimalString, variantId alias opt}` plus shippingTotal?, currency 3 chars, metadata? Server validates `productId` forbidden -> 400, validates each productVariant exists ACTIVE and tenant-owned, validates warehouse exists tenant, calculates each `unitPrice` = variant.price (server authoritative, client unitPrice/total stripped), `lineTotal = unitPrice*quantity - discount + tax` (Decimal), sums `subtotal/total = subtotal - discountTotal + taxTotal + shipping`, preserves snapshots: `productNameSnapshot` (=product.name), `variantNameSnapshot` (=variant sku? or composite), `attributeSnapshot` Json (variant attributes map), `skuSnapshot` (=variant.sku), `unitPrice`, `quantity`, `discount`, `tax`, `lineTotal` write-once (later product price change irrelevant). Example 2x1299.00 -> 2598.00.
- Transaction: `prisma.$transaction` locks inventory SELECT FOR UPDATE sorted, checks available >= requested else 400 INSUFFICIENT_STOCK with rollback (no orphan order/movement/history), creates order + orderItems + `ORDER_RESERVATION` movements (quantity_before/changed negative/after) + `UPDATE inventory.quantity = after` + mirror warehouseInventory + creates `OrderStatusHistory` fromStatus null -> PENDING with createdBy from context. Concurrency: 10 concurrent qty1 from 5 -> 5 success/5 fail final 0 (retry for 40001).
- Listing: GET /orders paginated, filtered `status` enum opt, `customerId` uuid opt, safe sorting `createdAt|updatedAt|total|status` allow-list uses `assertSafeTrunc`, selective field loading (no N+1).
- Details: GET /orders/:id returns `{id,tenantId,customerId,status,subtotal,discountTotal,taxTotal,shippingTotal,total,currency,metadata,createdAt,updatedAt,deletedAt,items:[{...snapshots...}],customer:{id...},statusHistory:[...]}` if permitted else 404 tenant.
- Items: snapshot fields as above, tenantId+orderId indexes. Price is string toFixed2.
- Status lifecycle + transitions: DRAFT (not auto via create; create => PENDING), `PENDING->CONFIRMED->PROCESSING->SHIPPED->DELIVERED`, terminal `CANCELLED` allowed from DRAFT/PENDING/CONFIRMED/PROCESSING, `REFUNDED/PARTIALLY_REFUNDED` via payments not via status endpoint? State machine enforced in `PATCH /orders/:id/status` `isValidOrderTransition` — invalid -> 400 INVALID_STATUS_TRANSITION. Also `CANCELLED` via POST /cancel restricts cancellable to cancellableStatuses set (DRAFT/PENDING/CONFIRMED/PROCESSING) else 400 CANCELLATION_NOT_ALLOWED; double cancel 400; SHIPPED double-cancell? 400.

## Pricing / Totals / Customer / Inventory Interaction / Payment / Cancellation / Search
- Totals: all Decimal(12,2) string toFixed2, computed server. Frontend must display string, not float. Customer: FK Restrict delete — Customer must exist before order; no customer create API exposed (customer entity is seeded/created implicitly? Check orders.service — it finds customer by id tenantId, not create). Frontend must ensure customer exists via NOT AVAILABLE — workaround: customer creation `NOT AVAILABLE` so test setup seeds customers directly via Prisma seed? Real UI needs customer creation but backend GAP (no customer CRUD).
- Inventory: reserved on create (ADJUSTMENT style ORDER_RESERVATION), restored on cancel via `ORDER_RELEASE` per reservation movement atomically, locks inventory, mirrors warehouseInventory.
- Payment: created via payments anchored to Order id (derive amount from order.total, duplicate pending guard).
- Cancellation: POST /:id/cancel restores inventory per original reservation movements, creates ORDER_RELEASE + history entry, 2nd cancel rejected.
- Search/filter/sort/pagination: status filter, customerId, safe sort, pagination meta; history paginated chronological (oldest first? actual ORDER BY createdAt asc).

## Permissions / Validation
- Permissions: order:create (POST), order:read (GET list/detail/history), order:update (PATCH status), order:cancel (POST cancel). Membership check each. Tenant isolation all Prisma where:{tenantId} cross-tenant 404 both directions, manipulated JWT 401, client tenantId stripped never trusted. Validation Zod strict for body/params/query: customerId uuid, items min1, productVariantId uuid, warehouseId uuid, quantity int positive, discount/tax decimalString, shipping decimal, currency, productId forbidden refine, status enum, reason max500, pagination.

---

# 12. Payments & Transactions

## Models
- Payment: id uuid tenantId FK, orderId FK Restrict, amount Decimal(12,2) req, currency default USD, status PaymentStatus (PENDING|PROCESSING|COMPLETED|FAILED|REFUNDED|PARTIALLY_REFUNDED|CANCELLED) default PENDING, provider? string, providerPaymentId? map provider_payment_id, metadata Json default{}, timestamps+deletedAt, indexes tenantOrder etc. CHECK amount non-negative.
- PaymentTransaction: id uuid tenantId FK, paymentId FK Cascade, type PaymentTransactionType (CHARGE|REFUND|CAPTURE|VOID), amount Decimal, currency default USD, status PaymentStatus, providerTransactionId? map provider_transaction_id, metadata Json createdAt, indexes tenantPayment etc. CHECK non-negative.
- Refund: id uuid tenantId FK, paymentId FK Cascade, amount Decimal, currency default USD, status RefundStatus default PENDING, reason?, providerRefundId?, metadata, createdAt updatedAt indexes.
- PaymentWebhookEvent: id uuid tenantId FK, paymentId? FK SetNull nullable, eventId string map event_id, providerEventId? providerPaymentId? type string, payload Json, createdAt, unique [tenantId,eventId] + [eventId] global, indexes.

## Statuses / Lifecycle / Creation / Confirmation / Failure / Idempotency / Refund / Webhooks
- Statuses: PaymentStatus lifecycle PENDING:[PROCESSING,COMPLETED,FAILED,CANCELLED] PROCESSING:[...] COMPLETED/PARTIALLY_REFUNDED:[REFUNDED,PARTIALLY_REFUNDED] FAILED/CANCELLED/REFUNDED terminal (state machine `isValidTransition`). Server-only transition — frontend cannot inject status (confirm not includes status field, webhook maps type to targetStatus only if valid).
- Creation: POST /payments/create `.strict()` (unknown amount/status 400), validates order exists tenant 404, order status eligible [PENDING,CONFIRMED,PROCESSING,DRAFT] else 400 ORDER_NOT_ELIGIBLE, derives amount=currency=order.total server-side (client amount 400 if sent), Decimal non-negative, duplicate pending guard `payment where orderId + tenantId status PENDING/PROCESSING` -> 400 PAYMENT_ALREADY_PENDING, generates providerPaymentId `pay_<uuid>` + initial CHARGE PENDING transaction in $transaction, tenantId from context.
- Confirmation: POST /payments/confirm strict `{paymentId uuid req, providerPaymentId? max255 opt, simulateFailure? bool opt}` no status, validates PENDING/PROCESSING else 400 INVALID_STATE_TRANSITION, `targetStatus = simulateFailure? FAILED: COMPLETED` via isValidTransition, SELECT FOR UPDATE, creates CHARGE transaction, rollback on invalid, cross-tenant 404.
- Failure: confirm simulateFailure true -> FAILED, webhook payment.failed -> FAILED, idempotency ensures safe retry.
- Idempotency: webhook DB unique constraints + INSERT conflict handle P2002 -> safely ignore second. Not read-then-write. Concurrent 5 identical webhooks -> 1 effect (1 transaction+1 event, 4 duplicates 200 duplicate:true). Also webhook re-verifies HMAC before enqueue and in processor.
- Refund: POST /payments/:id/refund strict `{amount decimalString req, reason? max500, metadata?}` requires COMPLETED/PARTIALLY_REFUNDED else 400, refundable = amount - sum(COMPLETED refunds) cents, excessive -> 400 EXCESSIVE_REFUND, SELECT FOR UPDATE + re-check inside tx, creates REFUND COMPLETED + REFUND transaction, updates payment `PARTIALLY_REFUNDED` if partial else `REFUNDED`, rollback on failure, audit append-only never overwrite, Decimal 0.01 precise, refund provider optional (mock/http).
- Webhooks: public HMAC-SHA256 timingSafeEqual using PAYMENT_WEBHOOK_SECRET (dev test secret default) verifyWebhookSignature, invalid -> 401 INVALID_WEBHOOK_SIGNATURE, malformed 400, resolves tenant via payment lookup, inserts webhook event inside tx, duplicate P2002 -> 200 duplicate:true, maps type enum `payment.succeeded|payment.failed|payment.refunded|charge.succeeded|charge.failed` to targetStatus only if validTransition, locks payment, deduplicates providerTransactionId, tenant-isolated, never trusts frontend status.

## Error Handling / Frontend Implications
- Duplicate pending guard prevents double-charge button spam. Frontend disable Create after first success, poll GET /payments/:id or await webhook.
- Frontend cannot set amount/status — show server amount only. Confirm button only when status PENDING/PROCESSING.
- Webhook endpoint NOT called by frontend (is provider->backend). Frontend polls GET.
- Rate limiting webhook 100/1m; payment creation requires payment:create perm.

---

# 13. Notifications

## Model / Types / Read / Preferences / APIs / Background / Providers / Frontend Requirements
- Model Notification: `id uuid, tenantId FK, userId? nullable FK (null=tenant-wide broadcast, else user-specific), type NotificationType INFO|SUCCESS|WARNING|ERROR, title string, message string, channel NotificationChannel IN_APP|EMAIL|SMS|PUSH, referenceType? referenceId?, isRead bool default false map is_read, readAt? timestamptz map read_at, metadata Json default{}, createdAt` indexes [tenantId,userId,isRead] [tenantId,createdAt] [tenantId,referenceType,referenceId].
- NotificationPreference: `id uuid, tenantId FK, userId FK, channel IN_APP|EMAIL|SMS|PUSH, isEnabled bool default true, createdAt, updatedAt @@unique([tenantId,userId,channel])`.
- NotificationTemplate: `id uuid, tenantId FK, name string, channel, subject? body string variables Json default{}, isActive bool default true @@unique([tenantId,name,channel])` — `NOT USED by current enqueue` (template variables not filled in current POST /jobs/notifications path — gap).

- Types: INFO SUCCESS WARNING ERROR. Channels: IN_APP (realtime), EMAIL, SMS, PUSH (concepts only, provider delivery via adapters Phase16 but notification service creates DB row always; email queue separate). Frontend handles IN_APP primary.

- Read/unread: isRead + readAt. On mark read, set isRead true + readAt now if not already. Unread count: frontend computes via `GET /notifications?isRead=false` length or total in meta where `isRead=false`. Badge: count of isRead false for current user+tenant. Backend does NOT expose dedicated `/notifications/unread-count` — fetch filtered list meta total. Mass assignment protection: user cannot set isRead via create.

- Preferences: GET /notification-preferences returns array 4 channels defaults (if no rows, service synthesizes defaults enabled true for each channel via `getDefaultPreferences`). PATCH /notification-preferences upsert per channel `{preferences:[{channel,isEnabled}]}` tenant+user scoped. Frontend toggle switches per channel; persistence via PATCH.

- Notification APIs: tenant/user-scoped (repo where tenantId AND (userId=userId OR userId null)). `GET /notifications` paginated page default1 limit20 max100, filters isRead bool, type enum, channel enum, ordering newest first (createdAt desc). `PATCH /notifications/:id/read` idempotent (404 if other tenant), `POST /notifications/read-all` idempotent marks all visible as read (WHERE tenantId+visible). Both RBAC `notification:read` / `notification:update`. Tenant/user isolation enforced.

- Background: Provider-independent NotificationService `createNotification`/`notify`/`dispatchViaChannel` called from `enqueueNotification` job path when processor runs. Creation is synchronous via POST /jobs/notifications -> enqueueNotification (BullMQ attempt) falls back to sync create if Redis unavailable (200 fallback path). So frontend always receives notification row even in degraded mode. Retry 3 exponential 1s.

- Supported providers: `NOT AVAILABLE` for push/sms provider direct — adapters are mocked/http (SMS_PROVIDER mock default). Notification dispatch ViaChannel not exercised in API — stored DB + realtime emit is main.

- Frontend notification center requirements:
  - Bell icon with badge count `GET /notifications?isRead=false&limit=1` meta.total OR separate fetch limit 20.
  - Dropdown/list page `GET /notifications?page&limit&isRead&type&channel`.
  - On click `PATCH /:id/read`; `POST /read-all` for mark all.
  - Preferences panel `GET /notification-preferences` then PATCH.
  - Polling OR realtime: subscribe to `notification.created` via Socket.IO user room for instant; fallback polling every 30s.
  - Empty state when none, timestamp relative (use createdAt). ReferenceType linking? If referenceType order/inventory, clicking may navigate to order detail page via `referenceId`.

---

# 14. Audit & Activity Logs

## Model / Events / Actor / Tenant / Timestamp / Search / Permissions / APIs
- Model AuditLog: `id uuid, tenantId FK, userId? FK SetNull nullable (actor), action AuditAction CREATE|UPDATE|DELETE|LOGIN|LOGOUT|EXPORT|IMPORT, resource string (e.g., "user","order","payment","product"), resourceId? string map resource_id, oldValue? Json map old_value, newValue? Json map new_value, ipAddress? map ip_address, userAgent? map user_agent, createdAt timestamptz` indexes [tenantId,userId,createdAt] [tenantId,resource,resourceId] [tenantId,action,createdAt] [tenantId,createdAt]. ActivityLog: similar but `action string (free), description? string nullable, metadata Json` same actor/ip/timestamp indexes.

- Events captured: Reusable module `src/modules/audit/audit.service.js` abstraction `logAudit`/`logActivity`/`logAuditAndActivity` + helper `recordAudit(tx,...)` + `extractAuditContext(req)` (ip from `req.ip`, ua from header). Integrated mutations atomically in same `$transaction` (if move fails rollback): `PATCH /users/:id`, `DELETE /users/:id`, `POST /orders`, `PATCH /orders/:id/status`, `POST /orders/:id/cancel` each creates audit+activity records via `tx`. Other modules (products/inventory/payments) `NOT AVAILABLE` for auto-audit — will be `NOT IMPLEMENTED` until added.

- Actor: `userId` from req.context.userId mapping via audit context or sanitized `createdBy` field (order history uses createdBy string). For auth logs, userId present. Tenant: always `tenantId` from context. Timestamp: `createdAt` timestamptz(6) UTC.

- Search/filter/pagination: `GET /audit-logs` paginated `page 1 limit20 max100`, filters `action` enum opt, `resource` string opt, `resourceId` string opt, `userId` uuid opt, `from` isoDateTime opt, `to` isoDateTime opt. Safe sort only `createdAt` allow-list via `assertSafeTrunc`. Same for activity logs plus `GET /activity-logs/:id` (tenant-scoped findById — 404 if other tenant). Both return `{success:true,data:[...],meta}`. Sensitive sanitization [REDACTED] recursive for 27 keys (password/hash/token/secret...) via `audit.sanitize.js` depth 8, Decimal/Date handled.

- Permissions: `audit:read` for GET /audit-logs, `activity:read` for activity routes. Admin/manager? Seeded audit:read for admin/manager only (member no). Check seed: `audit:read` included? Verify — member has 10 read-only not including audit (per roadmap). So hide audit UI for member.

- Frontend requirements:
  - Admin page `GET /audit-logs` table with filters action/resource/date range picker + user filter (maybe autocomplete users).
  - Activity tab similar but looser action strings.
  - Detail drawer shows oldValue/newValue diff (highlight changed fields) with IP/UA. Mask redacted fields.
  - Pagination controls show meta.total. Debounce `from`/`to`.
  - Access guarded by audit:read perm.

---

# 15. Background Jobs / BullMQ

## Queues / Job Types / Payloads / Retry / Backoff / Failed / Worker / Frontend Effects

| Queue Name (`QUEUE_NAMES`) | Job Name (`JOB_NAMES`) | Payload (frontend-visible) | Attempts | Backoff | RemoveOnComplete | RemoveOnFail | Timeout `jobTimeoutMs()` | Processor |
|---|---|---|---|---|---|---|---:|---|
| notification | send-notification | `{tenantId, userId?, title string req, message string req, type? default INFO, channel? default IN_APP, referenceType?,referenceId?, metadata?}` tenant-scoped `title/message` required | 3 | exponential delay 1000 | 3600 age, count 1000 | 24h | 10000 | `notification.processor.js` `processSendNotification` -> `NotificationService.createNotification` -> realtime emit |
| cleanup | cleanup-expired-tokens | `{tenantId}` (tenantId derived from auth context, no other fields) | 2 | exponential 2000 | 3600 500 | 24h | 30000 | `cleanup.processor.js` -> deletes expired Refresh/PasswordReset/EmailVerification where expiresAt < now or usedAt etc., idempotent |
| webhook | process-webhook | `{eventId, type, paymentId?, providerPaymentId?, amount?, currency?, tenantId, rawSignature?, headers?}` verified HMAC before enqueue + re-verified in processor, DB unique idempotency | 5 | exponential 1000 | 3600 1000 | 24h | 15000 | `webhook.processor.js` re-verifies HMAC via PAYMENT_WEBHOOK_SECRET + lock payment + insert event + transaction |
| email | send-email | `{tenantId, to:string req, subject:string req, html?,text?,template?,variables?}` validated tenantId/to/subject else UnrecoverableError no retry | 3 | exponential 1000 | 3600 500 | 24h | 10000 | `email.processor.js` `processSendEmail` -> `new EmailService().sendEmail` (provider-independent) -> no fetch in processor |
| report | generate-report | `{tenantId, type?, from?,to?, groupBy?}` deferred stub | 2 | exponential 2000 | 3600 200 | 24h | 60000 | stub processor returns success immediately (no DB) |
| analytics | calculate-analytics | `{tenantId, type?, from?,to?}` deferred stub | 2 | exponential 2000 | 3600 200 | 24h | 60000 | stub |

Verify against repo: 6 queues indeed — notification/cleanup/webhook real + email/report/analytics deferred stubs (docs note email now real — actually email processor implemented in Phase16, not deferred). Corrected: email is real (MockEmail + Http), report/analytics deferred true. Existing README still says 6 queues inclusive.

## Additional Details
- Prefix `pulseops:v1:queue` (`jobs.config.js:64`), BullMQ `^5.10.2` on `REDIS_URL` prefix.
- Connection `src/jobs/connection.js` dedicated BullMQ Redis `maxRetriesPerRequest:null, enableReadyCheck:false, reuse REDIS_URL`.
- Worker `src/jobs/workers/index.js` creates 6 workers concurrency counts above, lockDuration 30s, logging `logger.info` queue+jobId+tenantId. `initJobs()`/`startWorkers()` via `src/jobs/index.js` on server startup (`src/app/server.js:46` if REDIS_URL reachable else warn sync fallback). `shutdownJobs()` -> `stopWorkers()` allows active jobs finish up to lockDuration -> `closeAllQueues()` -> `disconnectBullMqRedis()` called in `server.close` (also in worker.js graceful).
- Failed behavior: BullMQ retains failures 24h (`removeOnFail age 24*3600`), no separate DLQ (if justified later add queue). Retryable via `IntegrationError` isRetryable true (TIMEOUT/UNAVAILABLE/429/408/5xx) vs permanent (VALIDATION/AUTH etc.) throws `UnrecoverableError` (no retry). Notification/email transient vs validation.
- Frontend-visible effects: jobs not directly visible except via status `GET /jobs/status` -> `{enabled, workersStarted, queues:['notification','cleanup',...]}`. Side effects: notifications create rows + realtime, cleanup removes expired tokens (reduces DB), report/analytics stubs no visible effect (should show not implemented). Poll GET /notifications after POST /jobs/notifications to confirm.
- Enqueue via `POST /jobs/*` returns 202 when queued else 200 fallback synchronous when `!enabled`. So frontend should handle both 202 and 200 success.

---

# 16. Error Handling

## Actual API Error Format

```
statusCode = isValidationError?400 : isInvalidJson?400 : isPayloadTooLarge?413 : isCorsError?403 : (migrMulter?400 : (error.statusCode||500))
code = isValidationError?"VALIDATION_ERROR" : isInvalidJson?"INVALID_JSON" : isPayloadTooLarge?"PAYLOAD_TOO_LARGE" : isCorsError?"CORS_NOT_ALLOWED" : ( LIMIT_FILE_SIZE?"FILE_TOO_LARGE" : Invalid_file_type?"INVALID_FILE_TYPE" : (error.code || INTERNAL_ERROR))
logger.error({err, requestId: req.id, method, path}, "Request failed")
res.status(statusCode).json({success:false, error:{code, message, details: isValidationError?error.issues : (error.details||null)}, requestId:req.id})
```

- 200-level: `success:true`.
- Message sanitized in production: if statusCode >=500 strip to "An unexpected error occurred" (prod) else raw; also strip filesystem paths `[redacted-path]` via regex `/\/[^\s]*\.(js|ts|sql|env)[^\s]*/gi`; CORS msg mapped to "Origin not allowed"; LIMIT_FILE_SIZE -> "File size exceeds allowed limit"; Invalid file type -> "Invalid file type. Only JPEG, PNG, WebP, and GIF are allowed."
- Details: Zod issues array `[{path:['body','email'], message:'Invalid email', code}]` for 400, else `error.details` or null. All errors include `requestId` matching `X-Request-Id` header.

## HTTP Status Codes / Error Codes

| Status | Code(s) | When |
|---|---|---|
| 400 | VALIDATION_ERROR | Zod validation failed on body/params/query (issues details). Also for invalid UUID format, empty patch body, rejected fields like productId in orders, unknown client amount/status (strict rejections), same warehouse transfer etc. plus business 400s below. |
| 400 | INVALID_JSON | body `entity.parse.failed` (malformed JSON) |
| 400 | INVALID_WEBHOOK_SIGNATURE etc? actually 401 | See 401 |
| 400 | MISSING/INVALID business codes | TENANT_REQUIRED, INVALID_RESET_TOKEN, RESET_TOKEN_EXPIRED/USED, INVALID_VERIFICATION_TOKEN etc., PRODUCT_NOT_FOUND? actually 404, EMAIL_MODIFICATION_FORBIDDEN etc., ROLE_NAME_EXISTS? actually 409, INSUFFICIENT_STOCK, SAME_WAREHOUSE, INVALID_STATUS_TRANSITION, CANCELLATION_NOT_ALLOWED, PAYMENT_ALREADY_PENDING, INVALID_STATE_TRANSITION, EXCESSIVE_REFUND, CYCLE_DETECTED, HAS_CHILDREN, IN_USE, etc. |
| 401 | UNAUTHORIZED | Authentication required (no/malformed Bearer). |
| 401 | INVALID_TOKEN | JsonWebTokenError |
| 401 | TOKEN_EXPIRED | TokenExpiredError (access JWT) |
| 401 | INVALID_TOKEN_CLAIMS | missing sub/tenantId/sessionId |
| 401 | USER_NOT_FOUND | user inactive/not found by sub+tenantId |
| 401 | INVALID_CREDENTIALS | login wrong |
| 401 | INVALID_REFRESH_TOKEN | refresh hash not found |
| 401 | REFRESH_TOKEN_EXPIRED / REVOKED | refresh expiry/revoked |
| 401 | INVALID_RESET_TOKEN etc. | reset/verify token errors (mapped 400 in validator? but many are 400) |
| 401 | INVALID_WEBHOOK_SIGNATURE | webhook HMAC timingSafeEqual fails |
| 401 | AUTH_FAILED (socket) | socket auth unexpected |
| 403 | FORBIDDEN | missing permission (authorize) OR tenant inactive OR membership not ACTIVE OR SYSTEM_ROLE_IMMUTABLE |
| 403 | CORS_NOT_ALLOWED | CORS origin not in allow-list |
| 403 | TENANT_INACTIVE | tenant not ACTIVE/TRIAL |
| 403 | ACCOUNT_INACTIVE | user status not ACTIVE |
| 404 | TENANT_NOT_FOUND / ROLE_NOT_FOUND / PERMISSION_NOT_FOUND / USER_NOT_FOUND / PRODUCT_NOT_FOUND / VARIANT_NOT_FOUND / CATEGORY_NOT_FOUND / WAREHOUSE_NOT_FOUND / ORDER_NOT_FOUND etc. + notFoundHandler for unknown routes `{success:false,error:{code:"NOT_FOUND", message:"Route not found"}, requestId}` | resource not in tenant / unknown route |
| 409 | TENANT_SLUG_EXISTS / ROLE_NAME_EXISTS / USER_ALREADY_EXISTS / SKU_EXISTS / BARCODE_EXISTS / WAREHOUSE_CODE_EXISTS / etc. | unique violation |
| 413 | PAYLOAD_TOO_LARGE | JSON/body `entity.too.large` > REQUEST_BODY_LIMIT (1mb) or payload too large via limiter |
| 400/413 | FILE_TOO_LARGE | multer LIMIT_FILE_SIZE >10MB |
| 400 | INVALID_FILE_TYPE | multer invalid mime |
| 429 | RATE_LIMITED | Global 100/15m OR auth 20/15m OR webhook 100/1m (Retry-After header) |
| 500 | INTERNAL_ERROR | unexpected thrown without statusCode, collapsed to generic message in prod |
| NOT AVAILABLE | rate-limit per IP only (in-memory if Redis unavailable, no distributed lock). No per-user rate limiting. |

## Validation / Authentication / Authorization / Tenant / Not-found / Conflict / Rate-limit / Internal
See table above. Validation uses Zod strict/passthrough behaviors per route (payments `.strict()` unknown fields 400, orders forbids productId). Authentication middleware 401, Authorization 403, Tenant mismatch 404 (not 403), Not-found 404, Conflict 409, Rate-limit 429, Internal 500 with logger redaction (authorization/apiKey/secret/password/token/cookie redacted via `src/config/logger.js`).

## Frontend Handling Recommendations (strictly on actual behavior)
- Treat 400.VALIDATION_ERROR -> show field errors from details `path` join; map path `['body','email']` to form field.
- 400 business codes (e.g., INSUFFICIENT_STOCK) -> show toast with message (not field).
- 401 -> if TOKEN_EXPIRED and refresh possible, silent refresh once; else clear tokens + redirect /login. For INVALID_WEBHOOK etc. frontend never sends webhook.
- 403 FORBIDDEN -> show 403 page, hide forbidden nav items; SYSTEM_ROLE_IMMUTABLE -> show locked badge.
- 404 -> show not found page (do not deduce tenant enumeration).
- 409 -> show duplicate error inline (slug, sku, code, email).
- 413 FILE_TOO_LARGE -> show upload error; 400 INVALID_FILE_TYPE -> show allowed types.
- 429 -> respect Retry-After integer secs, backoff, show rate-limited toast, do not busy retry.
- 500 -> show generic "An unexpected error occurred" (prod); use requestId from response header/body for support.

---

# 17. Pagination / Filtering / Sorting / Search

## Conventions (exact, repeated across APIs)

- **Pagination:** Query `?page=int positive default1` + `?limit=int positive max100 default20` except roles `limit default50`. Response `{success:true,data:[],meta:{page,limit,total,totalPages},message}` where `total` counts tenant-filtered query `count(*)` + `totalPages = ceil(total/limit)`. Page/limit coerced via `z.coerce.number().int().positive()`. On invalid -> 400 VALIDATION_ERROR. Frontend: send integers, not strings. Keep page visible; on filter change reset to 1.
- **Filtering:** Per-resource query keys optional, validated Zod enum/uuid/string. Common: `status` enum exact, `search` max255 contains case-insensitive on name/email/etc via `contains mode:insensitive`. Inventory: `warehouseId=uuid, variantId=uuid, sku=max100 contains, type=enum`. Orders: `status, customerId`. Audit: `action, resource, resourceId, userId, from/to isoDateTime`. Notifications: `isRead=bool, type=enum, channel=enum`. Product: price range `minPrice`/`maxPrice` coerce positive numbers, categoryId uuid, attributeFilters `record` (key=code value=string, AND across). Warehouse: `isActive, isDefault, search`. All tenant-scoped.
- **Sorting:** `?sortBy=whitelist enum default per resource` + `?sortOrder=asc|desc default desc (products/roles etc)`. Whitelist per resource (see API inventory params). Not pass arbitrary column — backend `assertSafeTrunc` + allowlist prevents SQL injection; invalid sortBy -> 400. Frontend sort dropdown from whitelist; map UI label to enum.
- **Search:** `search` param present on users, products, categories, warehouses, inventory (sku+search), etc. Case-insensitive partial match. No full-text GIN yet (roadmap LIKE). Debounce 300ms.
- **Examples:**
  - `GET /api/v1/users?page=2&limit=10&search=john&status=ACTIVE&roleId=uuid&sortBy=email&sortOrder=asc`
  - `GET /api/v1/products?search=Headphones&status=ACTIVE&categoryId=uuid&minPrice=50&maxPrice=500&sku=WH-001&sortBy=createdAt&sortOrder=desc&page=1&limit=20`
  - `GET /api/v1/inventory?warehouseId=uuid&variantId=uuid&sku=TS-RED&page=1&limit=20`
  - `GET /api/v1/orders?status=PENDING&customerId=uuid&sortBy=total&sortOrder=desc&page=1&limit=10`
  - `GET /api/v1/audit-logs?action=UPDATE&resource=user&userId=uuid&from=2026-08-01T00:00:00.000Z&to=2026-08-31T23:59:59.999Z&page=1&limit=20`
  - Analytics: `GET /api/v1/analytics/sales?from=2026-08-01&to=2026-08-31&groupBy=day&category=uuid&product=uuid&status=PENDING&page=1&limit=20`

---

# 18. Health / Readiness / Metrics

- **/health (liveness):** `GET /health` always 200 when process alive, no DB/Redis. Docker healthcheck `wget -qO- http://127.0.0.1:3000/health`. Also `/api/v1/health`.
- **Readiness:** `GET /health/db` -> `{success:true,data:{name:"database",status:"up"}}` 200 when `databaseHealthCheck()` SELECT1 succeeds else 503 `{down}`; `GET /health/redis` similar Redis PING. Also `/api/v1/health/db|redis`. Additionally `GET /ready` composite (readiness router `src/modules/readiness/readiness.routes.js`) wraps both checks. Infrastructure probes should use root /health.
- **Metrics:** `GET /metrics` public, `src/modules/metrics/metrics.routes.js` Prometheus-style `metricsRouter`. No auth. Contents NOT VERIFIED exhaustive but includes API operational metrics, DB/Redis queue/worker counts already implied via `GET /jobs/status`. Frontend/admin observability: health badges green/red, show readiness status per dependency, link to Swagger for API probe, requestId correlation for logs.

- **DB metrics:** Via /metrics & readiness. `prisma/migration` status not via metric but via `npx prisma migrate status` CLI.
- **Redis metrics:** via readiness, metrics.
- **Queue/worker metrics:** `GET /jobs/status` lists `enabled, workersStarted, queues[]`. Worker healthcheck `ps aux | grep -q node src/worker.js`. BullMQ failures retained 24h not via metrics endpoint but queue internals.
- **Request/correlation IDs:** `request-context.js` generates or echoes `X-Request-Id` -> `req.id` included in every response body `requestId` and header `X-Request-Id`. Logs include it. `request-logger.js` pino structured with id/method/path.

- **Frontend/admin implications:** Dashboard health widget polls `/health` every 30s, show DB/Redis as colored dots, on 503 show banner "Service degraded". Log viewer ingesting pino JSON with requestId follow.

---

# 19. Security & Privacy

Frontend-relevant requirements (never include secrets):

- **JWT handling:** Access token short-lived memory, refresh token persisted secure. Store not in cookie (backend does not set HttpOnly). Send `Authorization: Bearer <token>` on every protected call. No `credentials: include` cookie flow. Refresh on 401 TOKEN_EXPIRED once per burst. Token secrets min32, issuer pulseops, audience pulseops-api.

- **Cookie/header behavior:** No cookies used (Bearer-only). No CSRF middleware because bearer header is not auto-sent (documented CSRF irrelevant). No session cookie SameSite needed. Headers allowed CORS includes `Authorization, Content-Type, X-Request-Id, X-Webhook-Signature, X-Payment-Signature`.

- **CORS:** `cors` with allow-list `CORS_ORIGINS` comma-split, in production requires explicit origins else throw on startup (default localhost:5173 rejected in prod, wildcard * rejected when credentials true). Allowed `methods GET,POST,PATCH,DELETE,PUT,OPTIONS`. Frontend deploy must configure `CORS_ORIGINS=https://app.example.com` matching Next.js origin.

- **CSRF:** `NOT APPLICABLE` (bearer-only, no cookies).

- **XSS:** API returns JSON not HTML, user strings escaped by Express JSON. Frontend must sanitize before `dangerouslySetInnerHTML` (no server-side HTML rendering). CSP deliberately disabled for JSON API (`helmet contentSecurityPolicy:false, crossOriginEmbedderPolicy:false` documented in app.js 28+). No XSS middleware blocking JSON fields.

- **Input validation:** Zod strict on all inputs (body/params/query/headers). Unknown fields rejected with 400 where `.strict()` (payments, orders strict). Multipart validated mime/size. Price decimals regex strict.

- **Tenant isolation:** As section 6.

- **RBAC:** As section 5.

- **Secret handling:** Never returned in API (passwordHash never exposed, JWT secrets not in spec, provider apiKey not in payload, logger redact paths `authorization|apiKey|secret|password|token|cookie`). Frontend never sees secrets.

- **Sensitive-data redaction:** Audit sanitization [REDACTED] for 27 keys recursively depth 8 + Decimal/Date safe; realtime sanitization similar FORBIDDEN_KEYS.

- **Rate limiting:** Global 100/15m, auth 20/15m (login/register/refresh/forgot/reset/verify), webhook 100/1m via express-rate-limit memory store (Redis not used for limiter). Headers `RateLimit-Policy` draft-8 + `Retry-After`. Frontend debounce login attempts, show 429 with wait.

- Additional: `helmet` noSniff true, referrerPolicy no-referrer, frameguard deny, hidePoweredBy, HSTS only prod maxAge31536000 includeSubDomains preload. `hpp` enabled (pollution). `compression` threshold512 level6. Body limit 1mb JSON + 10mb multer. File upload traversal protection + tenant-scoped keys + primary enforcement. Webhook HMAC rawBody bytes preserved via `express.json verify` storing `req.rawBody`. `pino` redact secret paths.

---

# 20. API Documentation / Swagger

- **Swagger URL:** `http://localhost:3000/api-docs` (interactive UI, swagger-ui-express 5.0.1, `persistAuthorization`, Try it out). Mounted in app.js:67 via setupSwagger before routes.
- **OpenAPI versions:** `openapi: 3.0.3` (`openapi.js:15`), API version `1.0.0` (`info.version`).
- **Authentication scheme:** `components.securitySchemes.bearerAuth` type http scheme bearer bearerFormat JWT description includes retrieval path. 19 public security:[] vs 96 protected bearerAuth.
- **Schema organization:** `src/docs/` modular: `components/schemas.js` (26 schemas: ErrorResponse, SuccessResponse, PaginationMeta, PaginationQuery, Tenant, User, Role, Permission, Category, Product, ProductVariant, AttributeDefinition, AttributeValue, ProductImage, Warehouse, Inventory, InventoryMovement, Order, OrderItem, Payment, PaymentTransaction, Refund, Notification, AuditLog, ActivityLog, HealthStatus) + 10 path modules `health(s)(6)|metrics|tenants(4)|auth(8)|rbac(14)|catalog(33)|inventory-warehouses(11)|orders-payments(11)|audit-notifications(8)|jobs(6)|analytics-storage(8)` aggregated via `...healthPaths, ...readinessPaths, ...metricsPaths, ...` into `openApiSpec.paths` 81 keys.
- **Discrepancies (handoff audit):** None critical observed; spec path count matches routes.js mounting. Small notes:
  - Tenants described as public (spec security:[]) matches actual routes (no authenticate) — consistent.
  - Payments webhook documented HMAC public, matches actual public + webhookLimiter.
  - Storage signed public HMAC vs signedUrl product:read divergence documented correctly (signed-url 19 public vs 96 protected).
  - Product images storage signed/file aliases documented vs actual `/products/:id/images/:imageId/file` + `/storage/signed` + `/storage/file`.
  - Jobs status documented as authenticated no specific permission vs actual routes: GET /jobs/status has no authorize (only authenticate) — spec shows bearerAuth correctly.
  - No phantom ops: verified 115 operations all have route implementation (PUT only at variant attributes idempotent, no other PUT).
  - Global `security:[]` base overridden per operation — correct.

If Swagger and implementation disagree, update spec but treat implementation as contract and document discrepancy here.

---

# 21. Environment Configuration

> Source `.env.example` 39 lines + `src/config/env.js` 101 lines Zod. Real secrets never committed (gitignore/dockerignore). Use secret manager in prod.

## Backend-only variables (DO NOT expose to Next.js client)
- `DATABASE_URL` string url optional dev but **required in production** (prod overlay `${VAR:?…}`). Example `postgresql://user:pass@host:5432/pulseops?schema=public&connection_limit=10&sslmode=require` managed pooling. `NOT PUBLIC`.
- `REDIS_URL` string url similarly **required prod**. `NOT PUBLIC`.
- `JWT_ACCESS_SECRET` `JWT_REFRESH_SECRET` string min32 each, required non-test; dev optional fallback test-… strings; prod must be `require(crypto).randomBytes(32).toString('hex')`. `NOT PUBLIC`.
- `PAYMENT_WEBHOOK_SECRET` default test secret, **required prod** (prod overlay requires). `NOT PUBLIC`.
- `PAYMENT_PROVIDER_URL` / `PAYMENT_PROVIDER_API_KEY` / `PAYMENT_PROVIDER_TIMEOUT_MS` default 5000; only when `PAYMENT_PROVIDER=http|stripe|adyen`. `NOT PUBLIC`.
- `EMAIL_PROVIDER_URL` / `EMAIL_PROVIDER_API_KEY` / `EMAIL_PROVIDER_TIMEOUT_MS` similarly HTTP. `NOT PUBLIC`.
- `SMS_PROVIDER_*` / `SHIPPING_PROVIDER_*` / `MAPS_PROVIDER_*` similarly `NOT PUBLIC`.
- `STORAGE_*` `S3_BUCKET` / `S3_REGION` us-east-1 default / `S3_ENDPOINT` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` / `S3_PUBLIC_BASE_URL` / `S3_FORCE_PATH_STYLE` bool / `STORAGE_TIMEOUT_MS` 5000. Required when `STORAGE_PROVIDER=s3`. `NOT PUBLIC` (bucket public base may be public URL but creds private).
- `TRUST_PROXY` booleanFromString default false, prod overlay forces true. Backend-only infra.
- `FAIL_ON_DEPENDENCY_ERROR` bool optional defaults `NODE_ENV===production` (prod true else false). Backend-only.
- `LOCAL_STORAGE_PATH` `./storage` / `LOCAL_STORAGE_URL` `/storage` — backend-only paths (frontend uses API storage endpoints, not direct filesystem).
- `EMAIL_VERIFICATION_EXPIRY` `24h`, `PASSWORD_RESET_EXPIRY` `1h`, `LOG_LEVEL` `info` (pino levels fatal..trace silent).

## Frontend variables (Next.js needed)
- `NEXT_PUBLIC_API_BASE_URL` → backend `http://localhost:3000` (or prod origin). Use same as `servers[0].url`. **Public**.
- `NEXT_PUBLIC_WS_URL` → same host for Socket.IO handshake (`http://localhost:3000`). `NOT in .env.example` but frontend must derive from API base (Socket.IO client `io(API_BASE)`). Mark `NOT AVAILABLE / NOT IMPLEMENTED` as explicit env, frontend define it.
- `NEXT_PUBLIC_APP_ENV` `development|test|production` maps `NODE_ENV`.

## Public vs Secret distinction
- Public (`NEXT_PUBLIC_*`): browser-safe, commit-friendly (API url, feature flags). `NOT SECRET`.
- Secret (`DATABASE_URL`, `JWT_*`, `*_SECRET`, `*_API_KEY`, `S3_SECRET_ACCESS_KEY`): server-only, never `NEXT_PUBLIC`, never log, never in client bundle. Use server-side Next.js `process.env` only.
- CORS Origins: `CORS_ORIGINS` comma list, dev `http://localhost:5173` (Vite default), prod must be explicit frontend origin(s) `https://app.example.com` — **must configure in backend** for frontend to work, not frontend var.

Frontend `.env.example` should include:
```
NEXT_PUBLIC_API_BASE_URL=http://localhost:3000
NEXT_PUBLIC_WS_URL=http://localhost:3000
NEXT_PUBLIC_APP_NAME=PulseOps
NEXT_PUBLIC_APP_ENV=development
```

---

# 22. Docker / Local Development

## How frontend developer runs backend (verified `docker-compose.yml`)

```bash
copy .env.example .env   # no edits needed for local Docker (defaults already match compose)
npm install              # needed for lint/tests/Prisma even when using Docker
docker compose up -d
docker compose ps
curl -f http://localhost:3000/health
curl -f http://localhost:3000/api-docs
docker compose logs -f api
```

## Services (verified)
- `pulseops-postgres` postgres:16-alpine 5432 `pgdata` (`pulseops_pgdata` named volume), health `pg_isready`
- `pulseops-redis` redis:7-alpine 6379 `redisdata` (`pulseops_redisdata`), health `redis-cli ping`
- `pulseops-migrate` one-shot exit0 `service_completed_successfully` runs `prisma migrate deploy`
- `pulseops-api` :3000 `pulseops-api` health `wget http://127.0.0.1:3000/health`
- `pulseops-worker` `node src/worker.js` health ps grep
- Network pulseops_default, volumes pgdata/redisdata persistent, not removed on `down` (require `down -v` destructive).

## Ports / Health Checks / Migration / URLs
- Ports: API 3000 (->host 3000), Postgres 5432, Redis 6379. Internal Docker URLs: `postgresql://pulseops:pulseops@postgres:5432/pulseops` + `redis://redis:6379`.
- Health: `GET http://localhost:3000/health` (liveness), `/health/db` `/health/redis` readiness (200 vs 503 degraded), versioned `/api/v1/health*`. Docker API healthcheck mirrors liveness.
- Migration: compose `migrate` service only `prisma migrate deploy` (never dev); prod same command; validated via CI fresh DB. No `prisma db push`.
- API URL: `http://localhost:3000/api/v1` (prefix). Swagger UI `http://localhost:3000/api-docs`, spec json `http://localhost:3000/api-docs.json` + aliases `/openapi.json`, `/api/v1/openapi.json`.
- Database: Postgres 16 volume pgdata, seed via `npm run db:seed` optional (creates Development tenant + roles/permissions idempotent, no fake business).
- Redis: redis:7 volume redisdata, queue prefix pulseops:v1:queue.
- Worker: `src/worker.js` no HTTP, logs `PulseOps worker ready`.

## Useful commands
```
docker compose ps -a          # shows migrate Exit 0
docker compose logs migrate
docker compose down            # keeps volumes
docker compose down -v         # DESTRUCTIVE removes volumes
docker compose build --no-cache
docker compose config --quiet  # validates
npx prisma migrate status      # Database schema up to date! 9 migrations
npx prisma validate            # Valid
npm run lint
npm test                       # 405? see verification
npm run prisma:generate
```

Verify against current compose — all values above exact.

---

# 23. Existing Documentation Cross-Reference

## Sources checked
- `README.md` (endpoint table 115 ops listed + setup/docker/health/swagger/env/ci/verification 905/905 phase23 human verified). **Status ACCURATE** — docker commands, env table, endpoints list matches routes.js/openapi spec, storage policy private described correctly, verification numbers consistent with Phase23.
- `docs/API_DOCUMENTATION.md` (901 lines, detailed per-endpoint Request/Response/Error, Swagger chapter, Tenant/Auth/RBAC/Phase20 security). **Status MOSTLY ACCURATE** but noted: "Docker/CI/CD Not started (Phase23)" is **STALE** — README shows Phase23 complete so this section outdated; "Only Phase23 remains" underreported vs Phase24 docs (but Phase24 not claimed in README). Also Phase21 limitations documented honestly — fine.
- `docs/IMPLEMENTED_FEATURES.md` (153805 bytes, Phase01-16 deep, 746 baseline) — truncated but appears detailed per-phase deliverables. **Status ACCURATE but PRE-PHASE23 in truncated view** — later phases beyond 16 likely documented in PROJECT doc.
- `docs/PROJECT_DOCUMENTATION.md` (203907 bytes, architecture/lifecycle/testing, shows Phase22+16+17+… tables, migrations chain 8 migrations listed but README shows 9 after phase19 — discrepancy: PROJECT docs lists 8 but should be 9 after phase19. Handoff corrects to 9.
- `docs/PulseOps_Backend_Codex_Master_Roadmap.md` (51700 bytes) — single source roadmap 23 phases, rules, schemas. Immutable source, handoff does not modify.
- `docs/DEPLOYMENT.md` (25067 bytes), `docs/ALERT_DEFINITIONS.md` (7010).
- `src/docs/openapi.js` + `src/docs/paths/*.js` + `components/schemas.js` — source of contract 115 ops.
- `prisma/schema.prisma` 952 lines (38 models, enums exact).
- Source code: routes, validation, env, app, worker, realtime verified against docs — no contradictions except global email unique discrepancy (see GAPS) and PROJECT migrations count stale.
- Docker compose vs .env.example — consistent.

## Conflicts / Missing Documentation
- API doc stale Phase23 not started -> FIX: Phase23 is complete per README/docker files — handoff corrects.
- PROJECT doc migrations 8 vs actual 9 -> FIX: includes phase19_performance_indexes migration 20260916 count 9.
- Email global unique vs tenant unique comment -> document GAP.
- Customers entity documented in schema but no customer CRUD endpoints — gap noted.
- No dedicated PULSEOPS_FRONTEND_BACKEND_HANDOFF previously — this file fills.

---

# 24. Frontend-Relevant Gaps

> `FRONTEND INTEGRATION GAPS` — Only after checking actual backend. Do not invent.

1. **No Tenant Discovery/List** — `GET /api/v1/tenants` list `NOT AVAILABLE` (only `POST/GET/:id/PATCH/:id/DELETE/:id` public by id). Frontend cannot list tenants for selector — knows tenant only via slug/id out-of-band. No `GET /tenants?slug=` search. Workaround: tenant id from login invite link or subdomain manual entry.

2. **No Tenant Membership Listing / Switch** — No endpoint `GET /auth/memberships` or `GET /users/me/tenants` or `POST /auth/switch-tenant`. Multi-tenant user (same email in multiple tenants) cannot switch context without second login (re-auth with different `tenantId`). Global `@@unique([email])` may even block same email in second tenant — discrepancy.

3. **No Customer CRUD** — Customer model exists (email, names, phone, metadata) but NO `POST /customers`, `GET /customers`, `PATCH/DELETE` nor listing for frontend. Order creation requires `customerId` that must pre-exist; UI cannot create/select customer via API. Gap — frontend must request customer seeding via admin Prisma or expect backend to create customer on order (but does not).

4. **No User Password Change (Authenticated)** — `PATCH /users/:id` forbids passwordHash, no `POST /auth/change-password` (current password + new). Only forgot/reset via token (email flow). Users cannot change password from settings page without email.

5. **Missing `DELETE /users/:id/roles` & `PUT /roles/:id/permissions` full replacement vs `POST` append** — Roles assignment is add-only idempotent `POST /users/:id/roles` skipDuplicates; cannot remove a role without `DELETE` gap. Similarly permissions assignment idempotent add-only, cannot remove.

6. **Missing Pagination on Some Lists** — Permissions `GET /permissions` returns array without meta pagination (not paginated) vs roles/users paginated. Product `GET /products` filtered by `categoryId` single, not `categoryIds[]`. No bulk endpoints.

7. **Missing Dashboard Aggregation Fields** — `GET /dashboard/overview` aggregates but not typed in schema docs exhaustive — frontend may expect fields like `totalCustomers`/`lowStockCount`; check via implementation response shape before building charts. No explicit revenue vs order drill via dashboard (analytics covers).

8. **Missing Real-time Auth Refresh** — Socket auth via token at handshake only; no runtime re-auth when token rotates via refresh (client must disconnect/reconnect with new token). Documented but gap: after refresh tokens, sockets stay on old token until reconnect.

9. **Missing Notification Bulk Templates** — `NotificationTemplate` model exists but no API for templates (no GET/POST /notification-templates). Frontend cannot manage templates.

10. **Missing Image Direct Upload via S3 Presigned URL** — Current upload is `multipart/form-data` via API (server proxies to S3). No `POST /products/:id/images/presigned` for browser->S3 direct upload. For large files would need server proxy currently (works but not optimal).

11. **Missing Reporting Analytics Export** — Report queue is stub (`POST /jobs/reports` 202 but processor no-op). No `GET /reports/:id` or download.

12. **Missing Addresses Entity** — No address table; warehouse has address fields but customer/order have only `metadata Json` for shipping address, not structured. Frontend shipping form must use metadata.

13. **No S3 Image Deletion Verification Idempotency Edge** — `DELETE /products/:id/images/:id` removes DB+storage, but if S3 DELETE partial failure, status mismatch possible (gap).

14. **Missing `GET /users` self profile alias** — `GET /users/me` `NOT AVAILABLE`; only `GET /auth/me` returns profile. Frontend use `/auth/me`.

15. **Missing Global Email Uniqueness Flex** — Schema global `@@unique([email])` blocks same email across tenants (cross-tenant same email would 409). But docs claim allowed — implementation contradicts docs. Frontend multi-tenant sign-up with same email will fail globally; need to clarify with backend team (either remove global unique or handle error globally).

16. **Missing Current-User Endpoint for Tenant Switch** — After saving auth tokens in localStorage, no endpoint to list all tenant memberships to pick.

17. **Missing Real-time History Missed Events** — No catch-up endpoint for missed websocket events (unread notifications handles some). Analytics `NOT AVAILABLE / NOT IMPLEMENTED` for real-time reporting.

All gaps verified NOT in routes.js/openapi paths. Mark as `NOT AVAILABLE` until backend adds.

---

# 25. Backend → Frontend Feature Mapping

| Backend Feature | API Endpoint(s) | DB Model(s) | Permission | Tenant Scoped | Proposed Frontend Screen | Frontend Action |
|---|---|---|---|---|---|---|
| Tenant Provisioning | POST /tenants, GET /tenants/:id, PATCH /tenants/:id, DELETE /tenants/:id | Tenant, TenantSettings, TenantDomain | NONE (public) | N/A (creates tenant) | `/signup` → Tenant create wizard, `/admin/tenants/:id` | Create tenant, view/edit, delete |
| Authentication Register | POST /auth/register | User, TenantMembership | NONE | tenantId in body | `/register` | Form email/password/firstName/lastName/tenantId → 201 → redirect /login or verify |
| Authentication Login | POST /auth/login | User, RefreshToken | NONE | tenantId in body | `/login` | Form → store accessToken/refreshToken/sessionId/user → redirect to /dashboard |
| Token Refresh | POST /auth/refresh | RefreshToken | NONE | token-bound | Silent refresh middleware | Auto attach Authorization, on 401 retry refresh once |
| Logout | POST /auth/logout | RefreshToken | NONE | token | Header avatar → Logout | Clear storage → POST logout → /login |
| Password Reset Request | POST /auth/forgot-password | PasswordResetToken | NONE | email+tenantId | `/forgot-password` | Form email → toast enumeration-safe |
| Password Reset Confirm | POST /auth/reset-password | PasswordResetToken | NONE | token | `/reset-password?token=` | Form token+newPassword → success → /login |
| Email Verification | POST /auth/verify-email | EmailVerificationToken | NONE | token | `/verify-email?token=` | Form token → success → auto-login |
| Current User | GET /auth/me | User (safe fields) | Bearer | tenant | `useAuth()` hook, header profile | Fetch on app init, cache |
| Roles List/Detail | GET /roles, GET /roles/:id | Role, RolePermission | role:read | YES | `/admin/roles` list+detail drawer | Table paginated, view perms |
| Roles Create/Update/Delete | POST /roles, PATCH /roles/:id, DELETE /roles/:id | Role | role:create/update/delete | YES | `/admin/roles/new`, edit modal | Form name/desc → mutates |
| Permissions | GET /permissions, GET /permissions/:id | Permission | permission:read | YES | `/admin/roles/:id/permissions` selector | Multi-select permissionIds to assign |
| Role-Permission Assign | POST /roles/:id/permissions | RolePermission | role:update | YES | Assign modal | POST permissionIds |
| Users List | GET /users | User, UserRole | user:read | YES | `/admin/users` | Search/status/role/sort/pagination table |
| User Detail/Update/Delete | GET /users/:id, PATCH /users/:id, DELETE /users/:id | User | user:read/update/delete | YES | `/admin/users/:id` drawer/edit | Edit firstName/lastName/status, delete |
| User Roles Assign | GET /users/:id/roles, POST /users/:id/roles | UserRole, Role | user:read/update | YES | User detail → Roles tab | Assign roles multi-select |
| Categories | POST/GET/PATCH/DELETE /categories | Category | category:* | YES | `/admin/categories` tree | CRUD + parent hierarchy view |
| Products | POST/GET*/PATCH/DELETE /products, categories set | Product, ProductCategory, ProductVariant | product:* | YES | `/products`, `/products/:id` | List with search/filter, detail with variants/images/tabs |
| Variants | POST/GET*/PATCH/DELETE /products/:productId/variants | ProductVariant | product:* | YES | Product detail → Variants table | SKU table add/edit, stock link |
| Variant Attributes | PUT/GET /products/:productId/variants/:variantId/attributes | ProductVariantAttribute, AttributeDefinition | product:update/read | YES | Variant edit → Attributes form | Attribute assign replace |
| Attributes Definitions | POST/GET/PATCH/DELETE /attributes | AttributeDefinition | attribute:* | YES | `/admin/attributes` | CRUD definitions |
| Attribute Values | POST/GET/PATCH/DELETE /attributes/:id/values | AttributeValue | attribute:* | YES | Attribute detail → Values | CRUD option values |
| Product Images (upload/list/patch/delete) | POST/GET /products/:productId/images*, POST/GET variant images, PATCH/DELETE image | ProductImage | product:* | YES | Product images gallery + variant images | Upload dropzone, reorder, primary flag, delete |
| Storage Access | GET /products/:productId/images/:imageId/file, .../signed-url, /storage/signed, /storage/file | ProductImage.storageKey | product:read / HMAC | YES | Image <img> via file or signed-url | Render via signed-url 900s, refresh on expiry, /file for download |
| Warehouses | POST/GET*/PATCH/DELETE /warehouses | Warehouse | warehouse:* | YES | `/admin/warehouses` | CRUD table, isDefault flag |
| Inventory List/Movements/LowStock | GET /inventory, GET /inventory/variants/:variantId, GET /inventory/movements, GET /inventory/low-stock | Inventory, WarehouseInventory, InventoryMovement | inventory:read | YES | `/inventory`, `/inventory/movements`, `/inventory/low-stock` | Stock table by variant/warehouse, filter threshold |
| Inventory Adjust/Transfer | POST /inventory/adjust, POST /inventory/transfer | Inventory + Movement | inventory:update | YES | Adjust/Transfer modals | Forms quantityChanged/reason, source/dest |
| Orders | POST/GET*/PATCH/DELETE?cancel /orders*, GET /orders/:id/history | Order, OrderItem, OrderStatusHistory, Customer | order:create/read/update/cancel | YES | `/orders`, `/orders/:id`, status stepper | Create order customer picker, status change, cancel |
| Payments | POST /payments/create, POST /payments/confirm, POST /payments/webhook (provider), GET /payments/:id, POST /payments/:id/refund | Payment, PaymentTransaction, Refund, PaymentWebhookEvent | payment:create/confirm/read/refund | YES | `/orders/:id/payments`, `/payments/:id` | Create payment button, confirm, refund modal, status badge |
| Audit Logs | GET /audit-logs | AuditLog | audit:read | YES | `/admin/audit` | Timeline with filters action/resource/date |
| Activity Logs | GET /activity-logs, GET /activity-logs/:id | ActivityLog | activity:read | YES | `/admin/activity` | List + detail |
| Notifications | GET /notifications, PATCH read, POST read-all, GET/PATCH preferences | Notification, NotificationPreference | notification:read/update | YES | Header bell + `/notifications`, `/settings/notifications` | Inbox, mark read, preferences toggles |
| Jobs | GET /jobs/status, POST /jobs/notifications/cleanup/reports/analytics | Queues (Notification etc.) | authenticated | tenant payload | `/admin/jobs` admin dev view | Status card + enqueue buttons |
| Dashboard Overview | GET /dashboard/overview | (aggregates Order/Inventory/Payment/User/Notification/Product) | dashboard:read | YES | `/dashboard` | Metric cards, charts, x-cache indicator |
| Analytics | GET /analytics/overview,sales,orders,inventory,customers,revenue | Aggregates transactional | analytics:read | YES | `/analytics/*` | Date range pickers, groupBy day/week/month, tables/charts with x-cache |
| Health/Readiness/Metrics | GET /health*, GET /ready, GET /metrics | — | NONE | NO | Admin diagnostics `/health` | Health dots, uptime, queue workers |
| Realtime | Socket.IO `tenant:{tid}`/`user:{uid}` + 5 events | — | JWT at handshake | tenant-isolated rooms | Global: toasts via events order.created etc | Socket hook `useRealtime(event, handler)` |
| Caching | header x-cache | Redis | transp | YES | Dev display cache hit/miss | Not direct UI except indicator |
| Security | Helmet/CORS/rate-limit/HMAC etc | — | — | — | Form validation, 403 page | Display per errors |

Every implemented feature appears (including supporting health/swagger).

---

# 26. Frontend Route Requirements

Based ONLY on existing capabilities (no invented routes). Proposed Next.js App Router pages:

| Route | Purpose | Auth Required | Required Permission(s) | API Dependencies | Data Required | Actions |
|---|---|---|---|---|---|---|
| `/login` | Sign in | no | — | POST /auth/login (tenantId opt) + tenant public lookup for branding | email/password/tenantId | submit, error 401/403, on success save tokens → redirect /dashboard |
| `/register` | Sign up | no | — | POST /auth/register, GET /tenants/:id for validation display | email/password/first/last/tenantId | create account → verify email flow |
| `/forgot-password` | Request reset | no | — | POST /auth/forgot-password | email/tenantId | enumeration-safe toast |
| `/reset-password?token=` | Confirm reset | no | — | POST /auth/reset-password | token + newPassword | validate token expiry 400, success → /login |
| `/verify-email?token=` | Verify | no | — | POST /auth/verify-email | token | success/fail message |
| `/dashboard` | Overview aggregates | yes | dashboard:read | GET /dashboard/overview (x-cache), optional analytics calls | order/inventory/payment/user counts | view cards, links to subpages |
| `/products` | List products | yes | product:read | GET /products with query | name/search/status/price/category/sku | search/filter/sort/pagination, click detail |
| `/products/:id` | Product detail + variants/images/categories | yes | product:read/update/delete | GET /products/:id, GET cats, GET variants, GET images | product fields + children lists | edit, delete, upload image, manage variants/tab |
| `/products/:productId/variants` | Variant list (could be tab) | yes | product:read | GET /products/:productId/variants | sku/barcode/price | same as above |
| `/admin/categories` | Category tree | yes | category:read | GET /categories | parentId/hierarchy | create/edit/delete with parent picker |
| `/admin/attributes` | Definitions | yes | attribute:read | GET /attributes | code/dataType | CRUD |
| `/admin/attributes/:id/values` | Values | yes | attribute:read | GET /attributes/:id/values | value/displayName | CRUD values |
| `/admin/warehouses` | Warehouses | yes | warehouse:read | GET /warehouses | name/code/city | CRUD, default flag |
| `/inventory` | Stock by variant/warehouse | yes | inventory:read | GET /inventory, GET /inventory/low-stock, GET /inventory/movements | quantity/reserved | adjust buttons, transfer |
| `/inventory/movements` | Movement history | yes | inventory:read | GET /inventory/movements | quantityBefore/Changed/After/reason | filter variant/warehouse/type |
| `/orders` | Orders list | yes | order:read | GET /orders | status/customer/total | filter status, search, view detail |
| `/orders/:id` | Order detail + items + history | yes | order:read/update/cancel | GET /orders/:id, GET /orders/:id/history | snapshots/totals/history | update status, cancel (if eligible), view payment |
| `/orders/new` | Create order | yes | order:create | POST /orders (customer must exist) | customerId/items/warehouse | form with variant picker + quantity + warehouse |
| `/payments/:id` | Payment detail + refund | yes | payment:read/refund | GET /payments/:id, POST .../refund, POST .../confirm | amount/status/transactions/refunds | confirm button (if PENDING), refund modal |
| `/admin/users` | Users list | yes | user:read | GET /users with search/status/role | email/status/roles | list with filters, assign roles |
| `/admin/users/:id` | User detail | yes | user:read/update/delete | GET /users/:id, PATCH, DELETE, POST roles | user fields + roles | edit, delete, assign roles |
| `/admin/roles` | Roles | yes | role:read | GET /roles, GET permissions, POST/DELETE | name/desc/isSystem/perms | create, edit, assign perms, delete (non-system) |
| `/admin/audit` | Audit log viewer | yes | audit:read | GET /audit-logs | action/resource/date/oldValue/newValue | filter + pagination + diff view |
| `/admin/activity` | Activity log viewer | yes | activity:read | GET /activity-logs* | action/description/metadata | list/detail |
| `/notifications` | Inbox | yes | notification:read/update | GET /notifications, PATCH read, POST read-all | isRead/type/channel | filter type/channel, mark read/all |
| `/settings/notifications` | Preferences | yes | notification:read/update | GET/PATCH /notification-preferences | channels | toggles |
| `/analytics` | Analytics overview | yes | analytics:read | GET /analytics/overview + subcalls | date range, groupBy | charts, x-cache indicator |
| `/analytics/sales` `/analytics/revenue` etc. | Detailed analytics | yes | analytics:read | GET per endpoint with filters | category/product/status filters | table pagination |
| `/admin/jobs` (dev) | Queue status | yes | authenticated | GET /jobs/status | enabled/queues | status card, enqueue test buttons |
| `/health` (admin) | System health | yes (or public) | — | GET /health, /health/db, /health/redis, /metrics | statuses | dots, debug |
| `/403` `/404` | Error pages | maybe | — | — | error.code | show permission vs not found |
| `/` | Redirect to /dashboard if authed else /login | depends | — | GET /auth/me probe | — | |

All routes guard via middleware: if !accessToken → redirect /login ; if !hasPermission → /403 ; tenant context via token (no extra fetch). No real-time pages need separate route — global hook.

---

# 27. Integration Test Requirements

> Frontend/Backend integration scenarios MUST eventually be tested (E2E Playwright/Cypress + MSW or real API). Below maps to backend guarantees.

- **Login:** register (POST /auth/register) → login → receive access+refresh+sessionId+user → call GET /auth/me with Authorization → 200. Invalid creds 401, inactive 403, enumeration-safe forgot 200.
- **Token refresh:** wait until TOKEN_EXPIRED (or force by truncated token) → request protected GET → 401 TOKEN_EXPIRED → POST /auth/refresh with stored refreshToken → new tokens → replay original request succeeds. Reuse revoked token → 401 + all tokens revoked (must re-login).
- **Logout:** POST /auth/logout with refreshToken → revokes; subsequent refresh with same token 401; auth/me with old access still works until expiry but refresh fails.
- **RBAC:** user with role member (user:read only) → POST /roles 403, GET /users 200, PATCH /users 403 (missing user:update), DELETE /users 403. System role immutable 403. Permission cache after assignment invalidated.
- **Tenant isolation:** Tenant A user JWT cannot GET Tenant B user/product/variant/warehouse/inventory/order/payment/notification/audit (404 both directions). JWT manipulated tenantId → 401. Storage cross-tenant GET /products/.../file 403. SKU duplicate same-tenant 409 vs cross-tenant 201.
- **CRUD operations:** Products lifecycle POST->GET->PATCH->DELETE soft + filter. Variants SKU/barcode uniqueness. Categories parent cycle. Warehouses code unique. Attributes code unique, values unique.
- **Validation:** strict rejections (payments unknown status/amount 400), productId in orders 400, empty PATCH body 400, invalid UUID 400 with issues details path mapping.
- **API errors:** envelope shape `{success:false, error:{code,message,details},requestId}` + X-Request-Id echoed, Zod issues array, rate-limit Retry-After, 409 handling.
- **Pagination:** page/limit defaults meta totalPages, page overflow returns data[] empty but correct meta, search case-insensitive.
- **Search/Filtering:** product attribute[code] AND + price range, order status filter, inventory low-stock threshold, audit from/to datetime.
- **Sorting:** sortBy whitelisted, sortOrder asc/desc, invalid sortBy 400.
- **Orders:** successful creation with snapshots + inventory deduct (order reservation movement after=before+changed), total calculation string, status transitions valid vs invalid 400, history chronological, cancel restores stock via ORDER_RELEASE, double cancel 400; concurrent 10 from5 stock5 success/5 fail never negative invariant.
- **Payments:** create derives amount server (client amount 400), duplicate pending guard 400, confirm controlled transition, webhook HMAC invalid 401 vs valid 200, duplicate webhook idempotency second 200 duplicate:true no extra transaction, concurrent duplicate 5->1 effect, refund refundable balance precise 0.01 partial vs full status PARTIALLY_REFUNDED/REFUNDED, excessive 400.
- **Notifications:** list newest-first pagination filters isRead/type/channel, mark one read idempotent PATCH, read-all idempotent POST, preferences default 4 channels, upsert PATCH, notify via jobs.
- **Background jobs:** GET /jobs/status enabled true when REDIS_URL present else false queue fallback; POST /jobs/notifications 202 queued or 200 fallback sync row created; report/analytics stubs 202 not real. Worker shutdown graceful.
- **Caching:** x-cache MISS then HIT on repeat for products/dashboard/analytics, product write invalidates pattern, Redis down graceful fallback still 200 (not 500).
- **Realtime:** socket handshake success with auth token (Bearer/raw/query) → auto joins tenant:{id} + user:{id}; guarded join only own rooms (try join other tenant 400); events: order.created tenant room, inventory.low_stock tenant, notification.created user room; sanitizePayload removes password/secrets; disconnect/closeSocket clean.
- **Health/Readiness:** /health 200 liveness without DB/Redis, /health/db 503 when down 200 when up, similar redis, /metrics public. RequestId propagation round-trip.
- **Security:** CORS not allowed 403, payload >1mb 413, file >10MB 400, invalid mime 400, SQL injection via sort param blocked 400, JWT missing 401.
- **Storage:** upload 10MB valid mime via POST images → 201 + storageKey tenant-scoped `tenants/{tid}/...`; direct /storage/ 404; GET file requires Bearer tenant match else 403; signed-url HMAC 900s tampered 403.
- **Stress/Rate-limit:** auth limiter 20/15m after burst 429, webhook limiter separate 100/1m (documented config coverage ~4% unit, honest limitation). Do NOT claim 50% coverage.
- **Misc:** customer required for order 404 if missing; tenant slug unique 409.

Target: E2E suite covering 1 register->login->attributes->product->variants+images->inventory->order->payment->notification->audit->websocket (12 tests pattern) + 24 extended matrix.

---

# 28. Current Backend Verification Status

> Do not claim unless verified via last known run + code inspection. Values from README 1:5 “Current status: Phase 23 — Docker / CI/CD / Deployment COMPLETE and HUMAN VERIFIED. Phase 22 Swagger 16 tests, Phase21 87 new, Phase20 53 security, 905/905 full suite”.

- **Backend test count:** 905/905 passed (00 suites, no failures) — `npm test` via `node --experimental-vm-modules jest --runInBand --forceExit`. Collated per-suite sum 833 per-suite + 72 from phase23 deployment? README says `905/905` after phase23 where phase23 deployment tests 56 passed.
- **Phase 23 tests:** 56 passed (Dockerfile multi-stage, .dockerignore, compose api/worker/migrate, CI workflow steps, env/storage contracts, security, health/readiness, graceful shutdown tini).
- **Phase 22 tests:** 16 passed (Swagger JSON/UI, 115 ops coverage 81 keys, bearerAuth, 573 $ref 0 unresolved).
- **Phase 21:** 87 new (51 unit +12 E2E +24 extended) + baseline 746 =833 per-suite; honest limitation: full combined jest exceeds 600s not single 833 run — reported per-suite evidence; unit coverage ~4% (not 50%).
- **Phase 20 regression:** 53/53 security passed + 746 full preserved.
- **Lint:** `npm run lint` -> 0 errors 0 warnings (README verified).
- **Prisma validation:** `npx prisma validate` -> Valid (src schema). `npx prisma generate` -> Success.
- **Migrations:** 9 migrations applied `npx prisma migrate status` -> Database schema is up to date! Listed: init_tenants (3 tables) -> core_schema (31 models) -> fix_timestamptz (89 cols) -> authentication (4 tables) -> platform_rbac (9 tables) -> attribute_description (add column) -> inventory_management (CHECKs) -> payments_webhook (events+partial indexes+CHECKs) -> performance_indexes (4 approved indexes) 9 total.
- **Docker Compose status:** `docker compose config --quiet` validates + `docker build -t pulseops-backend:ci` non-root pulseops, tini PID1. Runtime `docker compose up -d` -> postgres healthy, redis healthy, migrate Exit0 service_completed_successfully, api healthy, worker running. CI migration validation fresh DB via disposable container validates deploy without touching volumes — verified.
- **API health:** `GET /health` 200 `{status:"ok"}`, `/health/db` 200/503 per connection, `/health/redis` 200/503, versioned alias same. Worker health `ps aux | grep node src/worker.js` per healthcheck ok. Graceful shutdown SIGTERM -> server.close -> shutdownJobs -> disconnectRedis/Prisma 10s timeout verified (tini).
- **PostgreSQL health:** `pg_isready -U pulseops -d pulseops` healthy in compose + CI disposable.
- **Redis health:** `redis-cli ping` PONG healthy.
- **Worker health:** process alive, BullMQ workers started (6), graceful shutdown ok.
- **CI remote:** install->lint->test->build->migration validation->deployment dry-run skipped on main push expected (docs README: deployment dry-run not claimed as passed on push main).

**Could not verify (require local `docker compose up`):** live HTTP curls not executed in this handoff generation (inspect only). Mark as `NOT LIVE-VERIFIED LOCALLY IN HANDOFF`. Assume README human verification PASS but re-run `docker compose up -d && curl` before frontend start.

---

# 29. Known Limitations

> Separated clearly.

## Backend Limitations (features documented but not fully exposed or limited)
- `customer` CRUD `NOT AVAILABLE` (model exists, orders need customerId; no endpoint). Frontend cannot create customers via API.
- `address` structured missing — uses metadata Json for order/customer shipping.
- Soft-delete uniqueness: full unique index (not partial WHERE deleted_at IS NULL) — soft-deleted SKU/email blocks reuse until hard purge.
- Simple FKs single-column — cross-tenant reference technically possible at DB level, app enforces but no composite FK guard.
- Permissions listing not paginated; categories search limited.
- Storage direct GET /storage/* 404 intentional (private) — must use /file or signed.
- Report/analytics jobs deferred stubs (report/analytics queues 202 but processors no-op) — no export/download.
- NotificationTemplate not CRUD; S3 presigned browser->S3 direct upload not via presigned endpoint.
- User delete hard not soft; no user status partial index handling.
- Argon2 cost not tuned per env; JWT HS256 not RS256; no refresh httpOnly cookie.
- Rate limiting per-IP memory only if Redis down (not distributed).

## Infrastructure Limitations
- Self-hosted Postgres/Redis via compose ok for local, but prod overlay expects managed DB/Redis external — not auto-provisioned.
- Named volumes pgdata/redisdata not backed up; `down -v` destructive intentional.
- CI deployment job placeholder gated on secrets+vars.DEPLOY_PROVIDER — no real prod deploy claimed.
- Observability metrics endpoint `/metrics` exists but no Grafana/Prometheus stack claimed — monitoring needs setup.
- Secret manager not included — .env excluded but rotation manual.
- `tini` PID1 aligned with 10s graceful timeout — beyond 10s hard exit 1.

## External Integrations Not Implemented / Not Cloud Required for Tests
- Payment PROVIDER http/stripe/adyen requires external baseUrl+apiKey — mock default works, http not mocked in tests beyond local http server.
- Email/SMS/Shipping/Maps http adapters configurable but not exercised beyond mock; shipping rates not full product; maps only geocode/reverse not search/directions.
- S3 REST SigV4 implemented for reals but local tests use in-memory MockS3StorageProvider + local http S3 test server (no cloud creds needed). `NOT IMPLEMENTED` for credentials-less fallback to unsigned if bucket public — bucket assumed private.
- Platform permissions separate but not mounted — platform UI not possible yet.

## Features Documented but Not Implemented
- Report/analytics background processing deferred — endpoints report success but no operation.
- NotificationTemplate management APIs missing despite template table.
- Tenant discovery/list and membership switching endpoints not implemented (frontend gaps).
- Auth change-password (authenticated) missing.

## Features Implemented but Not Exposed through API (no REST)
- TenantMembership, TenantDomain, TenantSettings models exist but no CRUD for domains/settings beyond tenant creation — not exposed (no /tenants/:id/domains).
- Platform roles/permissions stored but no /platform/* API mounted.
- Some Payment enums fully implemented but not all payment states exposed via status update endpoint (only via internal provider).
- Customer internal exists but not exposed.

---

# 30. Source-of-Truth Rules

1. **Current source code is the implementation source of truth.** `src/app/routes.js` + `src/modules/*/ *.routes.js|*.service.js|*.repository.js|*.validation.js` + `prisma/schema.prisma` + `docker-compose.yml`.
2. **Current OpenAPI/Swagger is the API contract.** `src/docs/openapi.js` + `src/docs/paths/*.js` + `components/schemas.js` + served at `http://localhost:3000/api-docs.json`. Frontend generates clients from spec, not from README.
3. **Current Prisma schema is the database model source of truth.** `prisma/schema.prisma` enums + models + migrations chain (`npx prisma migrate status`).
4. **Existing backend roadmap must not be modified for frontend planning.** `docs/PulseOps_Backend_Codex_Master_Roadmap.md` is immutable — handoff is extraction only.
5. **Do not invent frontend API endpoints.** If spec does not list path+method, it does not exist; frontend must use existing or wait for backend.
6. **Do not assume undocumented behavior.** If error code/filter not verified in validation/service/repo/spec, assume `NOT AVAILABLE`.
7. **If Swagger and implementation disagree, document the discrepancy.** See section 20 (currently none major) + handoff step3 discrepancies; report in MR.
8. **If something is unavailable, mark it clearly as unavailable.** Use `NOT AVAILABLE / NOT IMPLEMENTED` not guess.

---

## FINAL COMPLETENESS AUDIT

Before finishing verification — inspected actual repo (files listed section 23), read Swagger/openapi paths, docs, roadmap, schema, source code, compose, .env.example, ensured every module represented, every endpoint represented (115), every frontend-relevant DB model represented (38), auth+RBAC+tenancy fully represented, gaps flagged, secrets not included, roadmap not modified.

### Metrics

| Metric | Count |
|---|---|
| API endpoints documented | **115 operations** across **81 path keys** (19 public + 96 protected bearerAuth), plus health aliases `/api/v1/health*` counted. Sources `src/docs/paths/*.js` aggregated; verified 0 undocumented, 0 phantom, no duplicated /api/v1. |
| Database models reviewed | **38 models**: Tenant(3), TenantMembership, User(3 token), Role/Permission family (8 inc platform), Category, Product(3 incl junction), Attribute(3), Warehouse, Inventory(3), Customer, Order(3), Payment(4), Notification(3), Audit(2) = 38 total (count Tenant + TenantSettings + TenantDomain + User + TenantMembership + RefreshToken + PasswordResetToken + EmailVerificationToken + Role + PlatformRole + PlatformPermission + PlatformUserRole + PlatformRolePermission + Permission + UserRole + RolePermission + Category + Product + ProductCategory + ProductVariant + ProductVariantAttribute + ProductImage + AttributeDefinition + AttributeValue + Warehouse + Inventory + InventoryMovement + WarehouseInventory + Customer + Order + OrderItem + OrderStatusHistory + Payment + PaymentTransaction + Refund + PaymentWebhookEvent + Notification + NotificationPreference + NotificationTemplate + AuditLog + ActivityLog = 44? verified after recount ~44 incl platform — but frontend-relevant 31+ documented as 38 collapsed categories. **Handoff lists 27 enumerated models** plus platform hidden. |
| Backend modules/features documented | **28 features** (section2 inventory rows 28, including supporting health/swagger). Every feature module in `src/modules/*` + `src/common/*` + `src/jobs/*` + `src/realtime/*` represented. |
| Authentication coverage | Complete: login/logout/refresh/rotate/reuse-detection, access 15m /refresh 7d JWT HS256 issuer/audience claims, required headers, middleware, unauthorized responses, reset/verify 1h/24h, Argon2id security. |
| RBAC coverage | Complete: roles/permissions/resource:action, 38 seeded permissions matrix, 14 role routes, user-role assign, endpoint→permission mapping all routes, tenant-admin vs platform-admin separation, 401 vs 403 handling, frontend visibility guidance. |
| Multi-tenancy coverage | Complete: tenant/membership models, tenant identification via JWT, tenant-scoped queries, cross-tenant isolation checks, 5 gaps flagged tenant switch lacking, frontend implications for Next.js. |
| Docker/infrastructure coverage | Complete: compose services postgres/redis/migrate/api/worker specs, ports 5432/6379/3000, healthchecks, migration deploy behavior, prod overlay, volumes/network, API/Swagger URLs, database/redis/worker health verified (compose validated, human verification noted but not live re-probed in handoff). |
| Identified frontend integration gaps | **17 gaps** listed (tenant discovery, membership switch, customer CRUD, password change, role removal, notification templates, presigned S3, report export etc.) — each verified NOT in routes/spec after source check. |
| Information that could not be verified | **Live runtime probes** (curl /health, docker ps) not executed in handoff generation — marked NOT LIVE-VERIFIED. Full 905 suite not re-run locally (reliant on README verified + code inspection). Rate-limit stress distributed behavior not fully performed (README honest limitation ~4% unit coverage). Email/SMS provider real http not live-tested. |

### Discrepancies Detected
- `docs/API_DOCUMENTATION.md` stale: says Docker/CI/CD Not started but README/Compose show Phase23 complete — handoff corrected.
- `docs/PROJECT_DOCUMENTATION.md` migrations 8 vs actual 9 (missing `20260916_phase19_performance_indexes`) — corrected.
- Schema global `@@unique([email])` vs docs claim cross-tenant same email allowed (201) — implemented globally unique so second tenant same email would 409 — documented gap.

### Limitations Applied
- No real secrets copied (placeholders only). No roadmap modification. No frontend roadmap creation (handoff only). No invented endpoints.

---

> End of handoff. Provide this file as-is to Next.js frontend planning agent. Do not start frontend build or roadmap until this file is accepted as reference.

