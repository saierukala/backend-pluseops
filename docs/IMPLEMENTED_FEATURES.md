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
- 33 system permissions covering: tenant, user, role, permission, product, category, order, customer, warehouse, inventory
- 3 system roles:
  - `admin` → all 33 permissions
  - `manager` → 29 permissions (excludes: user:delete, role:delete, permission:read, tenant:update)
  - `member` → 10 read-only permissions
- 72 role-permission links

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

## What is NOT Implemented (Future Phases)

The following are explicitly **NOT** implemented as of Phase 04 completion:

- RBAC authorization middleware
- User management APIs
- Product/Category/Variant/Attribute/Image APIs
- Inventory management APIs
- Order/OrderItem/OrderStatusHistory APIs
- Payment/Transaction/Refund APIs
- Notification/Preference/Template APIs
- WebSocket/Socket.IO real-time
- Redis caching layer
- BullMQ background jobs
- External API integrations
- Analytics/Reporting APIs
- Swagger/OpenAPI documentation
- Docker/CI/CD/Deployment configuration