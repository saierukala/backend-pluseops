# Project Documentation

Technical architecture and implementation state as of Phase 09 completion (Order Management — COMPLETE and VERIFIED).

---

## Architecture

### Modular Monolith Structure

```
src/
├── app/
│   ├── app.js          # Express app factory
│   ├── server.js       # HTTP server, startup, graceful shutdown
│   └── routes.js       # API router composition
├── common/
│   ├── middleware/
│   │   ├── error-handler.js   # Global error handler
│   │   ├── not-found.js       # 404 handler
│   │   └── request-context.js # Request ID, tenant context foundation
│   ├── errors/
│   │   └── app-error.js       # AppError class
│   └── ...
├── config/
│   ├── env.js          # Zod-validated environment config
│   ├── database.js     # Prisma Client singleton, health check
│   ├── redis.js        # ioredis client, health check
│   └── logger.js       # Pino logger
└── modules/
    ├── health/         # Health check endpoints
    │   ├── health.controller.js
    │   └── health.routes.js
    ├── tenants/        # Tenant CRUD
    │   ├── tenants.controller.js
    │   ├── tenants.service.js
    │   ├── tenants.repository.js
    │   ├── tenants.validation.js
    │   └── tenants.routes.js
    ├── auth/           # Authentication
    │   ├── auth.controller.js
    │   ├── auth.service.js
    │   ├── auth.repository.js
    │   ├── auth.validation.js
    │   ├── auth.routes.js
    │   ├── auth.middleware.js
    │   ├── authorization.middleware.js
    │   ├── jwt.util.js
    │   ├── password.util.js
    │   └── token-expiry.util.js
    ├── roles/          # Role-based access control
    │   ├── roles.controller.js
    │   ├── roles.service.js
    │   ├── roles.repository.js
    │   ├── roles.validation.js
    │   └── roles.routes.js
    ├── permissions/    # Permission management
    │   ├── permissions.controller.js
    │   ├── permissions.service.js
    │   ├── permissions.repository.js
    │   ├── permissions.validation.js
    │   └── permissions.routes.js
    └── users/          # User management
        ├── users.controller.js
        ├── users.service.js
        ├── users.repository.js
        ├── users.validation.js
        └── users.routes.js
    ├── categories/     # Categories & hierarchy
    │   ├── categories.controller.js
    │   ├── categories.service.js
    │   ├── categories.repository.js
    │   ├── categories.validation.js
    │   └── categories.routes.js
    ├── products/       # Products & product/category relationships
    │   ├── products.controller.js
    │   ├── products.service.js
    │   ├── products.repository.js
    │   ├── products.validation.js
    │   └── products.routes.js
    ├── variants/       # Product variants (sellable SKUs)
    │   ├── variants.controller.js
    │   ├── variants.service.js
    │   ├── variants.repository.js
    │   ├── variants.validation.js
    │   └── variants.routes.js
    ├── attributes/     # Flexible attributes & values
    │   ├── attributes.controller.js
    │   ├── attributes.service.js
    │   ├── attributes.repository.js
    │   ├── attributes.validation.js
    │   └── attributes.routes.js
    ├── product-images/ # Product & variant images (local StorageService)
    │   ├── product-images.controller.js
    │   ├── product-images.service.js
    │   ├── product-images.repository.js
    │   ├── product-images.validation.js
    │   └── product-images.routes.js
    ├── warehouses/     # Warehouse management (supporting inventory)
    │   ├── warehouses.controller.js
    │   ├── warehouses.service.js
    │   ├── warehouses.repository.js
    │   ├── warehouses.validation.js
    │   └── warehouses.routes.js
    ├── inventory/      # Inventory management (Phase 08)
    │   ├── inventory.controller.js
    │   ├── inventory.service.js
    │   ├── inventory.repository.js
    │   ├── inventory.validation.js
    │   └── inventory.routes.js
    ├── orders/         # Order lifecycle management (Phase 09)
    │   ├── orders.controller.js
    │   ├── orders.service.js
    │   ├── orders.repository.js
    │   ├── orders.validation.js
    │   └── orders.routes.js
    └── common/storage/ # Storage abstraction
        ├── storage.service.js
        └── local-storage.provider.js
```

### Layered Module Pattern

Each feature module follows:
```
Route → Controller → Service → Repository → Database
```

- **Controllers** — HTTP handling, response formatting, delegate to service
- **Services** — Business logic, validation, orchestration
- **Repositories** — Database access via Prisma Client
- **Validation** — Zod schemas for body/params/query

---

## Multi-tenancy

### Model
- **Shared PostgreSQL database + shared schema + `tenant_id` isolation**
- Every tenant-owned table has a required `tenant_id` column with foreign key to `tenants(id)` `ON DELETE CASCADE`
- `tenant_id` is a UUID (gen_random_uuid())

### Tenant Context
- Request context middleware provides `req.context.tenantId` (foundation)
- Phase 04 implements full tenant resolution from authenticated JWT context
- `authenticate()` middleware validates JWT, resolves user, verifies user/tenant active status, establishes `req.context.tenantId`
- `TenantService.canPerformOperations(tenant)` enforces `ACTIVE`/`TRIAL` status for operations
- Phase 05 adds `authorize(permission)` middleware: reads `userId`/`tenantId` from `req.context`, resolves user's roles in the authenticated tenant, checks if the requested `resource:action` permission exists through `user_roles` → `roles` → `role_permissions` → `permissions`, all tenant-scoped

### Important
- **Authentication IS implemented** — JWT access tokens, refresh tokens, rotation, revocation
- `tenant_id` must never be trusted from client-controlled requests
- Cross-tenant isolation at database level uses unique constraints and foreign keys; composite foreign keys for tenant-scoped relationships are a documented deferred consideration (see below)

---

## Database

### PostgreSQL
- Provider: `postgresql` (Prisma datasource)
- Version: 16+ recommended
- Schema: `public`

### Prisma ORM
- Version: 6.19.3
- Client generated to `node_modules/@prisma/client`
- Migration-based workflow

### Timestamp Strategy
- **All timestamps use `TIMESTAMPTZ(6)`** (timestamp with time zone, microsecond precision)
- Prisma schema: `@db.Timestamptz(6)` on all `createdAt`, `updatedAt`, `deletedAt`, `lastLoginAt`, `readAt`, `created_at` columns
- Stored as UTC in database
- Correction migration `20250911_phase_03_fix_timestamptz` converted 89 columns from `TIMESTAMP(3)` to `TIMESTAMPTZ(6)`

### Decimal Money Fields
- All monetary values use `Decimal @db.Decimal(12, 2)`
- Never Float/Double
- Applied to: `price`, `cost_price`, `base_price`, `amount`, `subtotal`, `discount_total`, `tax_total`, `shipping_total`, `total`, `unit_price`, `discount`, `tax`, `line_total`

