# Implemented Features

This document describes features that have been **implemented and verified** in the repository, organized by completed phase.

---

## Phase 01 — Project Foundation

### Node.js/Express Application
- Express 5.x application with modular structure
- API versioning via `/api/v1` prefix
- Root health endpoints at `/health`, `/health/db`, `/health/redis`
- Versioned health endpoints at `/api/v1/health`, `/api/v1/health/db`, `/api/v1/health/redis`

### Environment Validation (Zod)
- `src/config/env.js` validates all environment variables at startup
- Required: `DATABASE_URL`, `REDIS_URL`
- Optional with defaults: `NODE_ENV`, `PORT`, `HOST`, `CORS_ORIGINS`, `LOG_LEVEL`, `REQUEST_BODY_LIMIT`, `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`, `TRUST_PROXY`, `FAIL_ON_DEPENDENCY_ERROR`

### PostgreSQL/Prisma Configuration
- `src/config/database.js` — Prisma Client singleton with connection management
- `prisma/schema.prisma` — datasource provider `postgresql`
- Connection pooling via Prisma
- Health check function `databaseHealthCheck()`

### Redis Configuration
- `src/config/redis.js` — ioredis client with connection management
- Health check function `redisHealthCheck()`

### Health Endpoints
| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Liveness probe — always returns 200 if process is running |
| `GET /health/db` | PostgreSQL readiness — 200 if connected, 503 if not |
| `GET /health/redis` | Redis readiness — 200 if connected, 503 if not |
| `GET /api/v1/health` | Versioned liveness |
| `GET /api/v1/health/db` | Versioned DB readiness |
| `GET /api/v1/health/redis` | Versioned Redis readiness |

Response format:
```json
{ "success": true, "data": { "status": "ok" }, "message": "Service is healthy" }
```

### Request IDs
- `src/common/middleware/request-context.js` — generates or extracts `X-Request-Id` header
- Available as `req.requestId` throughout the request lifecycle
- Included in all error responses

### Pino Structured Logging
- `src/config/logger.js` — Pino logger with configurable level (`LOG_LEVEL`)
- JSON output with timestamp, level, message, and context
- Child loggers for modules

### Centralized Errors
- `src/common/errors/app-error.js` — `AppError` class with status code, code, details
- `src/common/middleware/error-handler.js` — global error handler
- Zod validation errors formatted consistently
- 404 handler for unmatched routes

### Security Middleware
- **Helmet** — security headers
- **CORS** — allow-list from `CORS_ORIGINS`, credentials support
- **HPP** — HTTP Parameter Pollution protection
- **Compression** — gzip/deflate response compression
- **JSON body limit** — configurable via `REQUEST_BODY_LIMIT` (default 1mb)
- **Rate limiting** — configurable window and max via `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`

### Graceful Shutdown
- `SIGTERM` / `SIGINT` handlers
- Stops accepting new connections
- Closes Redis and Prisma connections
- 10-second forced exit timeout

### Jest/Supertest Coverage
- `tests/integration/health.test.js` — health endpoint tests
- `tests/integration/request-boundaries.test.js` — JSON size limits, malformed JSON, rate limit headers
- Test runner: `node --experimental-vm-modules jest --runInBand`

---

## Phase 02 — Multi-Tenant Foundation

### Tenant Models (Phase 02 Migration: `20250911_init_tenants`)

| Model | Key Fields |
|-------|------------|
| `tenants` | `id`, `name`, `slug` (unique), `status` (ACTIVE/SUSPENDED/TRIAL/CANCELLED), `plan`, `created_at`, `updated_at` |
| `tenant_settings` | `id`, `tenant_id` (unique), `metadata` (JSONB), `created_at`, `updated_at` |
| `tenant_domains` | `id`, `tenant_id`, `domain`, `verified`, `primary`, `created_at`, `updated_at` — unique on `(tenant_id, domain)` |

All timestamp columns use `TIMESTAMPTZ(6)`.

### Tenant CRUD APIs
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/tenants` | Create tenant |
| GET | `/api/v1/tenants/:id` | Get tenant by UUID |
| PATCH | `/api/v1/tenants/:id` | Update tenant (at least one field required) |
| DELETE | `/api/v1/tenants/:id` | Delete tenant |

**Validation (Zod):**
- `name`: string 1-255 chars
- `slug`: string 1-100 chars, regex `^[a-z0-9-]+$`, unique
- `status`: enum ACTIVE/SUSPENDED/TRIAL/CANCELLED (optional, default TRIAL)
- `plan`: string max 50 chars (optional, default free)

**Error codes:**
- `TENANT_SLUG_EXISTS` (409) — duplicate slug on create or update
- `TENANT_NOT_FOUND` (404) — get/update/delete on non-existent ID
- Zod validation errors (400) — invalid body/params

### Tenant Status Validation
- `TenantService.canPerformOperations(tenant)` returns true only for `ACTIVE` or `TRIAL`
- `SUSPENDED` and `CANCELLED` tenants are restricted from normal operations (foundation for later phases)

### Tenant Context Foundation
- `req.context.tenantId` pattern established in request context middleware
- Tenant resolution from authenticated context deferred to Phase 04
- Current implementation validates tenant existence but does not enforce tenant isolation on business APIs (no business APIs exist yet)

### Phase 02 Migration
- `prisma/migrations/20250911_init_tenants/migration.sql`
- Creates 3 tables with indexes and foreign keys
- Applied and verified

---

## Phase 03 — Database Schema & Migrations

### Phase 03 Models (31 models in `prisma/schema.prisma`)

#### RBAC Foundation
| Model | Description |
|-------|-------------|
| `users` | Tenant-scoped users with email, password hash, status, soft delete |
| `roles` | Tenant-scoped roles with name, description, is_system flag |
| `permissions` | Tenant-scoped permissions: `resource`, `action`, unique on `(tenant_id, resource, action)` |
| `user_roles` | Junction: user ↔ role, unique on `(tenant_id, user_id, role_id)` |
| `role_permissions` | Junction: role ↔ permission, unique on `(tenant_id, role_id, permission_id)` |

#### Product Catalog (Business-Agnostic)
| Model | Description |
|-------|-------------|
| `categories` | Hierarchical categories with parent_id, slug unique per tenant |
| `products` | General product concept: name, description, brand, status, optional base_price |
| `product_categories` | Junction: product ↔ category, unique on `(tenant_id, product_id, category_id)` |
| `product_variants` | **Sellable SKU**: sku (unique per tenant), barcode, price, cost_price, status |
| `product_variant_attributes` | Variant ↔ attribute definition with value |
| `product_images` | Images for product (variant_id null) or variant (variant_id set); storage_key, url, alt_text, sort_order, is_primary |

**Key product-model decisions:**
- **Business-agnostic Product** — no industry-specific columns (color, size, material, volume, storage_capacity, skin_type)
- **ProductVariant as sellable SKU** — every sellable unit is a variant with unique SKU per tenant
- **Tenant-scoped SKU uniqueness** — `@@unique([tenantId, sku])` on `product_variants`
- **Generic tenant-defined attributes** — `AttributeDefinition` (code, data_type) + `ProductVariantAttribute` (value) + `AttributeValue` (for OPTION type)
- **Product/Variant images** — single `ProductImage` model serves both via optional `variant_id`

#### Attribute System
| Model | Description |
|-------|-------------|
| `attribute_definitions` | Tenant-scoped attribute metadata: name, code (unique per tenant), data_type (TEXT/NUMBER/BOOLEAN/OPTION), is_required |
| `attribute_values` | Predefined values for OPTION type attributes, unique on `(tenant_id, attribute_definition_id, value)` |

#### Inventory & Warehouses
| Model | Description |
|-------|-------------|
| `warehouses` | Tenant-scoped warehouses with code (unique per tenant), address, is_active, is_default |
| `inventory` | Current stock per variant per warehouse, unique on `(tenant_id, product_variant_id, warehouse_id)` |
| `inventory_movements` | Audit trail of stock changes: type, quantity_before/changed/after, reason, reference |
| `warehouse_inventory` | Duplicate of inventory for read optimization (unique on `(tenant_id, warehouse_id, product_variant_id)`) |

#### Customers
| Model | Description |
|-------|-------------|
| `customers` | Tenant-scoped: email (unique per tenant), name, phone, metadata JSONB, soft delete |

#### Orders
| Model | Description |
|-------|-------------|
| `orders` | Tenant-scoped: customer_id (RESTRICT delete), status, subtotal/discount/tax/shipping/total (Decimal), currency, metadata |
| `order_items` | Line items with snapshots: product_name, variant_name, attribute_snapshot (JSONB), sku_snapshot, unit_price, quantity, discount, tax, line_total — `product_variant_id` RESTRICT delete |
| `order_status_history` | Status transition log: from_status, to_status, reason, created_by |

#### Payments
| Model | Description |
|-------|-------------|
| `payments` | Tenant-scoped: order_id (RESTRICT), amount, currency, status, provider, provider_payment_id, metadata |
| `payment_transactions` | Individual transactions: type (CHARGE/REFUND/CAPTURE/VOID), amount, status, provider_transaction_id |
| `refunds` | Refunds linked to payment: amount, status, reason, provider_refund_id |

#### Notifications
| Model | Description |
|-------|-------------|
| `notifications` | Tenant-scoped: user_id (nullable), type, title, message, channel, reference, read status |
| `notification_preferences` | Per-user per-channel enable/disable, unique on `(tenant_id, user_id, channel)` |
| `notification_templates` | Tenant-scoped templates: name, channel, subject, body, variables JSONB, unique on `(tenant_id, name, channel)` |

#### Audit & Activity Logs
| Model | Description |
|-------|-------------|
| `audit_logs` | Structured audit: action (CREATE/UPDATE/DELETE/LOGIN/...), resource, resource_id, old_value, new_value (JSONB), ip, user_agent |
| `activity_logs` | General activity: action string, description, metadata JSONB, ip, user_agent |

### Data Rules

| Rule | Implementation |
|------|----------------|
| PostgreSQL | Provider `postgresql` in schema |
| Decimal monetary values | `@db.Decimal(12, 2)` on all price/amount/total fields — never Float |
| TIMESTAMPTZ(6) | `@db.Timestamptz(6)` on all `createdAt`, `updatedAt`, `deletedAt`, `lastLoginAt`, `readAt`, `created_at` columns |
| `tenant_id` on tenant-owned tables | Every Phase 03 model has required `tenantId` with `@relation` to `Tenant` cascade |
| Indexes | Composite indexes including `tenant_id` for common query patterns (see schema) |
| Unique constraints | Tenant-scoped: email, slug, sku, code, warehouse code, etc. |
| Foreign keys | All relations defined with explicit `onDelete`/`onUpdate` (CASCADE, RESTRICT, SET NULL) |
| Soft delete | `deletedAt` nullable on: users, categories, products, product_variants, warehouses, customers, orders, payments |

### Important Indexes (from schema)
- `products(tenant_id, status)`, `products(tenant_id, created_at)`
- `product_variants(tenant_id, product_id)`, `product_variants(tenant_id, sku)` UNIQUE, `product_variants(tenant_id, barcode)`
- `product_variant_attributes(tenant_id, variant_id)`, `product_variant_attributes(tenant_id, attribute_definition_id, value)`
- `product_images(tenant_id, product_id)`, `product_images(tenant_id, variant_id)`
- `attribute_definitions(tenant_id, code)` UNIQUE
- `inventory(tenant_id, product_variant_id, warehouse_id)` UNIQUE
- `inventory_movements(tenant_id, product_variant_id, created_at)`
- `orders(tenant_id, status)`, `orders(tenant_id, created_at)`
- `order_items(tenant_id, product_variant_id)`

### Migration Chain

```
20250911_init_tenants (Phase 02)
        ↓
20250911_phase_03_core_schema (Phase 03 — 31 models)
        ↓
