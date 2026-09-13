# Project Documentation

Technical architecture and implementation state as of Phase 06 completion.

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
**Migration Chain (verified):**
```
20250911_init_tenants                    # Phase 02: tenants, tenant_settings, tenant_domains
        ↓
20250911_phase_03_core_schema            # Phase 03: 31 models
        ↓
20250911_phase_03_fix_timestamptz        # Correction: 89 timestamp columns to TIMESTAMPTZ(6)
        ↓
20250911_phase_04_authentication         # Phase 04: refresh_tokens, password_reset_tokens, email_verification_tokens, User.emailVerified
        ↓
20260912_phase_05_platform_rbac_foundation # Phase 05: tenant_memberships, platform_roles, platform_permissions, platform_user_roles, platform_role_permissions, Role, Permission, UserRole, RolePermission
```

- Phase 03 migration does **not** recreate Phase 02 tables
- Phase 04 migration adds 4 tables WITHOUT recreating Phase 02/03 tables
- Phase 05 migration adds 9 tables (tenant_memberships + platform* + RBAC tables) WITHOUT recreating Phase 01-04 tables
- All migrations applied, `npx prisma migrate status` reports "Database schema is up to date!"
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

### Current Verification Results (Latest Run)

| Check | Result |
|-------|--------|
| **Integration Tests** | 145/145 passing |
| - `auth.test.js` | 30 tests ✅ |
| - `tenants.test.js` | 11 tests ✅ |
| - `phase3-schema.test.js` | 39 tests ✅ |
| - `request-boundaries.test.js` | 2 tests ✅ |
| - `health.test.js` | 2 tests ✅ |
| - `phase5-rbac.test.js` | 54 tests ✅ |
| **ESLint** | 0 errors |
| **Prisma Validate** | ✅ Valid |
| **Prisma Generate** | ✅ Success |
| **Migration Status** | ✅ Up to date (5 migrations) |

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
| Product Management (Phase 07) | ⏳ Not Started |
| Inventory (Phase 08) | ⏳ Not Started |
| Orders (Phase 09) | ⏳ Not Started |
| Payments (Phase 10) | ⏳ Not Started |
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
573: - No Phase 1-5 regressions