### Relational Schema
- 34 total models (3 Phase 02 + 31 Phase 03)
- UUID primary keys (`@id @default(uuid())`)
- Native PostgreSQL enums for status/type fields
- JSONB for flexible payloads (`metadata`, `variables`, `attribute_snapshot`, `old_value`, `new_value`)
- Explicit `onDelete`/`onUpdate` on all relations (CASCADE, RESTRICT, SET NULL)

### Migrations
**Migration Chain (verified — 7 migrations):**
```
20250911_init_tenants                         # Phase 02: tenants, tenant_settings, tenant_domains
        ↓
20250911_phase_03_core_schema                 # Phase 03: 31 models (including warehouses, inventory, inventory_movements, warehouse_inventory)
        ↓
20250911_phase_03_fix_timestamptz             # Correction: 89 timestamp columns to TIMESTAMPTZ(6)
        ↓
20250911_phase_04_authentication              # Phase 04: refresh_tokens, password_reset_tokens, email_verification_tokens, User.emailVerified
        ↓
20260912_phase_05_platform_rbac_foundation    # Phase 05: tenant_memberships, platform_roles, platform_permissions, platform_user_roles, platform_role_permissions, Role, Permission, UserRole, RolePermission
        ↓
20260913_phase_07_attribute_description       # Phase 07: attribute_definitions.description (TEXT, nullable)
        ↓
20260914_phase_08_inventory_management        # Phase 08: non-negative CHECKs on inventory/warehouse_inventory + movement consistency; reuses Phase 03 tables (no new tables)
```

- Phase 03 migration does **not** recreate Phase 02 tables
- Phase 04 migration adds 4 tables WITHOUT recreating Phase 02/03 tables
- Phase 05 migration adds 9 tables (tenant_memberships + platform* + RBAC tables) WITHOUT recreating Phase 01-04 tables
- Phase 07 migration adds `attribute_definitions.description` via `ADD COLUMN IF NOT EXISTS` (fixes prior `prisma db push` gap, no duplicate tables)
- Phase 08 migration adds DB-level guards only: `inventory_quantity_non_negative`, `inventory_reserved_quantity_non_negative`, `warehouse_inventory_quantity_non_negative`, `warehouse_inventory_reserved_quantity_non_negative`, `inventory_movements_quantity_consistency`; warehouses/inventory tables reused from Phase 03 (not recreated)
- All 7 migrations applied, `npx prisma migrate status` reports "Database schema is up to date!"
- `npx prisma validate` → valid 🚀
- No `prisma migrate reset` or destructive operations used

---

## Seed

### File
`prisma/seed.js`

### Command
```bash
npm run db:seed
```

### Behavior
1. Finds all non-CANCELLED tenants
2. If none exist, creates a default "Development" tenant (slug: `development`, status: `ACTIVE`)
3. For each tenant, upserts:
   - 36 system permissions (resource:action format)
   - 3 roles: `admin`, `manager`, `member`
   - Role-permission links (admin=36, manager=32, member=10 = 78 total)
   - Platform permissions: `platform:tenant:create`, `platform:tenant:read`, `platform:tenant:update`, `platform:tenant:suspend`, `platform:billing:read`, `platform:billing:update`
   - Platform role: `platform_admin` with all platform permissions

### Idempotency
- Uses `upsert` with composite unique constraints
- Safe to run repeatedly — second run creates zero duplicates
- Verified: unique role names ✅, unique permissions ✅, FK tenantIds match ✅

### Scope
- **Minimal foundational RBAC data only**
- No fake products, orders, customers, inventory, payments
- No authentication implementation

### Required Permission Names (Roadmap-Compliant)
```
product:create, product:read, product:update, product:delete
order:create, order:read, order:update, order:cancel
inventory:read, inventory:update
```

Plus additional permissions: tenant, user, role, permission, category, customer, warehouse.

---

## Authentication (Phase 04)

### Overview
Phase 04 implements secure authentication with JWT access tokens, refresh token rotation, password reset, and email verification.

### JWT Design
- **Algorithm:** HS256 (HMAC SHA-256)
- **Access Token:** 15 min, claims `{sub, tenantId, sessionId, email}`, issuer `pulseops`, audience `pulseops-api`
- **Refresh Token:** 7 days, stored as SHA-256 hash in DB, rotated on each use
- **Secrets:** `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` (min 32 chars, required in production)
- **Claims:** `iss: pulseops`, `aud: pulseops-api`

### Refresh Token Security
- **Never stored plaintext** — only SHA-256 hash in DB
- **Expiration enforced** — 7 days, checked on each refresh
- **Revocation enforced** — `revoked_at` timestamp, checked on each use
- **Rotation** — old token revoked, new token issued on each refresh
- **Reuse detection** — revoked token reuse triggers revocation of ALL user tokens
- **Transaction-safe rotation** — revoke old + create new in single Prisma transaction
- **Tenant-scoped** — tokens include `tenant_id`, cannot cross tenant boundaries

### Password Security
- **Argon2id** — memoryCost=19456, timeCost=2, parallelism=1
- Min 8 chars, requires uppercase, lowercase, number, special char
- Never logged or returned in responses

### Password Reset
- Secure token (32 bytes crypto.randomBytes, SHA-256 hash stored)
- 1-hour expiry, enforced
- Single-use (`used_at` timestamp)
- Revokes all refresh tokens on successful reset
- Account enumeration protection (always returns success message)

### Email Verification
- Secure token (32 bytes, SHA-256 hash stored)
- 24-hour expiry, single-use
- Sets `emailVerified=true` on user
- Dev token logged to console (no email provider in Phase 04)

### Auth Middleware
`authenticate()` middleware:
1. Extracts Bearer token from Authorization header
2. Verifies JWT signature, expiry, issuer, audience
3. Validates required claims: `sub`, `tenantId`, `sessionId`
4. Finds user by ID + tenantId from token
5. Verifies user exists, is ACTIVE, and tenant is ACTIVE/TRIAL
6. Sets `req.context` with `userId`, `tenantId`, `sessionId`, `email`

---

## Seed

### File
`prisma/seed.js`

### Command
```bash
npm run db:seed
```

### Behavior
1. Finds all non-CANCELLED tenants
2. If none exist, creates a default "Development" tenant (slug: `development`, status: `ACTIVE`)
3. For each tenant, upserts:
   - 36 system permissions (resource:action format)
   - 3 roles: `admin`, `manager`, `member`
   - Role-permission links (admin=36, manager=32, member=10 = 78 total)
   - Platform permissions: `platform:tenant:create`, `platform:tenant:read`, `platform:tenant:update`, `platform:tenant:suspend`, `platform:billing:read`, `platform:billing:update`
   - Platform role: `platform_admin` with all platform permissions