20250911_phase_03_fix_timestamptz (Correction — all timestamps to TIMESTAMPTZ(6))
```

- Phase 02 creates 3 tables
- Phase 03 adds 31 tables WITHOUT recreating Phase 02 tables
- Correction migration alters 89 timestamp columns from `TIMESTAMP(3)` to `TIMESTAMPTZ(6)`
- All migrations applied, database schema up to date

### Seed Strategy

**File:** `prisma/seed.js`
**Command:** `npm run db:seed`

**What is seeded per tenant:**
- 36 system permissions covering: tenant, user, role, permission, product, category, order, customer, warehouse, inventory
- 3 system roles:
  - `admin` → all 36 permissions
  - `manager` → 32 permissions (excludes: user:delete, role:delete, permission:read, tenant:update)
  - `member` → 10 read-only permissions
- 78 role-permission links (admin=36, manager=32, member=10)

### Required Permission Names (Roadmap-Compliant)
```
product:create, product:read, product:update, product:delete
order:create, order:read, order:update, order:cancel
inventory:read, inventory:update
```

**Idempotency:**
- Uses `upsert` with composite unique keys:
  - `tenantId_resource_action` for permissions
  - `tenantId_name` for roles
  - `tenantId_roleId_permissionId` for role_permissions
- Safe to run repeatedly — second run creates no duplicates
- Creates a default "Development" tenant if none exists

**Scope:**
- Foundational RBAC reference data ONLY
- No fake business data (no products, orders, customers, inventory, payments)
- No authentication implementation
- No password hashing

---

## Phase 04 — Authentication

### Core Authentication Features

| Feature | Implementation |
|---------|----------------|
| User Registration | `POST /api/v1/auth/register` — validates tenant, hashes password (Argon2id), creates user, initiates email verification |
| User Login | `POST /api/v1/auth/login` — validates tenant/credentials, issues access JWT + refresh token |
| Access Token | JWT (HS256), 15 min expiry, claims: `sub`, `tenantId`, `sessionId`, `email` |
| Refresh Token | 7-day expiry, SHA-256 hash stored in DB, rotation on each use |
| Refresh Rotation | Transaction-safe (Prisma `$transaction`): revoke old + create new atomically |
| Refresh Revocation | `revoked_at` timestamp, checked on each use |
| Refresh Reuse Detection | Revoked token reuse triggers revocation of ALL user tokens |
| Logout | `POST /api/v1/auth/logout` — revokes provided refresh token |
| Password Hashing | Argon2id (memoryCost=19456, timeCost=2, parallelism=1) |
| Forgot Password | `POST /api/v1/auth/forgot-password` — generates secure reset token (1h expiry), account enumeration safe |
| Reset Password | `POST /api/v1/auth/reset-password` — validates token, hashes new password, revokes all refresh tokens |
| Email Verification | `POST /api/v1/auth/verify-email` — 24h expiry, single-use, sets `emailVerified=true` |
| Current User | `GET /api/v1/auth/me` — requires valid Bearer JWT, returns safe user profile |

### JWT Design
- **Algorithm:** HS256 (HMAC SHA-256)
- **Access Token:** 15 min expiry, claims: `sub`, `tenantId`, `sessionId`, `email`
- **Refresh Token:** 7 days, stored as SHA-256 hash in DB, rotated on each use
- **Secrets:** `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` (min 32 chars, required in production)
- **Claims:** `iss: pulseops`, `aud: pulseops-api`

### Refresh Token Security
- **Never stored plaintext** — only SHA-256 hash in DB
- **Expiration enforced** — 7 days, checked on each refresh
- **Revocation enforced** — `revoked_at` timestamp, checked on each use
- **Rotation** — old token revoked, new token issued on each refresh
- **Reuse detection** — revoked token reuse triggers revocation of ALL user tokens
- **Transaction-safe rotation** — revoke old + create new in single Prisma `$transaction`
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

### Cross-Tenant Isolation
- All auth records scoped by `tenant_id`
- Login/register require explicit `tenantId`
- JWT contains `tenantId` claim
- `/auth/me` validates tenant context
- Cross-tenant token reuse prevented at application layer
- Refresh tokens bound to originating tenant via stored `tenant_id`

---

## Phase 05 — Authorization / RBAC

### Core RBAC Features

| Feature | Implementation |
|---------|----------------|
| Permission Format | `resource:action` (e.g., `product:create`, `order:read`) |
| Authorization Middleware | `authorize(permission)` — checks user's roles/permissions from authenticated context |
| Permission Resolution | user → user_roles → roles → role_permissions → permissions (all tenant-scoped) |

### RBAC APIs

| Method | Endpoint | Permission Required | Description |
|--------|----------|---------------------|-------------|
| GET | `/api/v1/roles` | `role:read` | List roles (tenant-scoped, paginated) |
| GET | `/api/v1/roles/:id` | `role:read` | Get role by ID |
| POST | `/api/v1/roles` | `role:create` | Create role (is_system=false) |
| PATCH | `/api/v1/roles/:id` | `role:update` | Update role (name/description) |
| DELETE | `/api/v1/roles/:id` | `role:delete` | Delete role |
| POST | `/api/v1/roles/:id/permissions` | `role:update` | Assign permissions to role (idempotent) |
| GET | `/api/v1/permissions` | `permission:read` | List permissions (tenant-scoped) |
| GET | `/api/v1/permissions/:id` | `permission:read` | Get permission by ID |
| GET | `/api/v1/users/:id/roles` | `user:read` | Get user's assigned roles |
| POST | `/api/v1/users/:id/roles` | `user:update` | Assign roles to user (idempotent) |

### System Roles & Permissions (Seeded)

| Role | Description | Permissions |
|------|-------------|-------------|
| `admin` | Full administrative access | All 36 system permissions |
| `manager` | Management access | 32 permissions (excludes: user:delete, role:delete, permission:read, tenant:update) |
| `member` | Standard member access | 10 read-only permissions |

**System roles are immutable** — cannot be deleted or modified via API (`is_system=true` in DB).

### Authorization Middleware

```javascript
router.post(
  "/products",
  authenticate(),
  authorize("product:create"),
  controller.create
);
```

1. Requires authenticated request (`authenticate()`)
2. Reads `userId`, `tenantId` from `req.context` (set by `authenticate()`)
3. Finds user's roles in the authenticated tenant
4. Resolves permissions through `user_roles` → `roles` → `role_permissions` → `permissions`
5. Checks if requested permission (`resource:action`) exists
6. Allows (200) or rejects (403 FORBIDDEN / 401 UNAUTHORIZED)

### Tenant Isolation

- All RBAC queries filtered by `tenantId` from authenticated context (`req.context.tenantId`)
- **Never trusts** `tenantId` from request body/query/params
- Cross-tenant role/permission access returns 404/403
- JWT with manipulated `tenantId` claim fails (user not found in that tenant)

### System Role Protection

- System roles (`is_system=true`) cannot be deleted or modified
- System role permissions cannot be modified via `POST /roles/:id/permissions`
- Returns 403 `SYSTEM_ROLE_IMMUTABLE` on violation

### Idempotent Assignments

- `POST /roles/:id/permissions` — `skipDuplicates: true` on `role_permission` createMany
- `POST /users/:id/roles` — `skipDuplicates: true` on `user_role` createMany
- Safe to call repeatedly

### Error Codes

| Code | HTTP | Description |
|------|------|-------------|
| `FORBIDDEN` | 403 | Authenticated but missing required permission |
| `ROLE_NOT_FOUND` | 404 | Role not found in authenticated tenant |
| `PERMISSION_NOT_FOUND` | 404 | Permission not found in authenticated tenant |
| `USER_NOT_FOUND` | 404 | User not found in authenticated tenant |
| `ROLE_NAME_EXISTS` | 409 | Duplicate role name in same tenant |
| `SYSTEM_ROLE_IMMUTABLE` | 403 | Attempt to modify/delete system role |

### Verification Results

| Check | Result |
|-------|--------|
| **Integration Tests** | 145/145 passing (Phases 01-05) |
| - `phase5-rbac.test.js` | 54 tests ✅ |
| - `auth.test.js` | 30 tests ✅ |
| - `tenants.test.js` | 11 tests ✅ |
| - `phase3-schema.test.js` | 39 tests ✅ |
| - `request-boundaries.test.js` | 2 tests ✅ |
| - `health.test.js` | 2 tests ✅ |
| **ESLint** | 0 errors |
| **Prisma Validate** | ✅ Valid |
| **Prisma Generate** | ✅ Success |
| **Migration Status** | ✅ Up to date (5 migrations) |

### Tenant Isolation Verification (7 attacks blocked)
| Attack | Result |
|--------|--------|
| Tenant A user → GET Tenant B roles | PASS |
| Tenant A user → PATCH Tenant B role | PASS (404) |
| Tenant A user → assign Tenant B role to Tenant A user | PASS (filtered) |
| Tenant B user → GET Tenant A permissions | PASS |
| Forge JWT with different tenantId | PASS (401) |
| Tenant A role → attach Tenant B permission | PASS (filtered) |
| Tenant A role → POST Tenant B role permissions | PASS (404) |

### Privilege Escalation Protection (8 vectors blocked)
| Attack | Result |
|--------|--------|
| Normal user assigns admin role to self | PASS (403) |
| Normal user assigns admin role to another | PASS (403) |
| Normal user modifies system role | PASS (403) |
| Normal user deletes system role | PASS (403) |
| Normal user modifies role permissions | PASS (403) |
| User with no roles accesses protected resource | PASS (403) |
| User with insufficient permission accesses protected resource | PASS (403) |

### Known Non-Blocking Design Behaviors
- Cross-tenant role/permission IDs may be silently filtered rather than producing an error — this is a documented implementation behavior, not a roadmap change
- `DELETE /api/v1/users/:id/roles` is not required by the Phase 5 roadmap
- `authorizePlatform()` testing is outside the current Phase 5 scope
- Permission caching is not required for Phase 5

---

## Phase 06 — User Management

### Core User Management Features

| Feature | Implementation |
|---------|----------------|
| User Listing | `GET /api/v1/users` — tenant-scoped, paginated, search, filter, sort |
| User Retrieval | `GET /api/v1/users/:id` — tenant-scoped, includes roles |
| User Update | `PATCH /api/v1/users/:id` — explicit allowlist (firstName, lastName, status) |
| User Deletion | `DELETE /api/v1/users/:id` — hard delete, self-deletion prevented |

### User Listing Features

- **Pagination:** `page` (default 1), `limit` (default 20, max 100)
- **Search:** `search` parameter queries email, firstName, lastName (case-insensitive)
- **Status filtering:** `status` parameter (ACTIVE, INACTIVE, SUSPENDED)
- **Role filtering:** `roleId` parameter filters users by assigned role
- **Sorting:** `sortBy` (createdAt, updatedAt, email, firstName, lastName, status) with `sortOrder` (asc, desc)
- **Response:** Standard pagination metadata (`page`, `limit`, `total`, `totalPages`)

### User Retrieval

- Returns user with roles (id, name, isSystem)
- **Never exposes:** `passwordHash`, `refreshToken`, `passwordResetToken`, `emailVerificationToken`, or any authentication secrets
- 404 if user not found in authenticated tenant

### User Update (Explicit Allowlist)

- **Allowed fields:** `firstName`, `lastName`, `status`
- **Explicitly rejected (400):**
  - `email` → `EMAIL_MODIFICATION_FORBIDDEN`
  - `passwordHash` → `PASSWORD_MODIFICATION_FORBIDDEN`
  - `tenantId` → `TENANT_MODIFICATION_FORBIDDEN`
- `roleIds` is not an allowed field and is silently ignored (roles managed via `/users/:id/roles` endpoint)
- `status` validated against enum (ACTIVE, INACTIVE, SUSPENDED)

### User Deletion

- Hard delete via Prisma (no soft delete in Phase 06)
- **Self-deletion prevented:** 400 `SELF_DELETION_FORBIDDEN`
- 404 if user not found in authenticated tenant

### Tenant Isolation

- All queries scoped by `memberships: { some: { tenantId, status: 'ACTIVE' } }` using `req.context.tenantId` from authenticated JWT
- **Never trusts** client-supplied `tenantId`
- Cross-tenant GET/UPDATE/DELETE returns 404 `USER_NOT_FOUND`
- Search/filtering cannot escape authenticated tenant scope
- JWT with manipulated `tenantId` claim fails authentication (401 `USER_NOT_FOUND` or `INVALID_TOKEN`)

### Authorization

- Reuses Phase 05 RBAC permissions via existing `authorize()` middleware:
  - `user:read` for GET endpoints
  - `user:update` for PATCH endpoint
  - `user:delete` for DELETE endpoint
- **No new authorization architecture or permissions created**
- Permissions `user:read`, `user:update`, `user:delete` existed in Phase 05 seed
- Role assignment (seeded):
  - `admin`: all user permissions
  - `manager`: user:read, user:update (no user:delete)
  - `member`: user:read only

### Privilege Escalation Protection

- Explicit allowlist prevents modification of privileged fields
- `roleIds` cannot modify roles through user update endpoint
- Self-deletion prevented
- Platform permissions remain separate via `authorizePlatform()`

### Module Structure

```
users/
├── users.controller.js    # HTTP handlers, response formatting
├── users.service.js       # Business logic, allowlist, privilege protection
├── users.repository.js    # Database queries with tenant scoping
├── users.validation.js    # Zod schemas for query/params/body
└── users.routes.js        # Route registration with authorize()
```

### Verification Results

| Check | Result |
|-------|--------|
| **Phase 06 Integration Tests** | 44/44 passing |
| **Full Integration Suite** | 189/189 passing |
| **ESLint** | 0 errors |
| **Prisma Validate** | ✅ Valid |
| **Migration Status** | ✅ Up to date (5 migrations, no Phase 06 schema changes) |
| **Application Startup** | ✅ Verified |

### Phase 06 Test Coverage

- **GET /users:** 11 tests (auth, pagination, search, filter, sort, status, roleId, tenant isolation)
- **GET /users/:id:** 7 tests (valid, 404, cross-tenant, sensitive fields, authz)
- **PATCH /users/:id:** 11 tests (valid fields, invalid status, forbidden fields, cross-tenant, authz)
- **DELETE /users/:id:** 6 tests (valid, self-delete prevention, cross-tenant, 404, authz)
- **Privilege Escalation:** 3 tests (role manipulation, tenant escalation via JWT)
- **Tenant Isolation:** 5 tests (all cross-tenant operations blocked)
- **Response Structure:** 2 tests (list and single user format)

### Database

- **No schema changes required for Phase 06**
- Existing Prisma schema supports all operations via User, UserRole, TenantMembership, Role models
- 5 existing migrations remain valid and applied

---

## Phase 07 — Product Management (COMPLETE & VERIFIED — 78/78, 267/267)

### Product Catalog (Business-Agnostic)
- **Product CRUD:** `POST/GET /api/v1/products`, `GET/PATCH/DELETE /api/v1/products/:id` — name, description, brand, status (ACTIVE/INACTIVE/DRAFT/ARCHIVED), basePrice Decimal, tenant-scoped
- **Category CRUD:** `POST/GET /api/v1/categories`, `PATCH/DELETE /api/v1/categories/:id` — name, slug unique per tenant, description, parentId hierarchy, sortOrder, isActive, cycle detection (400), hasChildren guard (400)
- **Category Hierarchy:** parent/children via `parentId`, tenant-scoped, verified via integration tests
- **Product/Category Relationships:** `POST /api/v1/products/:productId/categories` (set with isPrimary), `GET /api/v1/products/:productId/categories`, junction `product_categories` tenant-scoped
- **Product Variants (Sellable Unit):** `POST/GET /api/v1/products/:productId/variants`, `GET/PATCH/DELETE /api/v1/products/:productId/variants/:variantId` — SKU unique per tenant (409), barcode unique per tenant (409, nullable), price/costPrice Decimal, status, productId ownership check, tenant isolation
- **Variant Attributes:** `PUT /api/v1/products/:productId/variants/:variantId/attributes` (replace, validates attribute exists in tenant 404, value type 400), `GET /api/v1/products/:productId/variants/:variantId/attributes`
- **Tenant-Scoped SKUs/Barcodes:** SKU `@@unique([tenantId, sku])`, barcode `@@index([tenantId, barcode])`, cross-tenant same SKU allowed (201), same-tenant duplicate 409, lookup via `GET /api/v1/products?sku=X`/`?barcode=Y` tenant-scoped (returns 0 for other tenant)
- **Flexible Attributes:** business-agnostic generic model, examples clothing/electronics/cosmetics via attributes, not columns; `AttributeDefinition` code `^[a-z0-9_-]+$` unique per tenant, `dataType` TEXT/NUMBER/BOOLEAN/OPTION, `isRequired`, `description` (Phase 07 TEXT nullable, migration `20260913_phase_07_attribute_description`), `AttributeValue` unique on `(tenantId, attributeDefinitionId, value)`
- **Attribute CRUD:** `POST/GET /api/v1/attributes`, `PATCH/DELETE /api/v1/attributes/:id` (409 duplicate code, 400 in-use guards)
- **Attribute Values:** `POST/GET /api/v1/attributes/:attributeId/values`, `PATCH/DELETE /api/v1/attributes/:attributeId/values/:valueId`
- **Product Images CRUD (Local StorageService):** `POST /api/v1/products/:productId/images` (multer 10MB, JPEG/PNG/WebP/GIF, server key `tenants/{tenantId}/products/{productId}/{sanitizedFilename}`), `GET /api/v1/products/:productId/images`, `GET /api/v1/products/:productId/images/:imageId`, `PATCH /api/v1/products/:productId/images/:imageId` (product:update, only altText/sortOrder/isPrimary, storageKey/tenantId ignored, tenant+product ownership 404), `DELETE /api/v1/products/:productId/images/:imageId` (product:delete, DB + local storage object removed, traversal protected, cross-tenant 404, unauthorized 403)
- **Variant Images:** `POST /api/v1/products/:productId/variants/:variantId/images` (validates variant belongs to product, key `tenants/{t}/products/{p}/variants/{v}/{file}`), `GET /api/v1/products/:productId/variants/:variantId/images`
- **Local StorageService:** `StorageService → LocalStorageProvider` (`./storage` basePath, `getFullPath` traversal check, `sanitizeFilename`, `validateImageFile`), S3 deferred to Phase 16 per roadmap, bytes on filesystem, PostgreSQL stores `storage_key` + metadata
- **Tenant-Scoped Storage Keys:** server-generated, `tenants/{tenantId}/products/{productId}/` and `tenants/{tenantId}/products/{productId}/variants/{variantId}/`, client cannot supply arbitrary path, filename sanitized, verified via integration tests
- **Product Filtering:** pagination (`page`/`limit`), search (name/description/brand), sorting, category filtering, status filtering, price filtering (`minPrice`/`maxPrice` gte/lte), variant filtering, SKU filtering (`?sku=` contains), barcode filtering (`?barcode=` contains), attribute filtering (`?attribute[code]=value` tenant-scoped AND), variant `AND` composition verified
- **Pagination:** standard meta `page,limit,total,totalPages` on all lists
- **RBAC Authorization:** `product:create/read/update/delete`, `category:create/read/update/delete`, `attribute:create/read/update/delete` via `authorize()` after `authenticate()` + tenant context; `PATCH image → product:update`, `DELETE image → product:delete`; 401 if unauthenticated, 403 if missing permission
- **Tenant Isolation:** every op `where:{tenantId}` from `req.context.tenantId`, cross-tenant 404 (`PRODUCT_NOT_FOUND` etc.), `productId` ownership for images/variants, JWT manipulated tenantId → 401, storage keys tenant-scoped, SKU/barcode isolation verified (tenant A lookup B SKU/barcode → 0, same SKU cross-tenant allowed, retrieve/update/delete cross-tenant variant → 404)
- **Validation:** Zod on all inputs (slug `^[a-z0-9-]+$`, code `^[a-z0-9_-]+$`, price Decimal regex, enum status, description max, etc.), image 10MB + mime, attribute code/values, product/variant, etc.
- **Integration/API Testing:** 78 Phase 7 tests (267 full), covering CRUD, validation, duplicates 409, search/filtering (sku/barcode/attribute), pagination, `productId` ownership, auth 401, RBAC 403, tenant isolation 404, manipulated JWT, image PATCH/DELETE (200, 404 cross-tenant, 403 unauthorized, 401 unauth, wrong productId 404, storageKey unchanged, DB+storage consistency, tenant-scoped keys), variant image, storage isolation
- **Database:** only change `attribute_definitions.description` nullable TEXT, migration `20260913_phase_07_attribute_description` (`ADD COLUMN IF NOT EXISTS`), 6 migrations up to date (7 after Phase 08), `prisma validate` valid

---

## Phase 08 — Inventory Management (COMPLETE & VERIFIED — 36/36, 303/303, 7 migrations)

### Inventory Management

- [x] Variant/SKU-level inventory (`product_variant_id` + `warehouse_id`, never `product_id`)
- [x] Warehouse inventory (`warehouses` tenant-scoped, `code` unique per tenant, independent stock per variant per warehouse)
- [x] Warehouse management supporting inventory: `POST/GET /api/v1/warehouses`, `GET/PATCH/DELETE /api/v1/warehouses/:id` (`warehouse:create/read/update/delete`)
- [x] Positive stock adjustment (`POST /api/v1/inventory/adjust` `quantityChanged` positive, `inventory:update`, creates `ADJUSTMENT` movement)
- [x] Negative stock adjustment (`quantityChanged` negative, validates `after >=0`)
- [x] Insufficient stock protection (400 `INSUFFICIENT_STOCK`, stock unchanged, no invalid movement)
- [x] Inventory movement history (`GET /api/v1/inventory/movements`, paginated, filters variant/warehouse/type, fields `quantity_before`/`quantity_changed`/`quantity_after`/`reason`/`reference_type`/`reference_id`/`created_by`/`created_at`, invariant `after = before + changed`)
- [x] Atomic transfers (`POST /api/v1/inventory/transfer` source `quantity -5` dest `+5`, 2 `TRANSFER` movements same `referenceId`, validates source/dest warehouses + variant tenant ownership, rejects same warehouse 400 `SAME_WAREHOUSE`, insufficient 400, transaction rollback on failure)
- [x] PostgreSQL concurrency protection (`SELECT ... FOR UPDATE` row locking, sorted lock order for transfer, `prisma.$transaction` with retry for `40001`/`40P01`, verified 10 parallel `-1` from 5 → 5 success/5 fail final 0)
- [x] Non-negative stock enforcement (service validation + DB CHECKs `inventory_quantity_non_negative`, `warehouse_inventory_quantity_non_negative`, `inventory_movements_quantity_consistency`)
- [x] Low-stock endpoint (`GET /api/v1/inventory/low-stock` `threshold` default 10, `warehouseId` filter, `quantity <= threshold`, ordered ASC, tenant-scoped)
- [x] Inventory listing (`GET /api/v1/inventory` paginated, filters `warehouseId`, `variantId`, `sku`, `search`)
- [x] Variant inventory (`GET /api/v1/inventory/variants/:variantId` warehouse-specific quantities, 404 if cross-tenant variant)
- [x] Tenant isolation (all ops `where:{tenantId}` from JWT, cross-tenant read/adjust/transfer 404, movements/warehouses/variants isolated both directions)
- [x] Authorization (`inventory:read` for GETs, `inventory:update` for adjust/transfer, `warehouse:*` for warehouses, 401 unauth, 403 insufficient, tenant membership check)
- [x] Validation (Zod: variantId/warehouseId UUID, quantityChanged non-zero int, transfer quantity positive, same warehouse, enum types, pagination)
- [x] Inventory API tests (reads, adjustments, transfers, warehouse/SKU independence, auth, tenant isolation)
- [x] Concurrency tests (parallel decrements never negative, movements math `after = before + changed`)
- [x] Regression tests (Phase 1-7 still pass: 267→303)
- [x] Database: reuses Phase 03 `warehouses`, `inventory`, `warehouse_inventory`, `inventory_movements`; Phase 08 migration `20260914_phase_08_inventory_management` adds only CHECK constraints, no new tables, no `prisma db push`
- [x] Business-agnostic: same variant/SKU/warehouse model for clothing/electronics/cosmetics (verified via generic SKUs)

**APIs (Phase 08):**
| Method | Endpoint | Permission | Description |
|--------|----------|------------|-------------|
| GET | `/api/v1/inventory` | `inventory:read` | List inventory |
| GET | `/api/v1/inventory/variants/:variantId` | `inventory:read` | Variant inventory |
| POST | `/api/v1/inventory/adjust` | `inventory:update` | Adjust stock |
| POST | `/api/v1/inventory/transfer` | `inventory:update` | Transfer stock |
| GET | `/api/v1/inventory/movements` | `inventory:read` | Movement history |
| GET | `/api/v1/inventory/low-stock` | `inventory:read` | Low-stock (threshold) |
Warehouses: `POST/GET /api/v1/warehouses`, `GET/PATCH/DELETE /api/v1/warehouses/:id`

**Verification:** 36/36 Phase 8, 303/303 full (before Phase 9), lint 0, Prisma valid, 7 migrations up to date, adjust 25→30→27, transfer 27→22/14→19, insufficient 400, same warehouse 400, cross-tenant 404, unauthorized 403, unauth 401, concurrent 5/5 final 0.

---

## Phase 09 — Order Management (COMPLETE & VERIFIED — 34/34, 337/337, 7 migrations — no new migration)

### Order Management

- [x] Order creation (`POST /api/v1/orders`) — tenant-scoped `customerId`, variant/SKU via `product_variant_id`, warehouse per item, quantity positive int, server-side Decimal pricing, atomic transaction
- [x] Order listing (`GET /api/v1/orders`) — tenant-scoped pagination (`page`/`limit`), filters `status`, `customerId`, safe sorting `createdAt`/`updatedAt`/`total`/`status`
- [x] Order detail (`GET /api/v1/orders/:id`) — order + items + customer, snapshots, status, tenant ownership 404
- [x] Status updates (`PATCH /api/v1/orders/:id/status`) — state-machine validated, history created, rejects invalid 400 `INVALID_STATUS_TRANSITION`
- [x] Cancellation (`POST /api/v1/orders/:id/cancel`) — cancellable DRAFT/PENDING/CONFIRMED/PROCESSING, restores `ORDER_RELEASE`, history, rejects SHIPPED 400 `CANCELLATION_NOT_ALLOWED`, double cancel 400
- [x] Status history (`GET /api/v1/orders/:id/history`) — paginated chronological, `fromStatus` nullable → `toStatus`, `reason`, `createdBy`, tenant-scoped
- [x] Variant/SKU references — `order_items.product_variant_id` required, never `productId`, `productId` rejected 400, tenant-scoped ACTIVE validation
- [x] Immutable commercial snapshots — `product_name_snapshot`, `variant_name_snapshot`, `attribute_snapshot` JSON, `sku_snapshot`, `unit_price` Decimal (authoritative), `quantity`, `discount`, `tax`, `line_total`; write-once, later price change preserved
- [x] Server-side Decimal pricing — `Decimal @db.Decimal(12,2)`, no Float; `line = unit*qty - discount + tax`, `subtotal`/`discountTotal`/`taxTotal`/`total = subtotal - discountTotal + taxTotal + shipping`; client `unitPrice`/`total` stripped/ignored
- [x] Inventory reservation/reduction — `SELECT ... FOR UPDATE` sorted locks, validates `available >= requested` else 400 `INSUFFICIENT_STOCK`, `UPDATE quantity = after`, mirror `warehouse_inventory`, no negative via CHECK
- [x] Inventory movements — `ORDER_RESERVATION` on create (`quantity_before`/`quantity_changed` negative/`quantity_after` + `after=before+changed`), `ORDER_RELEASE` on cancel, `referenceType ORDER` `referenceId orderId`, `createdBy`
- [x] Transaction rollback — order + items + inventory + movements + history in one `prisma.$transaction`; failure rolls back all, verified no orphan order/movement/history, inventory unchanged
- [x] Concurrency protection — `SELECT ... FOR UPDATE` deterministic order, retry for `40001`/`40P01`, verified 5 stock 10 concurrent qty1 → 5 success/5 fail final 0 never negative, movements consistent
- [x] Cancellation inventory restoration — atomic per `ORDER_RESERVATION` movement, locks inventory, `warehouse_inventory` mirror, `ORDER_RELEASE` created, verified 18→20
- [x] RBAC — `order:create` (POST), `order:read` (GET list/detail/history), `order:update` (PATCH), `order:cancel` (POST cancel); 401 unauth, 403 insufficient, tenant membership check
- [x] Tenant isolation — `tenantId` from `req.context.tenantId` never client body/query; all Prisma `where:{tenantId}`, cross-tenant read/list/detail/history/status/cancel/variant/warehouse 404 both directions, manipulated JWT 401, client `tenantId` stripped
- [x] Validation — Zod `customerId` uuid, `items` min1, `productVariantId` uuid, `warehouseId` uuid, `quantity` int positive, `discount`/`tax` decimalString, `shippingTotal` decimal, `productId` rejected, `status` enum, pagination, UUIDs
- [x] Integration tests — 34 Phase 9, 337 full: creation, multi-item, snapshots, pricing/totals, insufficient/rollback, variant/warehouse isolation, status transitions/history, cancellation/restoration, auth (403/401), tenant isolation (8 cases), concurrency (5/5), business-agnostic
- [x] Regression tests — Phase 1–8 still pass (303→337)
- [x] Database — reuses Phase 03 `orders`/`order_items`/`order_status_history`; no new Phase 9 migration; 7 migrations up to date; no `prisma db push`; `warehouse_inventory` mirror legacy
- [x] Business-agnostic — same variant/SKU/warehouse snapshot model for any tenant business

**APIs (Phase 09):**
| Method | Endpoint | Permission | Description |
|--------|----------|------------|-------------|
| POST | `/api/v1/orders` | `order:create` | Create order (SKU, warehouse, snapshots, atomic) |
| GET | `/api/v1/orders` | `order:read` | List orders (pagination, status, customerId) |
| GET | `/api/v1/orders/:id` | `order:read` | Get order with items and snapshots |
| PATCH | `/api/v1/orders/:id/status` | `order:update` | Update status (state machine) |
| POST | `/api/v1/orders/:id/cancel` | `order:cancel` | Cancel order (inventory restoration) |
| GET | `/api/v1/orders/:id/history` | `order:read` | Status history (chronological) |

**Verification:** 34/34 Phase 9, 337/337 full (10 suites), lint 0, Prisma valid, 7 migrations up to date (no new Phase 9 migration), app startup, HTTP 201/200, unauthorized 403, unauth 401, cross-tenant 404, invalid transition 400, insufficient 400 rollback, concurrent 5/5 final 0.

---

## Phase 10 — Payment & Transaction Processing (COMPLETE & VERIFIED — 40/40, 377/377, 8 migrations)

### Payment & Transaction Processing
- [x] Business-agnostic payment architecture (`Order → Payment → Payment Transaction → Refund`), processor-agnostic, no industry-specific columns, payments anchored to Orders not catalog items
- [x] Database: reuses Phase 03 `payments`/`payment_transactions`/`refunds` (`Decimal(12,2)`, `PaymentStatus`/`PaymentTransactionType`/`RefundStatus` enums, tenant-scoped); **Phase 10 infrastructure** `payment_webhook_events` (`id`, `tenant_id` CASCADE, `payment_id` SET NULL, `event_id`, `provider_event_id`, `provider_payment_id`, `type`, `payload` JSONB, `created_at timestamptz` with `@@unique([tenantId, eventId])` + `@@unique([eventId])`, indexes, FKs) + partial unique provider indexes (`WHERE NOT NULL`) + non-negative CHECKs; migration `20260914_phase10_payments_webhook`
- [x] Architecture preserved `Route → Controller → Service → Repository → Database` (`payments/` with controller/service/repository/validation/routes/webhook.util, mounted `/api/v1/payments` in `src/app/routes.js`; controller HTTP only, service state/tenant/transaction, repository tenant-scoped Prisma)
- [x] Payment creation (`POST /api/v1/payments/create`, `payment:create`): `orderId` uuid strict, validates order exists tenant-scoped 404, `ORDER_ELIGIBLE_STATUSES [PENDING,CONFIRMED,PROCESSING,DRAFT]` else 400, derives `amount=order.total`/`currency` server-side (client `amount` strict 400), `Decimal` non-negative, duplicate pending guard 400 `PAYMENT_ALREADY_PENDING`, `providerPaymentId`= `pay_<uuid>` + initial `CHARGE PENDING` transaction in `$transaction`, `tenantId` from `req.context`
- [x] Payment confirmation (`POST /api/v1/payments/confirm`, `payment:confirm`): strict `paymentId` uuid + optional `providerPaymentId`/`simulateFailure` (no `status` — strict rejects injection), validates `PENDING`/`PROCESSING` else 400 `INVALID_STATE_TRANSITION`, `targetStatus = FAILED|COMPLETED` via `isValidTransition`, `SELECT ... FOR UPDATE`, creates `CHARGE` transaction, rollback on invalid, cross-tenant 404
- [x] Controlled state machine `PENDING:[PROCESSING,COMPLETED,FAILED,CANCELLED] PROCESSING:[COMPLETED,FAILED,CANCELLED] COMPLETED:[REFUNDED,PARTIALLY_REFUNDED] PARTIALLY_REFUNDED:[REFUNDED,PARTIALLY_REFUNDED] FAILED/CANCELLED/REFUNDED:[]`, server-side only, frontend cannot inject `SUCCESS`
- [x] Webhook (`POST /api/v1/payments/webhook`, HMAC `x-webhook-signature`/`x-payment-signature`): strict `eventId`/`type` enum `payment.succeeded|payment.failed|payment.refunded|charge.succeeded|charge.failed` + optional `paymentId`/`providerPaymentId`/`providerTransactionId`/`amount`/`currency`/`tenantId`; HMAC-SHA256 `timingSafeEqual` with `PAYMENT_WEBHOOK_SECRET`, invalid 401, malformed 400, resolves tenant via payment lookup, `INSERT` webhook event inside `$transaction` — duplicate `P2002` on `tenantId+eventId`/`eventId` → `200 duplicate:true` safely ignored, maps type to `targetStatus` only if `isValidTransition`, locks payment, deduplicates `providerTransactionId`, tenant-isolated
- [x] Webhook idempotency: DB unique constraints + `INSERT` conflict handling (Prisma `P2002` catch equivalent to `ON CONFLICT DO NOTHING`), not read-then-write; first→process, duplicate→ignore, concurrent 5 identical → 1 effect (1 transaction +1, 1 event, 4 duplicates)
- [x] Webhook signature validation: never trusts frontend status, `verifyWebhookSignature` with secret, secrets never logged/exposed, `timingSafeEqual`
- [x] Payment retrieval (`GET /api/v1/payments/:id`, `payment:read`): uuid params, tenant-scoped `where {id, tenantId}` 404 for other tenant, never exposes secrets, includes `transactions`/`refunds`/`order`
- [x] Refunds (`POST /api/v1/payments/:id/refund`, `payment:refund`): strict `amount` decimalString/`reason` max 500, requires `COMPLETED`/`PARTIALLY_REFUNDED` else 400, `refundable = amount - SUM(COMPLETED refunds)` cents, excessive 400 `EXCESSIVE_REFUND`, `SELECT ... FOR UPDATE` + re-check inside tx, creates `REFUND` COMPLETED + `REFUND` transaction, updates `PARTIALLY_REFUNDED` or `REFUNDED`, rollback on failure, audit append-only never overwrite, `Decimal(12,2)` 0.01 precise
- [x] Transactions: `$transaction` for create/confirm/webhook/refund with `SELECT ... FOR UPDATE` row locking, rollback everything on failure, no partial orphan, no `Float` money
- [x] Money: `Decimal @db.Decimal(12,2)` via string `toCents`/`fromCents`, non-negative CHECKs, authoritative server amounts
- [x] Authorization: payment-specific `payment:create|confirm|read|refund` introduced to integrate Phase 10 with existing RBAC (not modifying Phase 05 permissions), plus `authenticate()` JWT + `authorize()` tenant-scoped, webhook signature-based, 401/403 enforced
- [x] Tenant isolation: every operation `where tenantId = req.context.tenantId`, cross-tenant create/read/confirm/refund/webhook 404, manipulated JWT 401, no client `tenantId` trust, partial unique indexes tenant-scoped
- [x] Validation: Zod strict schemas for body/params/query/headers (uuid, decimalString regex, enum, max lengths), strict rejects unknown `amount`/`status`, headers passthrough
- [x] Business-agnostic: payment module knows `Tenant/Order/Payment/Transaction/Refund` only, works for Clothing/Electronics/Cosmetics via generic variants (verified)
- [x] Verification: 40 Phase 10 tests (create/cross-tenant/duplicate, retrieval, confirmation including FAILED/forced status, webhook valid/invalid/malformed/duplicate/concurrent, refunds partial/full/excessive/audit, security/tenant/Decimal), 377 full no regression, lint 0, Prisma valid, 8 migrations, HTTP 201/200/401/403/404/400 verified, concurrent idempotency 5→1

**APIs (Phase 10):**
| Method | Endpoint | Permission | Description |
|--------|----------|------------|-------------|
| POST | `/api/v1/payments/create` | `payment:create` | Create payment (server amount) |
| POST | `/api/v1/payments/confirm` | `payment:confirm` | Confirm (controlled transition) |
| POST | `/api/v1/payments/webhook` | HMAC signature | Provider webhook (idempotent) |
| GET | `/api/v1/payments/:id` | `payment:read` | Get payment |
| POST | `/api/v1/payments/:id/refund` | `payment:refund` | Refund (refundable-balance) |

**Verification:** 40/40 Phase 10, 377/377 full (11 suites), lint 0, Prisma valid, 8 migrations up to date (Phase 10 webhook idempotency `payment_webhook_events`), app startup, provider-neutral abstraction, no Phase 11+ code, roadmap untouched.

---

## Phase 11 — Audit & Activity Logs (COMPLETE & VERIFIED — 35/35, 412/412, 8 migrations — no new migration)

### Audit & Activity Logs
- [x] Reused existing Phase 3 models `audit_logs` / `activity_logs` — no duplicate tables, no new migration; verified via `prisma/schema.prisma:909` `AuditLog`/`ActivityLog` and `migrate status` 8 up to date
- [x] `audit_logs` fields: `tenant_id`, `user_id`, `action` (`AuditAction` enum), `resource`, `resource_id`, `old_value`/`new_value` (jsonb), `ip_address`, `user_agent`, `created_at` `timestamptz(6)`; indexes `tenantId+userId+createdAt`, `tenantId+resource+resourceId`, `tenantId+action+createdAt`, `tenantId+createdAt`
- [x] `activity_logs` fields: `tenant_id`, `user_id`, `action` String, `description`, `metadata` jsonb, `ip_address`, `user_agent`, `created_at` `timestamptz(6)`; indexes `tenantId+userId+createdAt`, `tenantId+action+createdAt`, `tenantId+createdAt`
- [x] Avoid storing secrets — verified, no passwords/hashes/tokens/secrets in DB/responses
- [x] Reusable module `src/modules/audit/` with 6 components: `audit.sanitize.js` (recursive `[REDACTED]` for 27 sensitive keys, Decimal/Date, depth 8), `audit.repository.js` (tenant-scoped `create(tx)`, `list` with filters/pagination/safe sort, `findById`), `audit.service.js` (`AuditService` singleton `logAudit`/`logActivity`/`logAuditAndActivity`, `recordAudit` helper for future modules, `extractAuditContext`), `audit.controller.js` (tenant from `req.context`, returns `data+meta/pagination`), `audit.validation.js` (Zod `AuditAction` enum, pagination, datetime, UUID), `audit.routes.js` (`auditRouter`/`activityRouter` with `authenticate()` + `authorize('audit:read'|'activity:read')` + `validate`)
- [x] Reusable abstraction — future modules log via `auditService.logAudit({...tx})` without direct DB queries from controllers; controllers never contain DB queries, routes never contain business logic
- [x] Sensitive-data protection — recursive sanitization replaces `password`/`passwordHash`/`hash`/`token`/`refreshToken`/`accessToken`/`secret`/`apiSecret`/`webhookSecret`/`providerCredentials`/`authorization`/`cookie`/`clientSecret`/`privateKey`/`seed`/`salt` etc. with `[REDACTED]` before persistence; never blindly serializes `req.body`/`headers`/`user`; verified 35 tests including direct `logAudit` with sensitive `oldValue` → `[REDACTED]`
- [x] Tenant isolation — every audit/activity record tenant-scoped via `req.context.tenantId` (never client `tenant_id`); repositories `where:{tenantId}`; cross-tenant list returns only own tenant; `GET /activity-logs/:id` for other tenant → `404 ACTIVITY_LOG_NOT_FOUND` safe (never leaks); `?tenantId=` query ignored
- [x] `GET /api/v1/audit-logs` — `authenticate()`, `authorize('audit:read')`, tenant-scoped, pagination `page`1/`limit`20/max100, filters `action` (enum `CREATE|UPDATE|...`)|`resource`|`resourceId`|`userId`|`from`/`to` ISO datetime, `sortBy`/`sortOrder` whitelist, `400` on invalid, returns `{success:true, data, meta, pagination, message}`, no secrets
- [x] `GET /api/v1/activity-logs` — `authenticate()`, `authorize('activity:read')`, tenant-scoped, pagination, filters `action` (string)|`userId`|`from`/`to`, same response conventions
- [x] `GET /api/v1/activity-logs/:id` — `authenticate()`, `authorize('activity:read')`, `validate` UUID, tenant ownership check → `404` if other tenant, never leaks existence, returns `{success:true, data}` without secrets
- [x] RBAC permissions `audit:read` (`audit:read`) and `activity:read` (`activity:read`) — upserted in `prisma/seed.js` `SYSTEM_PERMISSIONS`, linked `admin` all / `manager` most / `member` read-only; existing Phase 5 permissions not modified/renamed/removed; unauthorized `403`, unauth `401`
- [x] Integrated mutations (small justified set, preserves contracts): `PATCH /api/v1/users/:id` → `UPDATE user` audit (`oldValue` allowed fields, `newValue` changes) + `user.update` activity; `DELETE /api/v1/users/:id` → `DELETE user`; `POST /api/v1/orders` → `CREATE order` + `order.create`; `PATCH /api/v1/orders/:id/status` → `UPDATE order` `{status}` + `order.status_update`; `POST /api/v1/orders/:id/cancel` → `UPDATE order` to `CANCELLED` + `order.cancel`; each via `service` with `auditContext {actorUserId, ipAddress: req.ip|x-forwarded-for, userAgent}` from controller
- [x] Transaction behavior — each mutation + its audit/activity in same `prisma.$transaction` (`users.service.js:update/delete`, `orders.service.js:create/updateStatus/cancel`); success together, audit failure rolls back mutation, mutation rollback (e.g., `INSUFFICIENT_STOCK` 400) leaves no audit (verified counts unchanged); order `SELECT ... FOR UPDATE` inventory workflow retains retry/row-locking, audit participates atomically
- [x] Audit consistency — no audit claiming successful mutation if underlying rolled back; no mutation commits while required audit silently fails
- [x] Pagination/indexing — sensible tenant-scoped indexes reused from Phase 3 (`tenantId+createdAt`, `tenantId+resource+resourceId`, `tenantId+action+createdAt`); pagination capped 100, no over-indexing
- [x] Payment mutations not currently audited — documented limitation, not claimed
- [x] ISO datetime filters supported, free-form activity `action`, audit `action` enum-limited, IP via `req.ip`/`x-forwarded-for` depends on `TRUST_PROXY`
- [x] Testing — `tests/integration/phase11-audit.test.js` 35 tests: auth/unauth 401, unauthorized 403, tenant isolation (A reads A, B reads B, cross 404, client tenantId ignored), validation (malformed UUID, invalid pagination/filters), pagination/meta, no sensitive data, sanitization `[REDACTED]`, mutation audit/activity creation with correct `tenantId`/`userId`/`action`/`resource`/`resourceId`/`timestamps`/`ip`/`userAgent`, rollback leaves no audit, API format, safe 404; full regression `412 passed (12 suites)` actually executed, not expected
- [x] Verification — `npm run lint` 0 errors, `npx prisma validate` valid, `migrate status` 8 up to date (no new migration), startup/health `GET /health` 200, HTTP `GET /audit-logs` 200 tenant-scoped, cross 404, invalid 400 via supertest

**APIs (Phase 11):**
| Method | Endpoint | Permission | Description |
|--------|----------|------------|-------------|
| GET | `/api/v1/audit-logs` | `audit:read` | List audit logs (tenant-scoped, paginated, filtered) |
| GET | `/api/v1/activity-logs` | `activity:read` | List activity logs (tenant-scoped, paginated, filtered) |
| GET | `/api/v1/activity-logs/:id` | `activity:read` | Get activity log by ID (tenant-scoped, 404 if other tenant) |

**Verification:** 35/35 Phase 11, 412/412 full (12 suites), lint 0, Prisma valid, 8 migrations up to date (no new Phase 11 migration), app startup, HTTP 200/401/403/404/400 verified, tenant isolation both directions, sanitization `[REDACTED]`, atomic `$transaction`, no regressions, roadmap untouched.

---

## Phase 12 — Notifications (COMPLETE & VERIFIED — 53/53, 465/465, 8 migrations — no new migration)

### Notifications Domain
- [x] Reused existing Phase 3 models `notifications`/`notification_preferences`/`notification_templates` and enums `NotificationType`/`NotificationChannel` — no duplicate tables, no new migration; verified via `prisma/schema.prisma:854` `Notification`/`NotificationPreference`/`NotificationTemplate` and `migrate status` 8 up to date
- [x] `notifications` fields: `tenant_id` FK CASCADE, `user_id` nullable (null = tenant-wide), `type` (`INFO`/`SUCCESS`/`WARNING`/`ERROR`), `title` 1–255, `message` 1–2000, `channel` (`IN_APP`/`EMAIL`/`SMS`/`PUSH`), `referenceType`/`referenceId` nullable, `isRead` default false `readAt` nullable, `metadata` jsonb `@default("{}")`, `createdAt` `timestamptz(6)`; indexes `tenantId+userId+isRead`, `tenantId+createdAt`, `tenantId+referenceType+referenceId`
- [x] `notification_preferences` fields: `tenant_id` FK CASCADE, `user_id`, `channel`, `isEnabled` default true, timestamps `timestamptz(6)`; `@@unique([tenantId, userId, channel])`, `@@index([tenantId, userId])`
- [x] `notification_templates` fields: `tenant_id`, `name`, `channel`, `subject` nullable, `body`, `variables` jsonb, `isActive` default true; `@@unique([tenantId, name, channel])` — reused, no Phase 12 API

### Notification Module Layers
- [x] Module `src/modules/notifications/` with 5 components: `notifications.repository.js` (`NotificationRepository` tenant/user-scoped `list` with `OR(userId,null)` + pagination + filters + safe sort, `findById`/`markAsRead`/`markAllAsRead`/`create`, `NotificationPreferenceRepository` `list`/`ensureDefaults`/`upsert`/`bulkUpdate`), `notifications.validation.js` (Zod `NotificationType`/`NotificationChannel` enums, `listNotificationsQuerySchema` pagination/defaults, `markReadParamsSchema` UUID, `patchPreferencesSchema` flat + aliases + `preferences` wrapper partial strict + refine at-least-one), `notifications.service.js` (`NotificationService` singleton `notificationService` with `createNotification`/`notify`/`dispatchViaChannel` + `list`/`markAsRead`/`markAllAsRead`/`getPreferences`/`updatePreferences`, constants `NOTIFICATION_CHANNELS`/`NOTIFICATION_TYPES`, `normalizePreferencePayload`), `notifications.controller.js` (5 handlers tenant/user from `req.context` → service → `{success,data,meta/pagination,message}`), `notifications.routes.js` (`notificationsRouter` `GET /` + `POST /read-all` + `PATCH /:id/read` with `authenticate()` + `authorize('notification:read'|'notification:update')` + `validate`; `notificationPreferencesRouter` `GET /` + `PATCH /` same guards) mounted in `src/app/routes.js` as `/api/v1/notifications` and `/api/v1/notification-preferences`
- [x] Preserves `Route → Controller → Service → Repository → Database`; reuse of `authenticate`, `authorize`, `error-handler`, `AppError`, tenant context, pagination conventions

### Five APIs (Phase 12)
- [x] `GET /api/v1/notifications` — `authenticate()`, `authorize('notification:read')`, tenant/user-scoped, pagination `page`1/`limit`20/max100, filters `isRead` bool/`type` enum/`channel` enum, newest-first `createdAt desc`, returns `{success:true, data, meta, pagination, message}`, no secrets
- [x] `PATCH /api/v1/notifications/:id/read` — `authenticate()`, `authorize('notification:update')`, `validate` UUID, tenant/user ownership check `where {id, tenantId, OR(userId,null)}` → `404 NOTIFICATION_NOT_FOUND` if other tenant, marks `isRead:true`+`readAt:now`, idempotent (already-read second returns same), ignores mass-assignment `title`/`message`/`tenantId` in body
- [x] `POST /api/v1/notifications/read-all` — `authenticate()`, `authorize('notification:update')`, `updateMany where {tenantId, OR(userId,null), isRead:false}` → `{updated: count}`, idempotent (`0` second time), tenant-isolated (A's does not affect B's unread)
- [x] `GET /api/v1/notification-preferences` — `authenticate()`, `authorize('notification:read')`, tenant/user-scoped, `ensureDefaults` creates 4 missing channels default `true`, returns 4 rows ordered `channel ASC`, no secrets
- [x] `PATCH /api/v1/notification-preferences` — `authenticate()`, `authorize('notification:update')`, `validate` at-least-one field, accepts flat `IN_APP`/`EMAIL`/`SMS`/`PUSH` or aliases `inApp`/`email`/`sms`/`push` or wrapper `{preferences:{IN_APP,...}}` partial strict, `normalizePreferencePayload` + `bulkUpdate` upsert per `tenantId_userId_channel`, returns full 4 after, invalid empty/unknown → `400`, unknown flat stripped→`400` via refine, protected `tenantId`/`userId`/`createdAt` injected ignored not applied

### Pagination / Filtering
- [x] Pagination on `GET /notifications`: `page` default1, `limit` default20 capped 100, `meta`/`pagination` `{page,limit,total,totalPages}`, newest-first `createdAt desc` verified
- [x] Filtering: `isRead` boolean, `type` enum, `channel` enum — each tenant-scoped `where` clause, verified `?type=INFO` returns only INFO, `?channel=EMAIL` only EMAIL, `?isRead=false` only unread, invalid pagination/enum → `400`
- [x] Preferences listing not paginated — always 4 channels

### Read / Read-All Behavior
- [x] Mark one read idempotent: first `PATCH` → `isRead:true` `readAt` set, second identical `200` same state not error; `404` if not found or other tenant's (safe, not leak); `400` if `not-a-uuid`
- [x] Read-all idempotent: `POST /read-all` marks all visible unread, returns `{updated: n}`, repeated → `{updated:0}` safe; respects visibility `OR(userId,null)` and tenant scope, does not affect other tenant's unread count verified
- [x] Both via `update`/`updateMany` with `isRead`/`readAt` only — no arbitrary field mass-assignment

### Preferences
- [x] Defaults: `ensureDefaults` creates missing channels `isEnabled:true` via `createMany skipDuplicates`; `GET` always 4 `EMAIL`/`IN_APP`/`PUSH`/`SMS` sorted
- [x] Updates/upserts: `PATCH` flat or wrapper `{preferences:{}}`, partial (only provided channels updated), strict on `preferences.INVALID` → `400 Unrecognized key`, empty body or only unknown flat → `400 At least one preference...`
- [x] Tenant/user-scoped visibility: `GET`/`PATCH` use `where {tenantId, userId}` from `req.context`, not client body; verified A patch does not affect B, query `tenantId` injection ignored

### Four Channels
- [x] `IN_APP`/`EMAIL`/`SMS`/`PUSH` as enum values (`NotificationChannel`) — channel per notification and per preference, verified service `createNotification` supports all 4, concept only, no external provider delivery (no SendGrid/Twilio/Firebase/SES/OneSignal SDK), `dispatchViaChannel` is placeholder

### Provider-Independent Service Abstraction
- [x] `NotificationService` abstraction `createNotification` (validates `tenantId` required, `title`/`message` required 1–255/1–2000, `type`/`channel` enums, sanitizes `metadata` object, creates tenant-scoped row; accepts optional `tx`), `notify` (creates then checks preference for `channel !== IN_APP` — if disabled still returns but skips dispatch), `dispatchViaChannel` (no-op for external in Phase 12, in-app is DB record, future will enqueue/emit/call provider), `list`/`markAsRead`/`markAllAsRead`/`getPreferences`/`updatePreferences`; future modules call without knowing provider implementation; no provider SDKs added

### RBAC
- [x] RBAC permissions `notification:read` (`notification:read`) and `notification:update` (`notification:update`) — upserted in `prisma/seed.js` `SYSTEM_PERMISSIONS` (now 38 total, admin 38 / manager 34 / member 11), linked via `role.create`/`rolePermission.create` in tests and seed; existing Phase 5 permissions not modified/renamed/removed; `authorize('notification:read')` for `GET`s, `authorize('notification:update')` for `PATCH`/`POST read-all`/`PATCH preferences`; verified unauth `401`, insufficient `403` (viewer with only `audit:read` → 403 for all 5), authorized `200`
- [x] Document exactly which permissions are used (see table above)

### Tenant Isolation
- [x] Every tenant-owned notification/preference query tenant-scoped via `req.context.tenantId` (never client `tenantId`/`tenant_id` query/body), preferences strictly `where {tenantId, userId}`, notifications `where {tenantId, OR(userId,null)}`; verified `Tenant A → Tenant A notification = allowed`, `Tenant A → Tenant B notification = blocked 404`, `Tenant B → Tenant A blocked 404`, list no overlap, client-supplied tenant IDs ignored (still returns only A's), preferences tenant isolation, notification 5-case + preference isolation
- [x] Cross-tenant access fails safely (`404 NOTIFICATION_NOT_FOUND`/`ACTIVITY_LOG_NOT_FOUND` style, not `403` leak), no cross-tenant influence via `?tenantId=` query or `tenantId` body injection (ignored)

### Validation / Security
- [x] Zod validation for notification IDs UUID `400`, pagination `400` (page -1/limit 9999 → 400), filters `type`/`channel` enum `400`, preferences `400` on empty/unknown channels, at least-one-field refine `400`; mass-assignment protection: `PATCH /:id/read` body `title`/`message`/`tenantId` stripped `isRead` only via service, `PATCH /preferences` `tenantId`/`userId`/`createdAt` ignored; sensitive-data protection: list contains no `password`/`refresh`/`secret` (verified), safe errors `404`/`400`/`401`/`403` with `requestId`, no stack traces; never trusts `tenant_id`/`user_id` from body/query/params

### Tests and Verification
- [x] Phase 12 tests: 53/53 passed in `tests/integration/phase12-notifications.test.js` (auth 5, authz 6, tenant isolation 7, list 8, mark-one 6, mark-all 3, preferences 9, service 6, security 3)
- [x] Full regression: 465/465 passed, 13/13 suites, lint 0 errors, Prisma validate passed, migrations 8 up to date (no new Phase 12 migration), startup passed, HTTP verification passed for all five endpoints (200 success + 400 validation + 401 unauth + 403 authz + 404 not-found/cross-tenant + tenant isolation + idempotency)
- [x] Verification covers: unauthenticated 401 for all 5, authorized 200, unauthorized 403, tenant isolation 404, pagination/filtering/newest-first, mark-one read + already-read idempotent, mark-all read + repeated 0, preferences defaults 4 + updates/upserts via flat/wrapper, validation failures, unsupported fields 400, repeated update idempotent, service abstraction, mass-assignment guard, response shape, newest-first

**APIs (Phase 12):**
| Method | Endpoint | Permission | Description |
|--------|----------|------------|-------------|
| GET | `/api/v1/notifications` | `notification:read` | List notifications (tenant/user-scoped, paginated, filters isRead/type/channel, newest-first) |
| PATCH | `/api/v1/notifications/:id/read` | `notification:update` | Mark one notification as read (idempotent, 404 if other tenant, 400 if invalid UUID) |
| POST | `/api/v1/notifications/read-all` | `notification:update` | Mark all visible unread as read (idempotent, returns {updated}, tenant-isolated) |
| GET | `/api/v1/notification-preferences` | `notification:read` | List preferences (4 channels, tenant/user-scoped, defaults) |
| PATCH | `/api/v1/notification-preferences` | `notification:update` | Update preferences (upsert IN_APP/EMAIL/SMS/PUSH, flat or {preferences:{}}) |

**Verification:** 53/53 Phase 12, 497/497 full with --testTimeout=15000 (14 suites), lint 0, Prisma valid, 8 migrations up to date (no new Phase 12 migration — reused Phase 3 models), app startup, HTTP 200/401/403/404/400 verified for all five endpoints, tenant/user isolation both directions, idempotent read/read-all, preferences defaults/upserts, provider-independent service abstraction with `createNotification`/`notify`/`dispatchViaChannel`, channel concepts `IN_APP/EMAIL/SMS/PUSH` without provider delivery, no regressions, roadmap untouched.

---

## Phase 13 — WebSockets / Real-Time

### Overview
Phase 13 adds Socket.IO real-time operations as a provider-independent, tenant-aware layer coexisting with the existing Express HTTP server. Reuses existing JWT authentication, never trusts client-supplied `tenantId`/`userId`, uses in-memory single-instance model (Redis pub/sub deferred to Phase 14).

### Files

| File | Purpose |
|------|---------|
| `src/realtime/realtime.service.js` | Abstraction `REALTIME_EVENTS`, `ALLOWED_EVENTS`, `setIoInstance`/`getIoInstance`, `sanitizePayload` (recursive, 27+ keys, stack stripped), `emitRealtime(event,payload,{tenantId,userId})` → `io.to(tenant:{tenantId}\|user:{userId}).emit(event,envelope)`, helpers `emitOrderCreated`/`emitOrderUpdated`/`emitInventoryLowStock`/`emitPaymentCompleted`/`emitNotificationCreated`, `sanitizeForTest` |
| `src/realtime/socket.auth.js` | `socketAuthMiddleware`, `extractToken` (auth.token Bearer/raw, header Authorization Bearer, query.token), `verifyAccessToken` + `TokenExpiredError`/`JsonWebTokenError` → `TOKEN_EXPIRED`/`INVALID_TOKEN`, required claims `sub`/`tenantId`/`sessionId`, `AuthRepository.findUserByIdAndTenant` + `ACTIVE` user/tenant `ACTIVE\|TRIAL`, server-derived `socket.context={userId,tenantId,sessionId,email}` |
| `src/realtime/socket.server.js` | `createSocketServer(httpServer)` `{cors:{origin:env.corsOrigins}, serveClient:false}`, `io.use(socketAuthMiddleware)`, auto-join `tenant:{tenantId}`+`user:{userId}`, emit `connected` `{userId,tenantId,rooms}`, guarded `join`/`subscribe` (allowed Set only own rooms → else `FORBIDDEN` ack + `error` emit, blocks arbitrary), `disconnect`/`error`/`connection_error` logging, `closeSocketServer`, `setIoInstance` |
| `src/app/server.js` | Modified: `initSocketIO()` before `listen`, `ioInstance` export, `closeSocketServer` in `shutdown` (`SIGTERM`/`SIGINT`) |
| `src/modules/orders/orders.service.js` | Modified: `emitOrderCreated` after `create` txn, `emitOrderUpdated` after `updateStatus`/`cancel` (minimal `{id,tenantId,status,...}`) |
| `src/modules/inventory/inventory.service.js` | Modified: `emitInventoryLowStock` after `adjust`/`transfer` when `quantity <=10` (`LOW_STOCK_THRESHOLD=10`, minimal `{productVariantId,warehouseId,quantity,threshold}`) |
| `src/modules/payments/payments.service.js` | Modified: `emitPaymentCompleted` after `confirm` → `COMPLETED` and webhook `payment.succeeded` → `COMPLETED` |
| `src/modules/notifications/notifications.service.js` | Modified: `emitNotificationCreated` after `create` (user room if `userId` else tenant room, minimal `{id,tenantId,userId,type,title,message,channel}`) |
| `package.json` / `package-lock.json` | Added `socket.io@^4.8.1` + `socket.io-client@^4.8.1` |
| `tests/integration/phase13-realtime.test.js` | 32 dedicated Phase 13 tests (real `socket.io-client` on ephemeral `http.createServer(app)`) |

### Socket.IO Integration

- `http.createServer(app)` + `createSocketServer(server)` with CORS `env.corsOrigins`, HTTP and Socket.IO coexist, Express not replaced, REST unchanged.
- `initSocketIO` exported for testability; `setIoInstance` decouples business services from Socket.IO internals.
- Shutdown closes `io` before HTTP/http.
- Verified via ephemeral port in tests: `GET /health` 200 while Socket.IO listening.

### Authentication

- Reuses `verifyAccessToken` (HS256, `issuer:pulseops`, `audience:pulseops-api`, `JWT_ACCESS_SECRET` min 32 in production, test default `test-access-secret-min-32-chars-long-for-testing`).
- Same security properties as HTTP `authenticate()`: signature, expiry, required claims `sub`/`tenantId`/`sessionId`, user existence/status `ACTIVE`, tenant `ACTIVE|TRIAL`.
- `extractToken` supports `auth.token` (Bearer/raw), `headers.authorization` Bearer, `query.token` fallback (less secure).
- Never trusts client `tenantId`/`userId`; `socket.context` server-derived.
- `Bearer` prefix handled; invalid/expired/malformed → `connect_error` (`UNAUTHORIZED`/`TOKEN_EXPIRED`/`INVALID_TOKEN`).

### Tenant-Aware Rooms

- `tenant:{tenantId}` and `user:{userId}`; auto-joined on `connection`.
- `Tenant A user 123` → `tenant:tenant-A` + `user:user-123`; never `tenant:tenant-B` or `user:other`.
- Guarded `join`/`subscribe`: only `allowedRooms = Set([tenant:own, user:own])`; else `FORBIDDEN`.

### Five Events

| Event | Audience | Trigger |
|-------|----------|---------|
| `order.created` | `tenant:{tenantId}` | `OrderService.create` after txn |
| `order.updated` | `tenant:{tenantId}` | `OrderService.updateStatus` / `cancel` |
| `inventory.low_stock` | `tenant:{tenantId}` | `InventoryService.adjust`/`transfer` when `after <=10` |
| `payment.completed` | `tenant:{tenantId}` | `PaymentService.confirm` → `COMPLETED` + webhook `succeeded` |
| `notification.created` | `user:{userId}` if `userId` else `tenant:{tenantId}` | `NotificationService.createNotification` |

Routing: `if(userId) io.to(user:{userId}) else io.to(tenant:{tenantId})`; envelope `{event,data:sanitized,tenantId,timestamp}`; `ALLOWED_EVENTS` whitelist; null `io` safe.

### Event Tenant Isolation

- Tenant-scoped events only to correct `tenant:{tenantId}` room; user-specific only to correct `user:{userId}`.
- Never `io.emit()` globally; never emit Tenant A data to B.
- Verified: `A1→tenant:A ALLOWED`, `A1→user:A1 ALLOWED`, `A1→tenant:B BLOCKED`, `A1→user:B1 BLOCKED`, `B1→tenant:B ALLOWED`, `B1→tenant:A BLOCKED`; actual delivery `A cannot receive B events`, `B cannot receive A`, `A1 cannot receive B1 private`, `A2 cannot receive A1 private but both receive tenant broadcast`, forged payload `tenantId` ignored.

### Payload Security

- Minimal payloads only (ids, status, amounts, etc., not full DB rows).
- Never emits: `password`, `passwordHash`, `refreshToken`, `accessToken`, `secret`, `webhookSecret`, `providerCredentials`, `authorization`, `cookie`, `stack`.
- Recursive `sanitizePayload` strips `FORBIDDEN_KEYS` + `password|secret|credential|authorization|cookie|token` substring, removes `stack`, recurses nested.
- Verified via `order.created` with `passwordHash`/`nested.passwordHash` stripped while `safeField` kept.

### Lifecycle / Error Handling

- `connection` → log + auto-join + `connected` ack.
- `authentication failure` → `connect_error` with `code`, warn logged, no stack to client.
- `disconnect` → log `reason`.
- `error`/`connection_error` → warn.
- `join`/`subscribe` guarded `FORBIDDEN`.
- Clean shutdown `io.close()` in `server.shutdown`.

### Testing (32/32)

- Auth 7: authenticated success, missing/invalid/expired/malformed rejected, Bearer prefix, header auth.
- Rooms 8: matrix + arbitrary/forged/subscribe blocked.
- Isolation 5: A/B both directions, user private, A1/A2 share vs private, forged routing.
- Events 6: 5 events + tenant-wide notification broadcast.
- Sensitive 3: sanitization, `sanitizeForTest`, notificationService no leak.
- HTTP 1: health + notifications still 200.
- Unknown 2: `unknown.event`/`missing audience` false.
- Real `socket.io-client` integration, not mocks, with `waitForEvent`/`waitNoEvent`.

### Verification

- `npm test -- tests/integration/phase13-realtime.test.js` → 32/32 (10–15s)
- `npm test -- --testTimeout=15000` → 497/497 (14 suites) — default 5000ms hook timeout flaky in Phase 11/12 sequential `beforeAll` (argon2), isolated 35/35 & 53/53 pass.
- `npm run lint` → 0 errors, `npx prisma validate` → valid, `npx prisma migrate status` → 8 up to date (no new Phase 13 migration), ephemeral `http.createServer` + `GET /health` 200 + authenticated socket ok + unauth/expired/invalid rejected + tenant/user isolation + 5 events.

### Database

- No Phase 13 tables, no migration; 8 migrations up to date; in-memory only.

### Known Limitations (Actual)

- In-memory/single-instance; Redis pub/sub deferred to Phase 14.
- `low_stock` threshold hard-coded `10`; low-stock from `adjust`/`transfer` paths only.
- `payment.completed` from `confirm`/`webhook COMPLETED` only.
- No persistent socket session table.
- `query.token` fallback exists and is less secure than `auth.token`/header.

### What is NOT Implemented (Future Phases)

The following are explicitly **NOT** implemented as of Phase 13 completion (WebSockets COMPLETE):
- Redis Caching — cache-aside/TTL/invalidation/pub/sub (Phase 14)
- BullMQ / Background Jobs — queues/workers/retries/DLQ (Phase 15)
- External API Integrations — external providers (Phase 16) — no Redis pub/sub, no BullMQ, no external provider delivery as part of Phase 13

---

## Phase 14 — Redis Caching (COMPLETE & VERIFIED — 27/27, 524/524, 8 migrations — no new migration, HUMAN VERIFICATION: PASS)

### Objective
Introduce Redis for performance and shared state as a cache layer with cache keys, TTL, invalidation, cache-aside strategy, safe serialization, and cache failure fallback. Redis is optimization/shared-state, never authoritative — PostgreSQL remains source of truth; core DB operations must continue when Redis unavailable.

### Files

| File | Purpose |
|------|---------|
| `src/common/cache/cache.config.js` | `CACHE_TTL` TENANT 300 / TENANT_SETTINGS 300 / PERMISSIONS 300 / PERMISSIONS_USER 300 / PRODUCT_LIST 60 + `CACHE_PREFIX pulseops:v1` |
| `src/common/cache/cache.keys.js` | `tenantKey`, `tenantSettingsKey`, `permissionsListKey`, `userPermissionsKey`, `productListKey` (normalized params → sorted attributeFilters → JSON → sha256 16 hex), `productListPattern`, `sanitizeId` regex |
| `src/common/cache/cache.service.js` | `CacheService` `get`/`set`/`del`/`delByPattern` (SCAN MATCH COUNT 100)/`getOrSet` with JSON, `stripSensitive` (password/passwordHash/token/secret/credential/apiKey), `logger.warn` fallback, `getRedis()` via `getRedisClient()` |
| `src/modules/tenants/tenants.service.js` | Modified: `getById` cache-aside `tenantKey`+`tenantSettingsKey`, `getSettings` helper, `update`/`delete` `del` both after commit |
| `src/modules/permissions/permissions.service.js` | Modified: `list` cache-aside `permissionsListKey`, `invalidateTenantPermissions` helper |
| `src/modules/products/products.service.js` | Modified: `list` cache-aside `productListKey`, `invalidateProductListCache` `delByPattern` after create/update/delete/setCategories |
| `src/modules/auth/authorization.middleware.js` | Modified: `getUserPermissions` cache-aside `userPermissionsKey` (300s), `authorize` delegates to it, `invalidateUserPermissionsCache`/`invalidateTenantPermissionsCache` helpers |
| `tests/integration/phase14-redis-caching.test.js` | 27 tests with in-memory FakeRedis (Map + TTL + scan + simulateFailure) |

Reused existing `ioredis`/`src/config/redis.js` (lazyConnect, maxRetriesPerRequest 1, enableOfflineQueue false, PING health); no new dependency, no new DB tables/migration.

### Redis Architecture

* **Reuse:** `getRedisClient()` singleton from `src/config/redis.js` (ioredis 6, `REDIS_URL` Zod url optional, `connectRedis` lazy, `redisHealthCheck` PING, `disconnectRedis` safe for `wait`). `CacheService.getRedis()` calls it or undefined.
* **Abstraction:** `CacheService` never throws to business layer; every `get`/`set`/`del`/`delByPattern` try/catch → `logger.warn` → fallback (null/false/0). `getOrSet` returns `{value,hit}`.
* **Cache-aside:** `GET` → hit return deserialized else miss → `repository.list`/`findById` via Prisma → `SET` with TTL → return. Failures fall back to DB.
* **Serialization:** `JSON.stringify`/`JSON.parse` only; no `eval`.
* **Sensitive sanitization:** `stripSensitive` recurses, drops any key containing `password`/`passwordHash`/`token`/`secret` etc.; verified.
* **TTL:** Fixed constants 300s tenant/settings/permissions and 60s product lists (sensible, all >0 <3600, product <600 verified; expiration 1s test with 1100ms proves stale → fresh).
* **Keys:** `pulseops:v1` prefix, tenant-safe `sanitizeId` regex, no user-controlled arbitrary keys, no secrets in keys, product hash includes all relevant params (page/limit/search/status/category/minPrice/maxPrice/sku/barcode/sortBy/sortOrder/attributeFilters sorted → 8 distinct hashes verified), `productListPattern` tenant-scoped.
* **Degraded mode:** Redis is optimization not authoritative; degraded `FAIL_ON_DEPENDENCY_ERROR` still allows `GET /health` 200 and DB ops 200 when `GET /health/redis` 503.

### Cached Domains (justified three)

| Domain | Service method | Key | TTL |
|--------|---------------|-----|-----|
| Tenant settings | `TenantService.getById` (includes settings) + `getSettings` | `pulseops:v1:tenant:{tenantId}` + `pulseops:v1:tenant:{tenantId}:settings` | 300s |
| Permissions | `PermissionService.list` + `getUserPermissions(userId,tenantId)` | `...:permissions:list` / `...:permissions:user:{userId}` | 300s |
| Product lists | `ProductService.list(tenantId,options)` | `...:products:list:{sha256(payload).slice(0,16)}` | 60s |

Dashboard metrics not cached — no dashboard exists, intentionally not claimed.

### Cache Keys / TTL / Serialization

* Deterministic tenant isolation: different `tenantId` → different keys; test proves no collision.
* Product key includes every filter influencing result (pagination, search, status, category, price, sku, barcode, sort, attributeFilters sorted); hash 16 hex stable.
* TTL constants in `cache.config.js` (not env-overridable) — documented.
* Safe JSON, sensitive fields removed before SET, keys contain no secrets, errors redacted.

### Cache Invalidation

* **Tenant:** `update`/`delete` commit Postgres first then `del(tenantKey)` + `del(tenantSettingsKey)`; failure logged not rolled back.
* **Permissions:** explicit/manual helpers `invalidateTenantPermissions` (del list), `invalidateUserPermissionsCache` (del user), `invalidateTenantPermissionsCache` (delByPattern `...:permissions:user:*`).
* **Product lists:** after every `create`/`update`/`delete`/`setCategories` → `invalidateProductListCache` → `delByPattern(productListPattern(tenantId))` (SCAN COUNT 100 loop until cursor 0, then DEL). Transaction/commit before invalidation; failure logged not rolled back.
* No `FLUSHALL`, no Postgres transaction wrapping Redis.
* PostgreSQL remains authoritative.

### Security

* Tenant isolation via `tenantId` in key (never `Tenant A → B cache`).
* No client-controlled tenant scope; `tenantId`/`userId` from `req.context` (JWT `authenticate`), `sanitizeId` validates.
* Sensitive values excluded (`stripSensitive`), no secrets in keys, `logger` redacts, no stack in production responses.
* Redis errors `logger.warn` not leaked.
* RBAC preserved: `authorize` still checks `tenantMembership ACTIVE` then cached `getUserPermissions`; Redis down still 403/200 correctly.

### Redis Failure / Degraded Mode

Core PostgreSQL-backed operations continue when Redis unavailable (GET fail → null → DB, SET fail → return DB result, DEL fail → logged). Verified HTTP with `disconnectRedis` still `GET /products` 200. Redis is optimization/shared-state layer.

### Testing (27/27)

* **CacheService 10:** miss null, hit without loader, miss loads+sets, invalidation deletes, expiration 1s→null then fresh, GET/SET/DEL unavailable fallback, does not cache sensitive fields, delByPattern.
* **Keys 4:** tenant isolation distinct, product list key includes all params (8 hashes), attribute filters affect key, no secrets.
* **TenantService 4:** hit avoids DB, miss queries+stores, Redis failure→DB, invalidation after update removes both keys, failure does not roll back.
* **PermissionService 3:** hit avoids DB, Redis failure→DB, SET failure does not fail.
* **ProductService 5:** hit/miss/different query, mutation invalidates, GET failure→DB, SET failure continues, tenant isolation.
* **TTL 1:** constants >0 <3600 product <600.
* Plus HTTP verification via real ioredis: miss stores 1 key, hit, tenant B 0 isolated, mutation clears 0, redis-down fallback 200; regression full 524/524 (15 suites) with open-handle warning (not failure).

### Verification

```
npm test -- --testTimeout=15000 → 15 suites 524/524 (Phase 14 27 added)
npm test -- tests/integration/phase14-redis-caching.test.js → 27/27
npm run lint → 0 errors
npx prisma validate → valid
npx prisma migrate status → 8 migrations up to date
ioredis PONG, GET /health 200, GET /health/redis 200/503, product miss→hit, invalidation, isolation, redis-down 200
```

### Database

No Phase 14 migration/tables; 8 migrations remain up to date. Reuses existing `TenantSettings` via `tenant.settings` include; `warehouse_inventory` mirror unchanged.

### Known Limitations (Actual)

* Only three cache candidates currently cached; dashboard metrics/frequently accessed configuration not cached (no dashboard yet).
* TTLs are fixed constants rather than environment-overridable.
* Permission invalidation relies on explicit/manual helpers (no automatic DB trigger on `rolePermission` writes).
* Product pattern invalidation uses `SCAN MATCH COUNT 100` + `DEL`; may become more expensive for very large tenants with many distinct list hashes.
* Single-instance Redis (single ioredis client, no cluster); no Redis pub/sub used (Phase 13 deferred pub/sub not expanded); no distributed locking; no stale-while-revalidate; no BullMQ.

### What is NOT Implemented (Future Phases as of Phase 14)

Phase 15 BullMQ/background jobs (queues/workers/retries/DLQ) was NOT implemented as of Phase 14 — now COMPLETE in Phase 15 (see below). As of Phase 14, also NOT implemented: Phase 16 External Integrations (S3/storage, email/SMS/push providers, shipping/maps), Phase 17 API Orchestration (`dashboard/overview`), Phase 18 Analytics (`analytics/*`), Phase 19 Performance Optimization (strictly measuring not claiming broad gains), Phase 20 Security Hardening, Phase 21 Complete Testing, Phase 22 Swagger/OpenAPI, Phase 23 Docker/CI/CD. No BullMQ, no external provider SDKs, no dashboard metrics caching, no S3.

### Phase 14 Status: ✅ COMPLETE AND VERIFIED (HUMAN VERIFICATION: PASS)
All 27 Phase 14 tests, 524/524 full, 15 suites, lint 0, Prisma valid, 8 migrations up to date (no new Phase 14 migration), app startup + Redis PONG + HTTP health + cache miss/hit + invalidation + tenant isolation + redis-down fallback + RBAC regression all verified, roadmap untouched. Phase 15 — Background Jobs / BullMQ was NEXT at this point.

---

## Phase 15 — Background Jobs / BullMQ (COMPLETE and VERIFIED — 44/44, 568/568, 8 migrations — no new migration, HUMAN VERIFICATION: PASS)

### Objective
Move slow/non-critical work outside HTTP requests using BullMQ and the existing Redis infrastructure. Architecture `API → Queue → Worker → Processor → Database / External Service`. HTTP validates → enqueues → returns `202` (or `200` fallback when Redis unavailable); worker processes asynchronously.

### Queues (6 abstractions)
- **Real:** `notificationQueue` (`notification`), `cleanupQueue` (`cleanup`), `webhookQueue` (`webhook`)
- **DEFERRED/STUB:** `emailQueue` (`email` — provider deferred to Phase 16), `reportQueue` (`report` — Phase 18), `analyticsQueue` (`analytics` — Phase 18)
- Prefix `pulseops:v1:queue` (`QUEUE_PREFIX`). Verified not separate Redis server or database.

### Real Jobs (3)
- `send-notification` (`notification` queue): `processSendNotification` reuses Phase 12 `NotificationService.createNotification` tenant-scoped; validates `tenantId` server-derived, sanitizes `metadata`, creates `notifications` row; supports `IN_APP`/`EMAIL`/`SMS`/`PUSH` channel, `INFO`/`SUCCESS`/`WARNING`/`ERROR` type.
- `cleanup-expired-tokens` (`cleanup` queue): `processCleanupExpiredTokens` tenant-scoped `deleteMany` where `expiresAt < now` on `refresh_tokens`/`password_reset_tokens`/`email_verification_tokens` (plus old `usedAt` >30d); tenant `null` → global.
- `process-webhook` (`webhook` queue): `processWebhook` preserves payment webhook verification/idempotency — HMAC verified before enqueue (controller `verifyWebhookSignature`) and re-verified in processor via `PaymentService.handleWebhook` with `PAYMENT_WEBHOOK_SECRET`; uses existing `payment_webhook_events` `@@unique([tenantId,eventId])`/`@@unique([eventId])` constraints.

### BullMQ / Redis Architecture
- `bullmq@^5.10.2` (`package.json:22`) + `ioredis@6.0.0`; reuses `REDIS_URL` (Zod url optional, `src/config/env.js`).
- Dedicated connection `src/jobs/connection.js`: `new Redis(REDIS_URL, {maxRetriesPerRequest:null, enableReadyCheck:false})`, separate from cache client (`maxRetriesPerRequest:1` in `src/config/redis.js`).
- Queue prefix `pulseops:v1:queue` (`jobs.config.js`), `DEFAULT_JOB_OPTIONS` per queue, `jobTimeoutMs`.
- Worker lifecycle `src/jobs/workers/index.js`: 6 workers, concurrency webhook 10 / cleanup 1 / others 5, `lockDuration` 30s, handlers `completed`/`failed`/`error`/`stalled` with Pino logs, graceful `Worker.close()`.
- Startup `src/jobs/index.js:initJobs()` → `startWorkers()` before `server.listen`; shutdown `shutdownJobs()` → `stopWorkers()` + `closeAllQueues()` + `disconnectBullMqRedis()` in `src/app/server.js` graceful shutdown (force exit 10s).

### Retry and Backoff
- notification: 3 attempts, exponential 1000ms
- cleanup: 2 attempts, exponential 2000ms
- webhook: 5 attempts, exponential 1000ms
- email: 3/1000, report/analytics: 2/2000. `UnrecoverableError` for permanent 400/401/validation (no retry), transient DB/network retry with exponential backoff. Bounded (<6).

### Failure Handling
- BullMQ failed-job retention 24h (`removeOnFail:{age:86400}`) for all queues; **no separate DLQ** queue implemented.
- Failed jobs observable via BullMQ `failed` state + Pino `Worker emitted failed` logs (`queue, jobId, tenantId, attemptsMade`).

### Idempotency (at-least-once, NOT exactly-once)
- Deterministic jobIds: `notif:<tenant>:<key>` (order `order:<id>`), `webhook:<eventId>`, `cleanup:<tenant>:<date>`. Duplicate `jobId` → `EEXIST` caught as `{duplicate:true}`.
- Processor safeguards: notification recent `tenant+referenceType+referenceId+title` 60s skip; webhook DB unique constraints; cleanup re-delete no-op. Documented at-least-once with idempotent processing.

### Tenant Isolation
- `tenantId` server-derived from `req.context.tenantId` (JWT `authenticate`), never client-trusted; carried in job payload; processors scope all DB ops by `tenantId` (`tenantB` cannot read `tenantA` notification/cleanup/webhook). Cross-tenant isolation tested (44 tests).

### Sensitive-Data Protection
- Guards reject `password`/`passwordHash`/`secret`/`token`/`refreshToken`/`accessToken`/`authorization`/`cookie`/`webhookSecret` in `metadata`/`payload` (recursive check). JWT/refresh/provider secrets never enqueued. Logs via `sanitizeForLog` and `logger` redaction.

### HTTP Behavior
- `REDIS_URL` available → `queue.add` async, returns `202 Accepted` (`POST /payments/webhook` enqueues, `POST /jobs/notifications` 202, `POST /jobs/cleanup` 202).
- Redis unavailable → synchronous fallback processor invoked, may return `200` (`{fallback:true}` or `{data:payment,duplicate}` for webhook). Correctness preserved, can reintroduce latency.

### Payment Webhook Boundary
- `POST /api/v1/payments/webhook` verifies HMAC before `enqueueWebhook`; invalid 401 no job; valid can be queued (`202`); processor re-verifies HMAC; existing `payment_webhook_events` unique constraints remain authoritative; no real external payment provider introduced.

### Order → Notification Integration
- `OrderService.create` after committed transaction fire-and-forget `enqueueNotification({tenantId,userId, orderId, idempotencyKey: 'order:<id>'})` type `SUCCESS`/`IN_APP`/`ORDER`; enqueue failure logged not rolled back.

### Worker Behavior
- 6 workers/queue registrations, concurrency webhook 10 / cleanup 1 / others 5, logging `queue, jobId, tenantId, attempt, durationMs`, `stalled`/`error` handling, graceful `stopWorkers()` allows active jobs to close.

### Testing (Phase 15)
- `tests/integration/phase15-background-jobs.test.js` 44 tests: queue creation (4), enqueueing (5), processor success (4), retry (4), failed/DLQ (2), idempotency (4), tenant isolation (4), sensitive (4), logging (2), shutdown (2), Redis failure (2), regression (3), HTTP (4) — 44/44.
- Full regression 568/568 (16 suites, 524 Phase 1-14 (Phase 14 27/27 unchanged) +44).
- Verification: `node --experimental-vm-modules jest --runInBand --forceExit` 568; `... phase15-background-jobs.test.js --runInBand` 44; `npm run lint` 0 errors; `npx prisma validate` valid; `npx prisma migrate status` 8 up to date (no Phase 15 migration).

### Known Limitations (Actual, Phase 15)
- `email`/`report`/`analytics` are deferred stubs (`{deferred:true}`; no provider SDKs).
- No separate DLQ; failed retention 24h via BullMQ.
- Redis outage → synchronous fallback, can reintroduce HTTP latency.
- Order notification enqueue fire-and-forget; enqueue failure logged not affecting committed order.
- Single-process workers; no horizontal scaling / Redis pub/sub cluster.
- Cleanup manual/on-demand (`POST /jobs/cleanup` tenant-scoped, `cleanup:<tenant>:<date>` jobId); no repeatable/cron schedule.

### What is NOT Implemented (Future as of Phase 15)
Phase 16 (real email/SMS provider, S3/cloud storage provider, real external payment provider, shipping/maps APIs, provider secret management, external adapters) NOT implemented — only `emailQueue` stub. Phase 17 (`dashboard/overview` orchestration) NOT implemented — only `reportQueue` stub. Phase 18 (analytics/reporting `analytics/*`) NOT implemented — only `analyticsQueue` stub. Phase 19+ performance, security hardening, complete testing, Swagger/OpenAPI, Docker/CI/CD remain future. No real providers added to fake completeness.

### Phase 15 Status: ✅ COMPLETE AND VERIFIED (HUMAN VERIFICATION: PASS)
All 44 Phase 15 tests pass, 568/568 full (16 suites, 524 Phase 1-14 (Phase 14 27/27) +44), lint 0, Prisma valid, 8 migrations up to date (no new Phase 15 migration — jobs reuse existing tables), app startup + BullMQ PONG + HTTP health + queue enqueue 202/fallback 200 + worker graceful shutdown all verified, roadmap untouched. Phase 16 — External API Integrations is NEXT.

---

---

## Phase 16 — External API Integrations (COMPLETE & VERIFIED — 58/58, 626/626, 8 migrations — no new migration, HUMAN VERIFICATION: PASS)

### Architecture
- **Layering:** `Controller -> Service -> Integration Adapter -> External API` — provider-independent. Business `Service` (e.g., `EmailService`, injected `paymentProvider`) calls adapter via contract not vendor field names. Adapters (`Mock*` + `Http*`) handle request mapping, timeout via `AbortController` (`fetchWithTimeout`), retry idempotency-aware (`requestWithRetry`), response mapping via `mapProviderResponse`, normalized `IntegrationError`. Env via `src/config/env.js` (`PAYMENT_PROVIDER`/`PAYMENT_PROVIDER_URL`/`PAYMENT_PROVIDER_API_KEY`/`PAYMENT_PROVIDER_TIMEOUT_MS`, `STORAGE_PROVIDER`/`LOCAL_STORAGE_PATH`/`LOCAL_STORAGE_URL`/`S3_BUCKET`/`S3_REGION`/`S3_ENDPOINT`/`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`/`S3_PUBLIC_BASE_URL`/`S3_FORCE_PATH_STYLE`/`STORAGE_TIMEOUT_MS`, `EMAIL_PROVIDER`/`EMAIL_PROVIDER_URL`/`EMAIL_PROVIDER_API_KEY`/`EMAIL_PROVIDER_TIMEOUT_MS`, `SMS_PROVIDER`/`SMS_PROVIDER_URL`/`SMS_PROVIDER_API_KEY`/`SMS_PROVIDER_TIMEOUT_MS`, `SHIPPING_PROVIDER`/`SHIPPING_PROVIDER_URL`/`SHIPPING_PROVIDER_API_KEY`/`SHIPPING_PROVIDER_TIMEOUT_MS`, `MAPS_PROVIDER`/`MAPS_PROVIDER_URL`/`MAPS_PROVIDER_API_KEY`/`MAPS_PROVIDER_TIMEOUT_MS`), never logged/in payloads (logger redact). Tenant isolation via `req.context.tenantId` (keys `tenants/{tenantId}/...`, `assertTenantScopedKey`), SigV4 for S3 (`S3StorageProvider` real REST + `MockS3StorageProvider` test-only), HMAC preserved (`verifyWebhookSignature` `PAYMENT_WEBHOOK_SECRET`).

### Integrations

- [x] **Payment (Mock + Http, charge/refund, idempotency-aware retry, state machine preserved, HMAC preserved):** `MockPaymentProvider` (`charge` `pay_mock_*` `mapProviderResponse('payment')`, `refund` `ref_mock_*`, `shouldTimeout`/`shouldFail` injection, `verifyWebhook` via `verifyWebhookSignature`) + `HttpPaymentProvider` (`baseUrl= PAYMENT_PROVIDER_URL`, `apiKey= PAYMENT_PROVIDER_API_KEY`, `timeoutMs= PAYMENT_PROVIDER_TIMEOUT_MS`, `Authorization: Bearer`, `Idempotency-Key` when `idempotencyKey`, POST `/charges` `{amount,currency,orderId,tenantId}` JSON `requestWithRetry` idempotent when key (503 retry 2 calls) vs `refund` POST `/refunds` no retry (503 1 call), `_ensureConfig` CONFIGURATION 500 when missing, maps `pay_http_*` via `mapProviderResponse`). Factory `createPaymentProvider(PAYMENT_PROVIDER)` mock default else http for http/stripe/adyen. Preserves Phase 10 state machine and HMAC (401 `AUTHENTICATION`). Secrets not logged (`apiKey` not in message/details).
- [x] **Email (Mock + Http, EmailService, BullMQ queue processor->service->adapter, retry):** `MockEmailProvider` (`send {to,subject,html,text,template,variables,tenantId}` `email_mock_*` `sent[]`) + `HttpEmailProvider` (`EMAIL_PROVIDER_URL`/`API_KEY`/`TIMEOUT_MS`, POST `/send` `{to,subject,html,text,template,variables,tenantId}` JSON, `requestWithRetry` false idempotent). `EmailService` (`sendEmail({tenantId,to,subject,html,text,template,variables})` validates `tenantId`/`to`, delegates `provider.send` (no vendor names), logs `tenantId`/`to`/`providerId` only). BullMQ processor `processSendEmail` (`tenantId`/`to`/`subject` validated else `UnrecoverableError` no retry, logs `queue email` `jobId` `tenantId` `to`, `new EmailService().sendEmail` (no `fetch` in processor, delegates to adapter), `isRetryableEmailError` via `IntegrationError.isRetryable` true for TIMEOUT/UNAVAILABLE retry vs permanent no retry, `UnrecoverableError` for 400/401). Queue payload no `apiKey`/`secret`. Factory `createEmailProvider(EMAIL_PROVIDER)` singleton mock default.
- [x] **SMS (Mock+Http):** `MockSmsProvider` (`send {to,message,tenantId}` `sms_mock_*`) + `HttpSmsProvider` (`SMS_PROVIDER_URL`/`API_KEY`/`TIMEOUT_MS`, POST `/send` `{to,message,tenantId}` JSON, `requestWithRetry` no retry, maps `sid`/`id`). Factory `createSmsProvider(SMS_PROVIDER)` mock default.
- [x] **Shipping (Mock+Http getRate/createShipment retry distinction):** `MockShippingProvider` (`getRate {origin,destination,weight,tenantId}` 12.5 USD `eta`, `createShipment {orderId}` `TRK*`) + `HttpShippingProvider` (`SHIPPING_PROVIDER_URL`/`API_KEY`/`TIMEOUT_MS`, `getRate` POST `/rates` `{origin,destination,weight,dimensions,tenantId}` idempotent `retries 2` -> retry on 503 vs `createShipment` POST `/shipments` `retries 0` no retry). Not full domain product (minimal rate/shipment contract).
- [x] **Maps (Mock+Http geocode/reverse):** `MockMapsProvider` (`geocode {address}` lat/lng, `reverseGeocode {lat,lng}`) + `HttpMapsProvider` (`MAPS_PROVIDER_URL`/`API_KEY`/`TIMEOUT_MS`, GET `/geocode?address=` + `/reverse?lat=&lng=&` `requestWithRetry` idempotent retry). Not full maps product.
- [x] **Object Storage (StorageService + LocalStorageProvider + S3StorageProvider real S3 REST SigV4 + MockS3StorageProvider test-only, STORAGE_PROVIDER local/s3, tenant-scoped keys, traversal protection, timeout/retry/normalization):** `StorageService` (`STORAGE_PROVIDER` local/s3 via `createStorageProvider`, `generateProductImageKey`/`generateVariantImageKey` -> `tenants/{tenantId}/products/{productId}/...` `tenants/{tenantId}/products/{productId}/variants/{variantId}/...`, `sanitizeFilename` `[^a-zA-Z0-9._-]->_`, `assertTenantScopedKey` `tenants/` + no `..`/`//`/`\`/`\0`/`:` , `upload`/`delete`/`getUrl`/`fileExists`/`getFileStream` delegated). `LocalStorageProvider` (`LOCAL_STORAGE_PATH` ./storage, `LOCAL_STORAGE_URL` /storage, filesystem, traversal). `S3StorageProvider` real S3 REST (`S3_BUCKET`/`S3_REGION` us-east-1/`S3_ENDPOINT`/`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`/`S3_PUBLIC_BASE_URL`/`S3_FORCE_PATH_STYLE`/`STORAGE_TIMEOUT_MS` 5000, SigV4 `AWS4-HMAC-SHA256` with `x-amz-date`/`x-amz-content-sha256`/`host`+`Authorization` when creds else unsigned, `_buildUrl` path/virtual-hosted, `upload` PUT `requestWithRetry` idempotent 2 + 503 retry 2 PUTs + timeout 60ms TIMEOUT, `delete` DELETE 404->false, `getUrl` HEAD 404->null, `exists` HEAD, `getStream` GET stream, `_enforceTenantKey` same). `MockS3StorageProvider` test-only (in-memory Map, `baseUrl https://mock-s3.local/mock-bucket`, same `_enforceTenantKey` + timeout/fail simulation, distinct `constructor.name MockS3StorageProvider` not instance of `S3StorageProvider`, `_clear`, via local HTTP S3 test server `createS3TestServer` http PUT/GET/HEAD/DELETE + Map + `setFailNext`/`setDelay` + request log proves PUT/HEAD/GET/DELETE, no cloud credentials needed, timeout via delay 400ms->60ms, retry via 503).

### Shared HTTP

- [x] **Timeout AbortController:** `fetchWithTimeout` `AbortController` `setTimeout(abort, timeoutMs)`, `AbortError` -> `IntegrationError` TIMEOUT 504 `isRetryable true`, else `normalizeProviderError`.
- [x] **Retry idempotency-aware:** `requestWithRetry` `maxAttempts = idempotent ? retries+1 :1`, `isRetryableStatus` 408/429/502/503/504, `isRetryableError` via `IntegrationError.isRetryable` (TIMEOUT/UNAVAILABLE/RATE_LIMIT/5xx vs VALIDATION/AUTH/NOT_FOUND/CONFIGURATION/REJECTION no retry), `sleep(retryDelayMs*attempt)` exponential, `logger.warn` on retry, only retry when idempotent.
- [x] **Normalized IntegrationError codes:** `IntegrationErrorCode` TIMEOUT/UNAVAILABLE/AUTHENTICATION/VALIDATION/NOT_FOUND/RATE_LIMIT/CONFIGURATION/UNKNOWN, `statusCode` 504/502/401/400/404/429/500/502, `isRetryable()`, `mapHttpStatusToCode` 408/504->TIMEOUT 429->RATE_LIMIT 401/403->AUTH 404->NOT_FOUND 400/422->VALIDATION >=500->UNAVAILABLE else REJECTION, `normalizeProviderError` handles Abort/timeout->TIMEOUT + ECONNREFUSED/ENOTFOUND/fetch failed->UNAVAILABLE 502 + status->mapped code, never leak raw body.
- [x] **Response mapping:** `mapProviderResponse(provider, raw)` email `{providerId:id/messageId, status}` sms `{providerId:sid/id, status}` shipping `{rate,currency,eta,provider}` maps `{lat,lng,address,provider}` payment `{providerPaymentId:id/paymentId, status,provider}`, no `apiKey`/`secret` in mapped.
- [x] **No secret leakage:** `apiKey` via `Authorization: Bearer` header only, not in `IntegrationError` message/details/mapped, queue payload excludes credentials, logger redact.

### Security

- [x] Tenant isolation via `req.context.tenantId` (`StorageService.assertTenantScopedKey` `tenants/` required, no `..`/`//`/`\`/`\0`/`:`), tenant-scoped keys `tenants/{tenantId}/products/{productId}/...` server-derived via `generate*Key`, cross-tenant 404 not leak, payment/email/sms/shipping/maps `tenantId` server-derived not client trusted, verified tenant A key != tenant B key.
- [x] Traversal protection: `LocalStorageProvider` + `S3StorageProvider` + `MockS3StorageProvider` + `StorageService` all reject `../`/`//`/absolute/`:``\0` 400 `INVALID_STORAGE_PATH`/`KEY`, verified 7 rejection cases.
- [x] Webhook HMAC: `verifyWebhookSignature` with `PAYMENT_WEBHOOK_SECRET`, `x-webhook-signature`/`x-payment-signature`, `timingSafeEqual`, invalid 401 `AUTHENTICATION`, preserved via `payment.provider.js` adapter `verifyWebhook`.
- [x] Env secrets: `PAYMENT_PROVIDER`/`PAYMENT_PROVIDER_URL`/`PAYMENT_PROVIDER_API_KEY`/`PAYMENT_PROVIDER_TIMEOUT_MS`, `STORAGE_PROVIDER`/`LOCAL_STORAGE_PATH`/`LOCAL_STORAGE_URL`/`S3_BUCKET`/`S3_REGION`/`S3_ENDPOINT`/`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`/`S3_PUBLIC_BASE_URL`/`S3_FORCE_PATH_STYLE`/`STORAGE_TIMEOUT_MS`, `EMAIL_PROVIDER`/`EMAIL_PROVIDER_URL`/`EMAIL_PROVIDER_API_KEY`/`EMAIL_PROVIDER_TIMEOUT_MS`, `SMS_PROVIDER`/`SMS_PROVIDER_URL`/`SMS_PROVIDER_API_KEY`/`SMS_PROVIDER_TIMEOUT_MS`, `SHIPPING_PROVIDER`/`SHIPPING_PROVIDER_URL`/`SHIPPING_PROVIDER_API_KEY`/`SHIPPING_PROVIDER_TIMEOUT_MS`, `MAPS_PROVIDER`/`MAPS_PROVIDER_URL`/`MAPS_PROVIDER_API_KEY`/`MAPS_PROVIDER_TIMEOUT_MS` via `src/config/env.js` Zod (defaults mock/5000/local), never in logs/details/queue (verified secrets not contain `apiKey`/`secret`).
- [x] Logger redact: Pino redact paths authorization/apiKey/secret/password/token/cookie, `fetchWithTimeout`/`requestWithRetry` warn logs no secrets, `IntegrationError` details only `providerStatus`.
- [x] No credentials in queue: BullMQ `processSendEmail` payload `{tenantId,to,subject,template,variables}` no `apiKey`/`secret`, provider `apiKey` from env not job payload.
- [x] Normalized errors: `IntegrationErrorCode` + `isRetryable` distinguishes permanent vs transient, queue processor `UnrecoverableError` for 400/401 vs retry for TIMEOUT/UNAVAILABLE.

### Testing

- [x] **Phase 16 dedicated 58/58:** `tests/integration/phase16-external-integrations.test.js` 58 tests: Storage contract 3 (local/real S3/mock same interface, factory local/s3, mock distinct), Storage upload/delete/url/tenant keys 8 (product image tenant-scoped, mock s3 upload+getUrl+exists+delete, real S3 via test server PUT/HEAD/GET stream/DELETE + log, variant path, traversal 7 rejections, tenant isolation A!=B, local regression), Storage error normalization 5 (mock timeout TIMEOUT 504, mock unavailable UNAVAILABLE, real S3 timeout via delay 400->60ms TIMEOUT, real S3 503 retry 2 PUTs, secrets not leaked), Payment 11 (mock pay_mock_ mapped, HTTP charge mapping amount/orderId/Bearer/Idempotency-Key/response pay_http_123, timeout 50ms TIMEOUT retryable, retry on 503 2 calls, refund no retry 1 call, mock UNAVAILABLE retryable, validation 400 not retryable, factory mock/Http, CONFIGURATION when URL missing, webhook HMAC 401, secrets not leaked), Email 9 (mock email_mock_ mapped, HTTP send mapping, timeout retryable vs validation not, http timeout, processor via EmailService no fetch, UnrecoverableError for missing to/subject, no secrets in payload, factory mock), SMS 4 (mock sms_mock_, HTTP sid, timeout retryable vs validation not, factory), Shipping 5 (mock rate 12.5 USD, HTTP /rates mapping, createShipment no retry 1 call, validation not retryable, factory), Maps 5 (mock geocode, HTTP GET /geocode, retry on 503 2 calls, validation not retryable, factory), Error normalization 3 (TIMEOUT retryable etc., provider errors no secrets, HTTP 401->AUTH 404->NOT_FOUND 429->RATE_LIMIT), Secret management 3 (env secrets not exposed, queue payload no apiKey, logger redact), Tenant isolation 1 (A key !=B, exists false), Adapter contract 2 (EmailService contract, PaymentService adapter).
- [x] **Full regression 626/626:** 17/17 suites (568 Phase 1-15 + 58 Phase 16), lint 0, Prisma validate passed, migrate 8 up to date (no new migration), startup passed (createApp+health), health 200, invalid webhook 401 still via Phase 10.
- [x] **S3 clarification:** Real `S3StorageProvider` (real S3 REST SigV4 PUT/GET/HEAD/DELETE via fetch, `STORAGE_TIMEOUT_MS`, `S3_BUCKET`/region/endpoint/accessKey/secret/publicBaseUrl/forcePathStyle, timeout/retry, path/virtual-hosted, no cloud credentials for test endpoint) vs `MockS3StorageProvider` test-only (in-memory Map, mock-s3, `_clear`, not instance of real, via local HTTP S3 test server `createS3TestServer` http://127.0.0.1:{port} Map + PUT/GET/HEAD/DELETE + setFailNext/setDelay + request log, proves real HTTP, no cloud credentials needed).

### Limitations

- [x] Shipping/Maps adapters not full domain products (minimal `getRate`/`createShipment`/`geocode`/`reverseGeocode` contracts, not full shipping label/tracking/rate-shop or maps search/directions/places).
- [x] HTTP providers configurable endpoints (`PAYMENT_PROVIDER_URL`, `EMAIL_PROVIDER_URL`, `SMS_PROVIDER_URL`, `SHIPPING_PROVIDER_URL`, `MAPS_PROVIDER_URL`, `S3_ENDPOINT`/`S3_PUBLIC_BASE_URL`) via `src/config/env.js`; no real credentials needed (mock default, Http requires URL only when `*_PROVIDER=http` else CONFIGURATION 500 not retryable).
- [x] No new DB tables/migration (integrations reuse existing tables/filesystem/S3 REST); no analytics/reporting/Docker/CI/CD added.

**Verification:** 58/58 Phase 16, 626/626 full (17 suites, 568 + 58), lint 0, Prisma valid, 8 migrations up to date (no new migration — integrations reuse existing tables/filesystem/S3 REST via local HTTP test server, no cloud credentials), app startup + S3 real vs Mock + HTTP timeout/ retry/ mapping + provider-independent adapters + EmailService + BullMQ processor->service->adapter + tenant isolation + HMAC + env secrets + logger redact all verified, roadmap untouched.



## Phase 17 — API Orchestration (COMPLETE & VERIFIED — 22/22, 648/648, 8 migrations — no new migration, HUMAN VERIFICATION: PASS)

### Architecture — Orchestration Layer
```
Dashboard Route
  ↓
Dashboard Controller
  ↓
Dashboard Service (orchestration only — no direct Prisma)
  ↓
OrderService.getOverview(tenantId)
InventoryService.getOverview(tenantId)
PaymentService.getOverview(tenantId)
UserService.getOverview(tenantId)
NotificationService.getOverview(tenantId)
ProductService.getOverview(tenantId)
  ↓
Existing repositories (tenant-scoped aggregation)
  ↓
Prisma / PostgreSQL
```
- DashboardService is pure orchestration: imports six domain services (`OrderService`, `InventoryService`, `PaymentService`, `UserService`, `NotificationService`, `ProductService`) and delegates via `getOverview(tenantId)`; contains zero direct `prisma.*` domain queries, zero `getPrismaClient`, verified via code inspection and runtime delegation test (`FakeRedis` + mock services prove 6 calls).
- Six domain services expose `getOverview(tenantId)` via existing service/repository boundaries: each repository implements efficient tenant-scoped `count`/`groupBy`/`aggregate`/`findMany take 5`; services simply delegate to repository. No new repository files, no duplicated business logic, no second domain layer.
- Reuses `authenticate()` + `authorize('dashboard:read')`, existing Phase 14 `CacheService`, `dashboardOverviewKey` + `CACHE_TTL.DASHBOARD_OVERVIEW`.
- No internal HTTP calls between modules (`fetch`/`axios` absent, verified).

### Endpoint
| Method | Endpoint | Auth | Permission | Description |
|--------|----------|------|------------|-------------|
| GET | `/api/v1/dashboard/overview` | Bearer JWT `authenticate()` | `dashboard:read` | Tenant-scoped orchestration; returns `{success:true, data:{tenantId, generatedAt, orders, inventory, payments, users, notifications, products}, message:'Dashboard overview retrieved successfully'}` + `x-cache: HIT|MISS`; error via `AppError` + central `errorHandler` |

- Response sections (derived only from currently implemented modules, no analytics tables invented): `orders` `{total, byStatus, revenueSum, recent[5]}`, `inventory` `{warehouses, variants, lowStockItems, totalQuantity}`, `payments` `{total, byStatus, completedRevenue, recent[5]}`, `users` `{total, byStatus, recent[5]}`, `notifications` `{total, unread, recent[5]}`, `products` `{products, categories, variants}`.

### Tenant Isolation & Authorization
- Tenant derived solely from `req.context.tenantId` (JWT `authenticate()`); never from client `tenantId` query/body (verified `?tenantId=other` ignored → own tenant).
- Every underlying `getOverview` is tenant-scoped `where:{tenantId}`; cross-tenant verification: Tenant A sees only A orders/inventory/payments/users/notifications/products, Tenant B sees only B (verified Tenant A COMPLETED vs B PENDING, notification titles isolated, inventory quantities differ).
- Protected by existing RBAC via `authorize('dashboard:read')`; unauthenticated → `401 UNAUTHORIZED/INVALID_TOKEN`, missing permission (e.g., only `order:read`) → `403 FORBIDDEN` (verified). `dashboard:read` is minimal new permission following existing `resource:action` convention.

### Orchestration Details
- **Parallel where safe:** `DashboardService.buildOverview` uses `Promise.allSettled` over six independent `getOverview` calls; each repository internally uses `Promise.all` for counts/aggregates. Deterministic, no race on tenant isolation. Verified `~22ms` and runtime delegation test.
- **Partial failure handling:** individual section failure returns `{error:true, message, code}` rather than fabricated data; `allSettled` aggregates; if at least one succeeds, HTTP `200` with error marker; verified by monkey-patching `getPaymentsOverview` → `payments: {error:true}` while `orders` still present.
- **All-fail behavior:** if all six fail, throws first error → `500` via `errorHandler` (verified: six mocks failing → rejects).
- **Consistent response:** success `{success:true, data, message}`; error `{success:false, error:{code,message}, requestId}`; no stack/Prisma internals/secrets leaked (verified `JSON.stringify` not matching `prisma|stack|passwordHash|secret`).
- **No Phase 18 analytics:** Dashboard derives revenue sums from existing `order.total`/`payment.amount` aggregates only; no date-range/groupBy/category/product/status filters, no new analytics schema.

### Redis / Caching — Reuse of Phase 14
- Reuses existing `CacheService` (`src/common/cache/cache.service.js` `get`/`set`/`del` with `stripSensitive`, `logger.warn` fallback) and `src/config/redis.js` (no second Redis, no new client, no new abstraction, no new `CACHE_PREFIX` architecture).
- Key: `pulseops:v1:tenant:{tenantId}:dashboard:overview` via `dashboardOverviewKey(tenantId)` (`CACHE_PREFIX` + `sanitizeId` regex validation).
- TTL: `60` seconds (`CACHE_TTL.DASHBOARD_OVERVIEW` 60 <600 >0, verified).
- **Miss:** `cache.get` null → call six domain services → `cache.set` with TTL 60 → return `cacheHit:false` + `x-cache: MISS`.
- **Hit:** `cache.get` returns deserialized `{data, cacheHit:true}` → no DB calls → `x-cache: HIT` (verified miss stores 1 key, hit returns same `orders.total`, second call `cacheHit:true`).
- **Tenant-specific keys:** `dashboardOverviewKey(A) !== dashboardOverviewKey(B)` → isolation verified (A cached `tenantId A` ≠ B `tenantId B`).
- **Invalidation:** `invalidateCache(tenantId)` → `cache.del(key)` → `null` (verified).
- **GET/SET failure fallback:** `try/catch logger.warn` → fallback to domain services; `FakeRedis` GET failure still returns DB data `cacheHit:false`, SET failure still `200` (verified).
- **No second cache implementation**, sensitive-data protection via `stripSensitive` (verified `passwordHash`/`token` undefined after set, `data.ok` preserved).
- Single-instance ioredis reused; degraded mode preserves correctness (Redis down → DB fallback, still `200`).

### Database
- **Zero new migrations**, **zero schema changes**, existing 8 migrations remain current (`npx prisma migrate status` → Database schema is up to date!).
- `npx prisma validate` → valid.
- No analytics tables introduced (Phase 18 deferred); reuses existing 34 models (`tenants`, `orders`, `inventory`, `payments`, `users`, `notifications`, `products`, etc.).
- No Phase 18 analytics schema claimed.

### Testing / Verification
- **Dedicated:** 22/22 in `tests/integration/phase17-dashboard.test.js` (endpoint 7: success derived aggregation + 401 unauth + 403 insufficient + cross-tenant isolation + client override blocked + envelope no leak + invalid token; orchestration 5: no HTTP + delegates via boundaries + runtime delegation with mock services + parallel + repo contains getOverview; Redis 7: miss→hit tenant keys, invalidation, GET fallback, SET fallback, TTL/sanitization, sensitive protection; partial failure 2; auth regression 1).
- **Full regression:** 648/648 (18 suites: 626 Phase 1-16 + 22 Phase 17) `node --experimental-vm-modules jest --runInBand --forceExit`.
- **Lint:** `npm run lint` → 0 errors, 0 warnings.
- **Prisma:** `npx prisma validate` → Valid, `npx prisma migrate status` → 8 migrations up to date (no Phase 17 migration).
- **Startup:** `createApp()` + ephemeral `http.createServer(app)` + `GET /health` 200.
- **Health:** `GET /health` 200.
- **Authenticated dashboard:** `GET /api/v1/dashboard/overview` → 200 with tenant `orders.total`/`byStatus`/`recent`, `inventory.variants`/`warehouses`/`lowStockItems`, `payments.byStatus`, `users`, `notifications`, `products`.
- **401 unauthenticated, 403 insufficient-permission, cross-tenant isolation, client tenantId override, cache hit/miss + tenant isolation + Redis fallback, partial failure error marker / all-fail throws, no internal HTTP calls** all verified.

### Scope — What is Complete vs Future (as of Phase 17)
- **Phase 17 API Orchestration — COMPLETE** (this phase).
- **Phase 18 Analytics & Reporting — NOT implemented** (no `analytics/*` tables/APIs, no date-range/groupBy/reportQueue consumption beyond stub).
- **Phase 19 Performance Optimization — NOT implemented** (no broad perf work; orchestration prioritizes correctness, Phase 19 dedicated).
- **Phase 20 Security Hardening — NOT implemented.**
- **Phase 21 Complete Testing — NOT implemented as future-phase** (Phase 17 tests are 22/22, but future comprehensive testing phase remains).
- **Phase 22 Swagger/OpenAPI — NOT implemented.**
- **Phase 23 Docker/CI/CD/Deployment — NOT implemented.**
- Phase 1–16 remain complete and verified; no history rewritten.

### Limitations / Design Notes (Actual)
- Partial failures produce explicit `{error:true, message, code}` per section rather than fabricated successful data; consumers must handle error markers. All-section failure results in error (thrown, not partial 200). Verified via `payments down` → `payments.error:true`.
- No exactly-once or distributed-transaction guarantees beyond `Promise.allSettled` and per-service Prisma `count/groupBy/aggregate` reads; orchestration is at-least-once read aggregation, not transactional across domains.
- No Phase 18 analytics features (date range, groupBy, category/product/status filters, revenue timeseries) — dashboard revenue sums are simple `order.total`/`payment.amount` aggregates only.

### Phase 17 Status: ✅ COMPLETE AND VERIFIED (HUMAN VERIFICATION: PASS)
All 22 Phase 17 tests, 648/648 full (18 suites, 626 + 22), lint 0, Prisma valid, 8 migrations up to date (no new Phase 17 migration), app startup + health + orchestration via six domain services (OrderService/InventoryService/PaymentService/UserService/NotificationService/ProductService) through existing repositories + Redis reuse + parallel Promise.allSettled + partial-failure handling + tenant isolation + dashboard:read RBAC all verified, roadmap untouched, no Phase 18+ claimed.

---

## What is NOT Implemented (Future Phases as of Phase 17 completion)

The following are explicitly **NOT** implemented as of Phase 17 completion (API Orchestration — COMPLETE):
- Analytics & Reporting — `analytics/*` implementation (Phase 18) — only `reportQueue`/`analyticsQueue` stubs
- Performance Optimization (Phase 19)
- Security Hardening (Phase 20)
- Complete Testing (Phase 21)
- Swagger/OpenAPI (Phase 22)
- Docker / CI/CD / Deployment (Phase 23)
Phase 17 API Orchestration is COMPLETE; future phases (18 Analytics, 19 Performance, 20 Security Hardening, 21 Complete Testing, 22 Swagger/OpenAPI, 23 Docker/CI/CD) remain NOT implemented as documented above.