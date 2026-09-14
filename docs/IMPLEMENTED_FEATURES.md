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

## What is NOT Implemented (Future Phases)

The following are explicitly **NOT** implemented as of Phase 10 completion (Payment & Transaction Processing COMPLETE):
- Audit & Activity Logs — `audit_logs`, `activity_logs` APIs (Phase 11)
- Notifications — `notifications`, `notification_preferences`, `notification_templates` (Phase 12)
- WebSockets / Real-time — Socket.IO (Phase 13)
- Redis Caching (Phase 14)
- BullMQ / Background Jobs (Phase 15)
- External API Integrations — storage S3, payment/email/SMS providers (Phase 16)
- API Orchestration (Phase 17)
- Analytics & Reporting (Phase 18)
- Performance Optimization (Phase 19)
- Security Hardening (Phase 20)
- Complete Testing (Phase 21)
- Swagger/OpenAPI (Phase 22)
- Docker / CI/CD / Deployment (Phase 23)