### Idempotency
- Uses `upsert` with composite unique constraints
- Safe to run repeatedly — second run creates zero duplicates
- Verified: unique role names ✅, unique permissions ✅, FK tenantIds match ✅

### Scope
- **Minimal foundational RBAC data only**
- No fake products, orders, customers, inventory, payments
- No authentication implementation

### Required Permission Names (Roadmap-Compliant)
```
product:create, product:read, product:update, product:delete
order:create, order:read, order:update, order:cancel
inventory:read, inventory:update
```

Plus additional permissions: tenant, user, role, permission, category, customer, warehouse.

---

## Testing

### Current Verification Results (Latest Run — Phase 09 Verified)

| Check | Result |
|-------|--------|
| **Full Integration Suite** | 337/337 passing (10 suites) |
| - `phase9-orders.test.js` | 34 tests ✅ |
| - `phase8-inventory.test.js` | 36 tests ✅ |
| - `phase7-product-management.test.js` | 78 tests ✅ |
| - `phase6-users.test.js` | 44 tests ✅ |
| - `auth.test.js` | 30 tests ✅ |
| - `phase3-schema.test.js` | 39 tests ✅ |
| - `tenants.test.js` | 11 tests ✅ |
| - `health.test.js` | 2 tests ✅ |
| - `request-boundaries.test.js` | 2 tests ✅ |
| - `phase5-rbac.test.js` | (covered via 5-suite subset) 54 tests ✅ |
| **ESLint** | 0 errors, 0 warnings |
| **Prisma Validate** | ✅ Valid |
| **Prisma Generate** | ✅ Success |
| **Migration Status** | ✅ Up to date (7 migrations) |
| **Phase 9 Migration** | No new migration — reused Phase 03 `orders`/`order_items`/`order_status_history` ✅ |
| **Regression** | Phase 1 PASS, Phase 2 PASS, Phase 3 PASS, Phase 4 PASS, Phase 5 PASS, Phase 6 PASS, Phase 7 PASS, Phase 8 PASS, Phase 9 PASS |

### Test Coverage Highlights
- Health endpoints: liveness, DB readiness, Redis readiness
- Tenant CRUD: create, get, update, delete, duplicate slug, validation, status enum
- Phase 03 schema: all 31 models create/read, unique constraints per tenant, cross-tenant isolation, Decimal types, TIMESTAMPTZ, soft delete, relationships
- Request boundaries: JSON size limit, malformed JSON, rate limit headers
- Phase 04 auth: 30 tests covering register, login, refresh, logout, forgot/reset password, verify email, me, cross-tenant isolation
- Phase 05 RBAC: 54 tests covering authorization middleware, role APIs, permission APIs, role-permission assignment, user-role assignment, tenant isolation, system role protection, multiple roles combining permissions, regression tests for Phases 01-04

---

## Operations

### Startup Behavior
1. Load and validate environment (Zod)
2. Attempt PostgreSQL connection (`connectDatabase`)
3. Attempt Redis connection (`connectRedis`)
4. If any required dependency fails and `FAIL_ON_DEPENDENCY_ERROR=true` (production default): throw and exit
5. If dependencies fail in dev/test: log warning, start in degraded mode (liveness OK, readiness 503)
6. Start HTTP server on `HOST:PORT`
7. Log startup info (non-production)

### Health Checks
| Endpoint | Dependency | Healthy Response | Unhealthy Response |
|----------|------------|------------------|-------------------|
| `/health` | None | 200 `{status: "ok"}` | N/A (process dead) |
| `/health/db` | PostgreSQL | 200 `{status: "up"}` | 503 `{status: "down"}` |
| `/health/redis` | Redis | 200 `{status: "up"}` | 503 `{status: "down"}` |

### Graceful Shutdown
- Signals: `SIGTERM`, `SIGINT`
- Stops accepting connections
- Closes Redis, then Prisma
- Logs completion
- Force exit after 10 seconds

### Dependency Failure Behavior
- Production (`NODE_ENV=production`): `FAIL_ON_DEPENDENCY_ERROR=true` by default — fails fast
- Development/Test: `FAIL_ON_DEPENDENCY_ERROR=false` — starts degraded, readiness returns 503
- Override via `FAIL_ON_DEPENDENCY_ERROR` env var

---

## Security Foundation

### Implemented
- **Helmet** — security headers (CSP, HSTS, X-Frame-Options, etc.)
- **CORS** — configurable allow-list (`CORS_ORIGINS`), credentials support
- **Rate Limiting** — sliding window, configurable (`RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`), applies globally to all `/api/v1/*` routes including all 8 auth endpoints
- **HPP** — HTTP Parameter Pollution protection
- **Compression** — response compression
- **JSON Body Limits** — configurable (`REQUEST_BODY_LIMIT`, default 1mb)
- **Request IDs** — generated or client-supplied, included in errors
- **Structured Logging** — Pino JSON, no sensitive data in logs
- **Centralized Errors** — consistent format, no stack traces in production responses
- **Zod Validation** — all inputs validated at route level
- **Prisma Parameterized Queries** — SQL injection prevention via ORM
- **JWT Authentication** — HS256, access/refresh tokens, rotation, revocation
- **Password Hashing** — Argon2id
- **Password Reset** — secure tokens, 1h expiry, single-use, revokes refresh tokens
- **Email Verification** — secure tokens, 24h expiry, single-use

### NOT Implemented (Future Phases)
- CSRF Protection
- Secure Cookies
- File Upload Validation
- Webhook Signature Verification

---

## Deferred Considerations (Documented from Phase 03 Audit)

The following items were identified during the Phase 03 human verification audit as **known limitations** that were deliberately deferred to future phases. They are **NOT completed features**.

### 1. Composite Tenant-Scoped Foreign Keys
- **Current state:** All foreign keys are simple (single-column) references to parent `id`
- **Limitation:** Cross-tenant references are possible at database level (e.g., a `product_category` in Tenant A could reference a `category` in Tenant B)
- **Mitigation:** Application-layer enforcement required; Prisma/PostgreSQL supports composite FKs but would require `@@unique([tenantId, id])` on parents and composite `@relation` on children
- **Target phase:** Phase 05 if stricter DB-level isolation required

### 2. Partial Indexes for Soft-Delete Uniqueness
- **Current state:** Unique indexes are full (e.g., `UNIQUE(tenant_id, email)` on `users`)
- **Limitation:** Soft-deleted records block reuse of unique values (email, SKU, slug, etc.)
- **Mitigation:** Application-layer check before insert; Prisma does not natively support partial indexes (`WHERE deleted_at IS NULL`)
- **Target phase:** Future, if business requirement demands unique value reuse after soft delete

