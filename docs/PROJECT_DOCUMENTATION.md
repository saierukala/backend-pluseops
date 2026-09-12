# Project Documentation

Technical architecture and implementation state as of Phase 04 completion.

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
└── auth/               # Authentication
    ├── auth.controller.js
    ├── auth.service.js
    ├── auth.repository.js
    ├── auth.validation.js
    ├── auth.routes.js
    ├── auth.middleware.js
    ├── jwt.util.js
    ├── password.util.js
    └── token-expiry.util.js
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
```

- Phase 03 migration does **not** recreate Phase 02 tables
- Phase 04 migration adds 4 tables WITHOUT recreating Phase 02/03 tables
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
   - 33 system permissions (resource:action format)
   - 3 roles: `admin`, `manager`, `member`
   - Role-permission links (72 total)

### Idempotency
- Uses `upsert` with composite unique constraints
- Safe to run repeatedly — second run creates zero duplicates
- Verified: unique role names ✅, unique permissions ✅, FK tenantIds match ✅

### Scope
- **Minimal foundational RBAC data only**
- No fake products, orders, customers, inventory, payments
- No authentication implementation

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
   - 33 system permissions (resource:action format)
   - 3 roles: `admin`, `manager`, `member`
   - Role-permission links (72 total)

### Idempotency
- Uses `upsert` with composite unique constraints
- Safe to run repeatedly — second run creates zero duplicates
- Verified: unique role names ✅, unique permissions ✅, FK tenantIds match ✅

### Scope
- **Minimal foundational RBAC data only**
- No fake products, orders, customers, inventory, payments
- No authentication implementation

---

## Testing

### Current Verification Results (Latest Run)

| Check | Result |
|-------|--------|
| **Integration Tests** | 86/86 passing |
| - `auth.test.js` | 30 tests ✅ |
| - `tenants.test.js` | 11 tests ✅ |
| - `phase3-schema.test.js` | 39 tests ✅ |
| - `request-boundaries.test.js` | 2 tests ✅ |
| - `health.test.js` | 2 tests ✅ |
| **ESLint** | 0 errors |
| **Prisma Validate** | ✅ Valid |
| **Prisma Generate** | ✅ Success |
| **Migration Status** | ✅ Up to date (4 migrations) |

### Test Coverage Highlights
- Health endpoints: liveness, DB readiness, Redis readiness
- Tenant CRUD: create, get, update, delete, duplicate slug, validation, status enum
- Phase 03 schema: all 31 models create/read, unique constraints per tenant, cross-tenant isolation, Decimal types, TIMESTAMPTZ, soft delete, relationships
- Request boundaries: JSON size limit, malformed JSON, rate limit headers
- Phase 04 auth: 30 tests covering register, login, refresh, logout, forgot/reset password, verify email, me, cross-tenant isolation

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
- RBAC Authorization Middleware
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
| RBAC (Phase 05) | ⏳ Not Started |
| User Management (Phase 06) | ⏳ Not Started |
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

## Phase 04 Status: ✅ COMPLETE AND VERIFIED

All 86 tests pass, lint clean, Prisma validation passes, migrations up to date, no regressions.