### 3. Order Status History Cascade Behavior
- **Current state:** `order_status_history` has `ON DELETE CASCADE` from `orders`
- **Limitation:** Deleting an order removes its status history (audit trail loss)
- **Mitigation:** Order deletion is rare admin action; `orders` has `ON DELETE RESTRICT` from `customers` so cascade only triggers on explicit order delete
- **Target phase:** Review during Phase 09 (Order Management) or Phase 11 (Audit)

### 4. Refresh Token Rotation Transaction Safety
- **Current state:** Implemented using Prisma `$transaction` — revoke old + create new atomically
- **Limitation:** If DB fails between revoke and create, transaction rolls back
- **Status:** Implemented in Phase 04 with Prisma `$transaction`

---

## Summary of Implementation Status

| Area | Status |
|------|--------|
| Project Foundation (Phase 01) | ✅ Complete & Verified |
| Multi-Tenant Foundation (Phase 02) | ✅ Complete & Verified |
| Database Schema & Migrations (Phase 03) | ✅ Complete & Verified |
| Authentication (Phase 04) | ✅ Complete & Verified |
| Authorization / RBAC (Phase 05) | ✅ Complete & Verified |
| User Management (Phase 06) | ✅ Complete & Verified |
| Product Management (Phase 07) | ✅ Complete & Verified (78/78, 267/267, 6 migrations) |
| Inventory Management (Phase 08) | ✅ Complete & Verified (36/36, 303/303, 7 migrations) |
| Order Management (Phase 09) | ✅ Complete & Verified (34/34, 337/337, 7 migrations — no new migration) |
| Payment & Transaction Processing (Phase 10) | ⏳ Not Started (NEXT) |
| Audit (Phase 11) | ⏳ Not Started |
| Notifications (Phase 12) | ⏳ Not Started |
| WebSockets (Phase 13) | ⏳ Not Started |
| Redis Caching (Phase 14) | ⏳ Not Started |
| BullMQ (Phase 15) | ⏳ Not Started |
| External Integrations (Phase 16) | ⏳ Not Started |
| API Orchestration (Phase 17) | ⏳ Not Started |
| Analytics (Phase 18) | ⏳ Not Started |
| Performance (Phase 19) | ⏳ Not Started |
| Security Hardening (Phase 20) | ⏳ Not Started |
| Complete Testing (Phase 21) | ⏳ Not Started |
| Swagger/OpenAPI (Phase 22) | ⏳ Not Started |
| Docker/CI/CD (Phase 23) | ⏳ Not Started |

---

## Phase 05 Status: ✅ COMPLETE AND VERIFIED

All 450: 
451: 145 tests pass, lint clean, Prisma validation passes, migrations up to date, no regressions.
452: 
453: ---
454: 
455: ## Phase 06 — User Management
456: 
457: ### Overview
458: Phase 06 implements tenant-scoped user administration with full CRUD operations, building on the Phase 04 authentication and Phase 05 authorization foundations.
459: 
460: ### User Management APIs
461: 
462: | Method | Endpoint | Permission Required | Description |
463: |--------|----------|---------------------|-------------|
464: | GET | `/api/v1/users` | `user:read` | List users (tenant-scoped, paginated, search, filter, sort) |
465: | GET | `/api/v1/users/:id` | `user:read` | Get user by ID (tenant-scoped) |
466: | PATCH | `/api/v1/users/:id` | `user:update` | Update user (firstName, lastName, status only) |
467: | DELETE | `/api/v1/users/:id` | `user:delete` | Delete user (self-deletion prevented) |
468: 
469: ### Features
470: 
471: #### Listing with Pagination, Search, Filtering, Sorting
472: - **Pagination:** `page` (default 1), `limit` (default 20, max 100)
473: - **Search:** `search` parameter queries email, firstName, lastName (case-insensitive)
474: - **Status filtering:** `status` parameter (ACTIVE, INACTIVE, SUSPENDED)
475: - **Role filtering:** `roleId` parameter filters users by assigned role
476: - **Sorting:** `sortBy` (createdAt, updatedAt, email, firstName, lastName, status) with `sortOrder` (asc, desc)
477: - **Response:** Standard pagination metadata (`page`, `limit`, `total`, `totalPages`)
478: 
479: #### Single User Retrieval
480: - Returns user with roles (id, name, isSystem)
481: - **Never exposes:** `passwordHash`, `refreshToken`, `passwordResetToken`, `emailVerificationToken`, or any authentication secrets
482: - 404 if user not found in authenticated tenant
483: 
484: #### User Update (Explicit Allowlist)
485: - **Allowed fields:** `firstName`, `lastName`, `status`
486: - **Explicitly rejected (400):**
487:   - `email` → `EMAIL_MODIFICATION_FORBIDDEN`
488:   - `passwordHash` → `PASSWORD_MODIFICATION_FORBIDDEN`
489:   - `tenantId` → `TENANT_MODIFICATION_FORBIDDEN`
490: - `roleIds` is not an allowed field and is silently ignored (roles managed via `/users/:id/roles` endpoint)
491: - `status` validated against enum (ACTIVE, INACTIVE, SUSPENDED)
492: 
493: #### User Deletion
494: - Hard delete via Prisma (no soft delete in Phase 06)
495: - **Self-deletion prevented:** 400 `SELF_DELETION_FORBIDDEN`
496: - 404 if user not found in authenticated tenant
497: 
498: ### Tenant Isolation
499: - All queries scoped by `memberships: { some: { tenantId, status: 'ACTIVE' } }` using `req.context.tenantId` from authenticated JWT
500: - **Never trusts** client-supplied `tenantId`
501: - Cross-tenant GET/UPDATE/DELETE returns 404 `USER_NOT_FOUND`
502: - Search/filtering cannot escape authenticated tenant scope
503: - JWT with manipulated `tenantId` claim fails authentication (401 `USER_NOT_FOUND` or `INVALID_TOKEN`)
504: 
505: ### Authorization
506: - Reuses Phase 05 RBAC permissions via existing `authorize()` middleware:
507:   - `user:read` for GET endpoints
508:   - `user:update` for PATCH endpoint
509:   - `user:delete` for DELETE endpoint
510: - **No new authorization architecture or permissions created**
511: - Permissions `user:read`, `user:update`, `user:delete` existed in Phase 05 seed
512: - Role assignment (seeded):
513:   - `admin`: all user permissions
514:   - `manager`: user:read, user:update (no user:delete)
515:   - `member`: user:read only
516: 
517: ### Privilege Escalation Protection
518: - Explicit allowlist prevents modification of privileged fields
519: - `roleIds` cannot modify roles through user update endpoint
520: - Self-deletion prevented
521: - Platform permissions remain separate via `authorizePlatform()`
522: 
523: ### Module Structure
524: ```
525: users/
526: ├── users.controller.js    # HTTP handlers, response formatting
527: ├── users.service.js       # Business logic, allowlist, privilege protection
528: ├── users.repository.js    # Database queries with tenant scoping
529: ├── users.validation.js    # Zod schemas for query/params/body
530: └── users.routes.js        # Route registration with authorize()
531: ```
532: 
533: ### Verification Results
534: 
535: | Check | Result |
536: |-------|--------|
537: | **Phase 06 Integration Tests** | 44/44 passing |
538: | **Full Integration Suite** | 189/189 passing |
539: | **ESLint** | 0 errors |
539: | **Prisma Validate** | ✅ Valid |
541: | **Migration Status** | ✅ Up to date (5 migrations, no Phase 06 schema changes) |
542: | **Application Startup** | ✅ Verified |
543: 
544: ### Phase 06 Test Coverage
545: - **GET /users:** 11 tests (auth, pagination, search, filter, sort, status, roleId, tenant isolation)
546: - **GET /users/:id:** 7 tests (valid, 404, cross-tenant, sensitive fields, authz)
547: - **PATCH /users/:id:** 11 tests (valid fields, invalid status, forbidden fields, cross-tenant, authz)
548: - **DELETE /users/:id:** 6 tests (valid, self-delete prevention, cross-tenant, 404, authz)
549: - **Privilege Escalation:** 3 tests (role manipulation, tenant escalation via JWT)
550: - **Tenant Isolation:** 5 tests (all cross-tenant operations blocked)
551: - **Response Structure:** 2 tests (list and single user format)
552: 
553: ### Database
554: - **No schema changes required for Phase 06**
555: - Existing Prisma schema supports all operations via User, UserRole, TenantMembership, Role models
556: - 5 existing migrations remain valid and applied
557: 
558: ---
559: 
560: ## Phase 06 Status: ✅ COMPLETE AND VERIFIED
561: 
562: All 189 tests pass, lint clean, Prisma validation passes, migrations up to date, no regressions.
563: 
564: Phase 06 implemented and verified:
565: - Tenant-scoped user CRUD with pagination, search, filter, sort
566: - Status filtering (ACTIVE/INACTIVE/SUSPENDED) and role filtering
567: - Sensitive field protection (passwordHash, refreshToken, etc. never exposed)
568: - Privilege escalation prevention (email, passwordHash, tenantId, roleIds rejected)
569: - Cross-tenant isolation enforced at all levels
570: - Self-deletion prevention
571: - Authorization via existing Phase 05 RBAC permissions
572: - No new schema changes required
573: - No Phase 1-5 regressions---

## Phase 07 — Product Management

### Objective
Implement a business-agnostic product catalog supporting products, categories, variants, SKUs, flexible attributes, and multiple images. Variants are the sellable unit (unique SKU per tenant). Generic attributes (not industry-specific columns) allow clothing/electronics/cosmetics etc. as examples without schema changes.

### Architecture
Route → Controller → Service → Repository → Database
- **Route** — Express Router, authenticate(), authorize(permission), validate(Zod), multer for images
- **Controller** — HTTP handling, req.context.tenantId from auth, delegates to service, standard {success,data,message} / {success,error,requestId}
- **Service** — Business logic, tenant-scoped checks, AppError (404/403/409/400), StorageService delegation
- **Repository** — Prisma tenant-scoped queries (where:{id,tenantId}), pagination, filtering, transactions
- **Validation** — Zod schemas for body/params/query (regex for slugs/codes, Decimal price, enum status)

### Tenant Isolation
- Every product-domain operation is tenant scoped: where:{id,tenantId} or where:{productId,tenantId} or where:{tenantId}.
- tenant_id comes from authenticated JWT context (req.context.tenantId via authenticate()), never from client body/query/params.
- Cross-tenant resources return 404 (PRODUCT_NOT_FOUND, CATEGORY_NOT_FOUND, VARIANT_NOT_FOUND, ATTRIBUTE_NOT_FOUND, IMAGE_NOT_FOUND).
- Authorization after authentication: authorize('product:create'|'product:read'|'product:update'|'product:delete'|'category:*'|'attribute:*') checks user_roles→roles→role_permissions→permissions tenant-scoped.
- Product-image PATCH/DELETE also verify image.productId === productId (product ownership) else 404.

### Product Model
Product
 ├─ Categories (product_categories, isPrimary)
 ├─ Product Images (variantId null, storageKey tenant-scoped)
 └─ Product Variants (sellable unit)
     ├─ SKU (unique per tenant, 409 SKU_EXISTS)
     ├─ barcode (unique per tenant, 409 BARCODE_EXISTS, nullable)
     ├─ price / costPrice (Decimal 12,2)
     ├─ status (ACTIVE/INACTIVE/DRAFT)
     ├─ Attributes (product_variant_attributes → attribute_definitions)
     └─ Variant Images (variantId set, storageKey tenants/{t}/products/{p}/variants/{v}/{file})
- Attribute definitions: name, code (unique per tenant, regex ^[a-z0-9_-]+$), dataType (TEXT/NUMBER/BOOLEAN/OPTION), isRequired, description (Phase 07 added, nullable TEXT)
- Attribute values: value, displayName, sortOrder, isActive, unique on (tenantId, attributeDefinitionId, value)

### APIs — Products
POST /api/v1/products (product:create) | GET /api/v1/products (product:read, paginated, search, filters) | GET /api/v1/products/:id | PATCH /api/v1/products/:id | DELETE /api/v1/products/:id | POST/GET /api/v1/products/:productId/categories

### APIs — Categories
POST /api/v1/categories | GET /api/v1/categories | GET /api/v1/categories/:id | PATCH /api/v1/categories/:id (cycle check) | DELETE /api/v1/categories/:id (hasChildren guard)

### APIs — Variants
POST /api/v1/products/:productId/variants | GET /api/v1/products/:productId/variants | GET /api/v1/products/:productId/variants/:variantId | PATCH /api/v1/products/:productId/variants/:variantId | DELETE /api/v1/products/:productId/variants/:variantId | PUT/GET /api/v1/products/:productId/variants/:variantId/attributes

### APIs — Product Images (Local StorageService)
POST /api/v1/products/:productId/images (product:update, multer 10MB, server key tenants/{tenantId}/products/{productId}/{sanitizedFilename}) | GET /api/v1/products/:productId/images | GET /api/v1/products/:productId/images/:imageId (tenant+product check) | PATCH /api/v1/products/:productId/images/:imageId (product:update, only altText/sortOrder/isPrimary) | DELETE /api/v1/products/:productId/images/:imageId (product:delete, DB + local storage, traversal protected)

### APIs — Variant Images
POST /api/v1/products/:productId/variants/:variantId/images | GET /api/v1/products/:productId/variants/:variantId/images

### APIs — Attributes
POST /api/v1/attributes | GET /api/v1/attributes | PATCH /api/v1/attributes/:id | DELETE /api/v1/attributes/:id | POST/GET/PATCH/DELETE /api/v1/attributes/:attributeId/values

### Storage
Product/Variant Images ↓ StorageService (generateProductImageKey/generateVariantImageKey, sanitizeFilename, validateImageFile) ↓ LocalStorageProvider (basePath ./storage, traversal check). Phase 7 local only, S3 deferred to Phase 16. Keys tenants/{tenantId}/products/{productId}/{filename} and tenants/{tenantId}/products/{productId}/variants/{variantId}/{filename}. Server-generated, client cannot supply path. DB stores storageKey+metadata, bytes on filesystem. Delete removes row + file.

### Filtering
GET /api/v1/products? page,limit,search(name/description/brand),status,categoryId,minPrice/maxPrice,sku,barcode,attribute[code]=value (tenant-scoped AND),sortBy,sortOrder. SKU/barcode tenant-scoped.

### Security
Authentication required (401), RBAC product:*, tenant isolation 404, server-derived tenantId, Zod validation, storage sanitization, PATCH cannot alter storageKey/tenantId, image auth PATCH→product:update DELETE→product:delete, productId ownership.

### Tests
tests/integration/phase7-product-management.test.js 78 tests: CRUD, validation, hierarchy, duplicates 409, search/category/status/price/sku/barcode/attribute filtering, pagination, ownership, RBAC 403, auth 401, tenant isolation 404, manipulated JWT, image PATCH/DELETE 200/401/403/404, DB+storage consistency, tenant-scoped keys. Regression Phase 1-6 PASS.

### Database
Only change: attribute_definitions.description TEXT nullable. Migration 20260913_phase_07_attribute_description (ADD COLUMN IF NOT EXISTS). Now superseded by Phase 08 migration chain — see Phase 08.

---

## Phase 07 Status: ✅ COMPLETE AND VERIFIED
All 267 tests pass (78 Phase 07), lint 0, Prisma valid, 6 migrations up to date (7 after Phase 08), app starts PostgreSQL+Redis, storage tenant-scoped, image PATCH/DELETE verified 200/404/403/401, no regressions, roadmap untouched.

---

## Phase 08 — Inventory Management

### Objective
Implement inventory tracking and movement history at the sellable variant/SKU level (`product_variant_id`), never `product_id`. Architecture: `Product → Variant/SKU → Warehouse Inventory`. Supports roadmap example `UTS-BLK-S/B/L/W` across Hyderabad/Bangalore (and any business-agnostic product via generic Phase 7 variants).

### Architecture / Module Structure
```
Route → Controller → Service → Repository → Database
warehouses/  # Warehouse management (supporting inventory)
  warehouses.controller.js, warehouses.service.js, warehouses.repository.js, warehouses.validation.js, warehouses.routes.js
inventory/   # Inventory management
  inventory.controller.js, inventory.service.js, inventory.repository.js, inventory.validation.js, inventory.routes.js
```
Routes mounted in `src/app/routes.js` as `/api/v1/warehouses` and `/api/v1/inventory` behind `authenticate()`.

### Responsibilities
* **Warehouses** — tenant-scoped CRUD (`name`, `code` unique per tenant, `address`/`city`/`state`/`country`/`postalCode`, `isActive`, `isDefault`). Used as inventory dimension.
* **Inventory** — quantities at `tenant_id + product_variant_id + warehouse_id` (`inventory` canonical + `warehouse_inventory` mirror from Phase 03). No product-level stock.

### Variant/SKU-Level Model
`inventory.tenant_id, product_variant_id, warehouse_id, quantity` — `@@unique([tenantId, productVariantId, warehouseId])`. Independent stocks: `SKU A + Warehouse 1` vs `SKU A + Warehouse 2` vs `SKU B + Warehouse 1`. Verified.

### Warehouse-Specific Quantities
One row per variant per warehouse per tenant. `GET /api/v1/inventory/variants/:variantId` returns array of warehouses with quantities.

### Inventory Adjustment (`POST /api/v1/inventory/adjust`)
Body: `variantId` (or `productVariantId`), `warehouseId`, `quantityChanged` (non-zero int), `reason`, optional `referenceType`/`referenceId`. Positive and negative supported. Validates variant+warehouse tenant ownership (404), rejects zero (400), rejects insufficient stock (400 `INSUFFICIENT_STOCK`) without side effects, creates one `ADJUSTMENT` movement.

### Inventory Transfer (`POST /api/v1/inventory/transfer`)
Body: `variantId`, `sourceWarehouseId`, `destinationWarehouseId`, `quantity` (positive int), optional `reason`/`referenceType`/`referenceId`. Validates variant+warehouses tenant ownership, rejects same warehouse (400 `SAME_WAREHOUSE`), validates positive quantity, verifies source sufficient stock, then atomically decrements source and increments dest, creates two `TRANSFER` movements (`-quantity` and `+quantity`) sharing same `referenceId`. All or nothing via transaction.

### Movement History (`GET /api/v1/inventory/movements`)
Tenant-scoped, paginated, filters `variantId/productVariantId`, `warehouseId`, `type`, `reason`. Returns `tenant_id, product_variant_id, warehouse_id, quantity_before, quantity_changed, quantity_after, reason, reference_type, reference_id, created_by, created_at`. Invariant `quantity_after = quantity_before + quantity_changed` verified per movement and enforced by DB CHECK.

### Transaction Handling
Both `adjust` and `transfer` use `prisma.$transaction(async(tx)=>{ SELECT ... FOR UPDATE ... UPDATE/INSERT ... create movement(s) })` with retry (up to 3 attempts, exponential 50ms) for serialization/deadlock (`P2010` / `40001` / `40P01`). Transfer locks in sorted warehouseId order to avoid deadlock.

### PostgreSQL Row Locking / Concurrency Protection
Option A from roadmap: `SELECT ... FOR UPDATE` via `tx.$queryRaw`. Prevents unsafe read-then-write. Concurrency test: 5 stock + 10 parallel `-1` → 5 succeed, 5 fail `INSUFFICIENT_STOCK`, final 0, never negative. Serializable retry guarantees no `could not serialize access` leak as 500.

### Non-Negative Enforcement
Service validates `after <0` → 400, plus DB CHECKs added in `20260914_phase_08_inventory_management`:
`inventory_quantity_non_negative`, `inventory_reserved_quantity_non_negative`, `warehouse_inventory_quantity_non_negative`, `warehouse_inventory_reserved_quantity_non_negative`, `inventory_movements_quantity_consistency`. Attempted `quantity=-1` rejected.

### Low-Stock (`GET /api/v1/inventory/low-stock`)
Deterministic: `quantity <= threshold` (threshold query param `threshold`, default 10, min 0, validated via Zod). Supports `warehouseId` filter and pagination, ordered by `quantity ASC`. Returns tenant-scoped rows. Example: threshold 10 returns 6,8,10 from seed.

### Tenant Isolation
All operations derive `tenantId` from `req.context` (authenticated JWT). Never trusts `tenantId` from body/query. Every Prisma query includes `tenantId`. Cross-tenant variant/warehouse/product access fails 404 `VARIANT_NOT_FOUND`/`WAREHOUSE_NOT_FOUND`. Movements/warehouses/variants/inventories isolated (verified both directions).

### Authorization
Reuses Phase 05 `authorize()`:
* `inventory:read` for `GET /inventory`, `GET /inventory/variants/:variantId`, `GET /inventory/movements`, `GET /inventory/low-stock`
* `inventory:update` for `POST /inventory/adjust`, `POST /inventory/transfer`
* `warehouse:create/read/update/delete` for warehouse CRUD
Unauthenticated 401, insufficient 403, tenant membership ACTIVE check.

### Validation
Zod schemas `inventory.validation.js`: `adjustInventorySchema`, `transferInventorySchema`, `listInventoryQuerySchema`, `variantInventoryParamsSchema`, `movementsQuerySchema`, `lowStockQuerySchema`. Rejects invalid UUIDs, zero quantity, same warehouse, negative transfer quantity, malformed types.

### APIs
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/v1/inventory` | inventory:read | List inventory (page/limit, warehouseId, variantId, sku, search) |
| GET | `/api/v1/inventory/variants/:variantId` | inventory:read | Variant inventory across warehouses |
| POST | `/api/v1/inventory/adjust` | inventory:update | Adjust stock |
| POST | `/api/v1/inventory/transfer` | inventory:update | Atomic transfer |
| GET | `/api/v1/inventory/movements` | inventory:read | Movement history |
| GET | `/api/v1/inventory/low-stock` | inventory:read | Low-stock (threshold) |
Warehouses supporting: `POST/GET /api/v1/warehouses`, `GET/PATCH/DELETE /api/v1/warehouses/:id` (warehouse:* permissions).

### Tests
`tests/integration/phase8-inventory.test.js` 36 tests: reads (list, variant, movements, low-stock), adjustments (positive/negative/insufficient/zero/tenant validation/movement math), transfers (success/insufficient/invalid warehouses/same warehouse/tenant ownership/movement creation), warehouse handling & SKU independence, authorization (read-only 403, unauth 401, authorized ok), tenant isolation (9 cases), concurrency (non-negative). Full suite 303/303.

### Migration
`20260914_phase_08_inventory_management` — adds CHECK constraints only; reuses Phase 03 `warehouses`, `inventory`, `warehouse_inventory`, `inventory_movements`. No new tables, no `prisma db push`.

### Known Limitations (as reported in Phase 8 evidence)
* Low-stock threshold via query param (default 10) not persisted per-inventory row; minimal mechanism per roadmap.
* `warehouse_inventory` kept as mirror of `inventory` for legacy compatibility (duplicate unique constraints).
* No Phase 09+ features (orders, payments, audit, notifications, websockets, caching, BullMQ, integrations).

---

## Phase 08 Status: ✅ COMPLETE AND VERIFIED
All 303 tests pass (36 Phase 08), 78 Phase 07, lint 0, Prisma valid, 7 migrations up to date, app starts, TENANT isolation verified both directions, RBAC inventory:read/update verified, concurrency 5/5 success final 0 no negative, movement `after=before+changed`, roadmap untouched.

---

## Phase 09 — Order Management

### Objective
Implement order lifecycle management integrated with existing authentication → tenant context → authorization → validation → controller → service → repository → PostgreSQL architecture. Tenant-aware, business-agnostic, variant/SKU-centric.

### Architecture / Module Structure
```
Route → Controller → Service → Repository → Database
orders/  # Order lifecycle management (Phase 09)
  orders.controller.js, orders.service.js, orders.repository.js, orders.validation.js, orders.routes.js
```
Routes mounted in `src/app/routes.js` as `/api/v1/orders` behind `authenticate()` and `authorize()`. No second inventory system; reuses Phase 8 inventory architecture via raw SQL within order transaction.

### Order Capabilities
* **Create orders** — variant/SKU + warehouse per item, server-side pricing, immutable snapshots, atomic inventory + history
* **List orders** — tenant-scoped pagination (`page`/`limit`), status filter, customerId filter, safe sorting (`createdAt`/`updatedAt`/`total`/`status`)
* **Retrieve order details** — order + items + customer + snapshots, tenant ownership, no cross-tenant leak
* **Update order status** — `PATCH /orders/:id/status` validates state machine, creates history
* **Cancel orders** — `POST /orders/:id/cancel` restores inventory atomically via `ORDER_RELEASE`, creates history
* **Retrieve order status history** — `GET /orders/:id/history` paginated, tenant-scoped, chronological

### Required APIs
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/v1/orders` | `order:create` | Create order (items with variant/SKU + warehouse, snapshots, atomic) |
| GET | `/api/v1/orders` | `order:read` | List orders (pagination, status, customerId) |
| GET | `/api/v1/orders/:id` | `order:read` | Get order with items and snapshots |
| PATCH | `/api/v1/orders/:id/status` | `order:update` | Update status (state-machine validated) |
| POST | `/api/v1/orders/:id/cancel` | `order:cancel` | Cancel (restores inventory) |
| GET | `/api/v1/orders/:id/history` | `order:read` | Status history |

### Authorization
Reuses Phase 05 RBAC:
* `order:create` for POST /orders
* `order:read` for GET list/detail/history
* `order:update` for PATCH status
* `order:cancel` for POST cancel
No `order:manage` invented. Unauthenticated 401, insufficient 403, tenant membership check.

### Order Items — Variant/SKU Reference
`order_items.product_variant_id` required, never `product_id`. Validates tenant-scoped variant exists and `status ACTIVE` else 404/400 `VARIANT_NOT_SELLABLE`. Client `productId` rejected 400 `productId is not allowed`. Cross-tenant variant 404.

### Historical Snapshots (Write-Once)
Per `order_items`:
* `product_name_snapshot` = product.name
* `variant_name_snapshot` = attribute-joined or sku
* `attribute_snapshot` JSON `{code: value}`
* `sku_snapshot` = variant.sku
* `unit_price` Decimal (authoritative variant.price)
* `quantity` Int, `discount` Decimal, `tax` Decimal, `line_total` Decimal
Snapshots preserve historical commercial information; later catalog price change does not alter stored snapshots (verified 100→999 stays 100). Atomic with order creation.

### Pricing — Server Authoritative, Decimal
No Float. All money `Decimal @db.Decimal(12,2)`. Totals calculated server-side: `unitCents = round(price*100)`, `line = unit*qty - discount + tax`, `subtotal = sum(unit*qty)`, `discountTotal = sum(discount)`, `taxTotal = sum(tax)`, `total = subtotal - discountTotal + taxTotal + shipping`. Client `unitPrice`/`total`/`subtotal` stripped/ignored (verified `unitPrice 1.00` → 100.00 used).

### Inventory Integration (Reuses Phase 8)
No second inventory system. Within order transaction: sorted `SELECT ... FOR UPDATE` on `inventory` rows (variant+warehouse), validate `available >= requested` else 400 `INSUFFICIENT_STOCK`, `UPDATE quantity = after`, `INSERT ... ON CONFLICT` for `warehouse_inventory` mirror, create `inventory_movements` type `ORDER_RESERVATION` (`quantity_before`/`quantity_changed` negative/`quantity_after`, `reason ORDER_CREATED`, `referenceType ORDER`, `referenceId order.id`, `createdBy` userId). Tenant isolated, non-negative guaranteed via lock + CHECK.

### Transactions — Atomic
`prisma.$transaction` wraps: inventory locks/validation/deduct, order create, items create, movements, history (null→PENDING). Failure → rollback everything (verified no orphan order/movement/history, inventory unchanged). Retry up to 3 for serialization/deadlock (`P2010`/`40001`/`40P01`) with exponential backoff.

### Concurrency — SELECT ... FOR UPDATE
Same Phase 8 strategy: deterministic sorted locks. Test: inventory 5, 10 concurrent orders qty1 → exactly 5 succeed 201, 5 fail 400 `INSUFFICIENT_STOCK`, final 0 never negative, 5 reservations, 5 orders, no duplicates, movement math `after = before + changed`.

### Cancellation
Supported cancellable states: `DRAFT`, `PENDING`, `CONFIRMED`, `PROCESSING`. Rejects SHIPPED/DELIVERED/CANCELLED/REFUNDED → 400 `CANCELLATION_NOT_ALLOWED`, double cancel → 400. Restores atomically: lookup `ORDER_RESERVATION` movements by `referenceId orderId`, for each `SELECT FOR UPDATE`, `UPDATE quantity = before+restoreQty`, mirror `warehouse_inventory`, create `ORDER_RELEASE` movement (`quantityChanged` positive, `reason` or `ORDER_CANCELLED`), update status CANCELLED, create history. Verified 18→20 restoration, double movement count 1→2.

### Status State Machine
```
DRAFT → PENDING, CANCELLED
PENDING → CONFIRMED, CANCELLED
CONFIRMED → PROCESSING, CANCELLED
PROCESSING → SHIPPED, CANCELLED
SHIPPED → DELIVERED
DELIVERED → REFUNDED, PARTIALLY_REFUNDED
CANCELLED / REFUNDED → terminal (no outgoing)
```
Initial status `PENDING` (history null→PENDING). `PATCH /orders/:id/status` validates `isValidTransition`, else 400 `INVALID_STATUS_TRANSITION`. Prevents same-status and terminal transitions.

### Status History
Creation and every status change/cancel recorded in `order_status_history` with `fromStatus` nullable, `toStatus`, `reason`, `createdBy`. `GET /orders/:id/history` returns tenant-scoped chronological ASC paginated. Verified PENDING→CONFIRMED history.

### Tenant Isolation
Tenant context from `req.context.tenantId` (JWT), never trust body/query `tenantId`. All queries `where:{tenantId,...}` for orders, items, history, variants, warehouses, customers, inventory. Cross-tenant read 404 `ORDER_NOT_FOUND`, variant 404 `VARIANT_NOT_FOUND`, warehouse 404 `WAREHOUSE_NOT_FOUND`, history 404, cancel 404. Manipulated JWT `tenantId` → 401. Client `tenantId` stripped, order created under authenticated tenant. Both directions tested.

### Validation / Security
Zod in `orders.validation.js`: `customerId` uuid, `items` min1 each `productVariantId` uuid, `warehouseId` uuid, `quantity` int positive, `discount`/`tax` decimalString, `shippingTotal` decimal, `currency` 3-char, `productId` optional but superRefine rejects, `page`/`limit`, `status` enum, `customerId`, `sortBy`/`sortOrder`, `id` uuid, status `reason`. Invalid quantities/status transitions 400, unauthorized 403, unauthenticated 401, parameterized raw SQL only, no string concat, safe errors, no sensitive leakage.

### Testing
`tests/integration/phase9-orders.test.js` 34 tests: creation (single, multi-item totals, snapshot write-once, insufficient rollback, variant active/tenant, productId reject, price override ignored, tenantId override, warehouse isolation, movement math), listing/detail/history, status valid/invalid/terminal, cancellation success/restore/atomic/invalid, authorization (403/401, create vs read), tenant isolation (8 cross-tenant cases, manipulated JWT), concurrency (5/5, never negative, consistent movements), business-agnostic. Full suite 337/337.

### Database / Migration Status
Reuses Phase 03 tables `orders`, `order_items`, `order_status_history`. No new Phase 9 migration required. 7 migrations up to date (`20250911_init_tenants` → `20260914_phase_08_inventory_management`). `npx prisma validate` ✅, `npx prisma migrate status` up to date. No `prisma db push`.

### Known Limitations (as reported in Phase 9 evidence)
* Customer creation API is not part of Phase 9; tests create customers directly via Prisma where required.
* `order_items` does not persist `warehouseId` because it is not part of existing Phase 3 schema/roadmap requirement; warehouse association is tracked through inventory movements (`referenceType ORDER`, `referenceId orderId`, `type ORDER_RESERVATION/ORDER_RELEASE`).
* Shipping/tax/discount functionality remains intentionally minimal (no complex pricing engine), keep business-agnostic.
* Payment/refund integration is deferred to Phase 10.
* Audit, notifications, realtime, caching, background jobs, integrations, analytics, etc. remain future phases.
* `warehouse_inventory` mirror remains for legacy compatibility.

### Relationship to Phase 10
Phase 10 Payment & Transaction Processing will operate on orders (payment → order) and remains not started, not implemented. Orders endpoint ready for future payment reference via `orderId`.

---

## Phase 09 Status: ✅ COMPLETE AND VERIFIED
All 337 tests pass (34 Phase 09), 303 prior, lint 0, Prisma valid, 7 migrations up to date (no new Phase 9 migration), app startup verified, HTTP verification 201/200/200/200/200/200, unauthorized 403, unauthenticated 401, cross-tenant 404, invalid transition 400, insufficient 400 rollback, concurrent 5/5 final 0, inventory 20 restored, roadmap untouched.
