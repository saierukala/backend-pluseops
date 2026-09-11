# Project Documentation

Technical architecture and implementation state as of Phase 03 completion.

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
    └── tenants/        # Tenant CRUD
        ├── tenants.controller.js
        ├── tenants.service.js
        ├── tenants.repository.js
        ├── tenants.validation.js
        └── tenants.routes.js
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
- Current Phase 02/03 implementation validates tenant existence but **does not enforce tenant isolation on business APIs** (no business APIs exist yet)
- Tenant resolution from authenticated context is **deferred to Phase 04**
- `TenantService.canPerformOperations(tenant)` enforces `ACTIVE`/`TRIAL` status for operations

### Important
- **Authentication is NOT implemented** — no JWT, no session, no user identity
- `tenant_id` must never be trusted from client-controlled requests in future phases
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
- Prisma schema: `@db.Timestamptz(6)` on all `createdAt`, `updatedAt`, `deletedAt`, `lastLoginAt`, `readAt`
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
```

- Phase 03 migration does **not** recreate Phase 02 tables
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

## Testing

### Current Verification Results (Latest Run)

| Check | Result |
|-------|--------|
| **Integration Tests** | 56/56 passing |
| - `health.test.js` | ✅ |
| - `tenants.test.js` | ✅ |
| - `phase3-schema.test.js` | ✅ |
| - `request-boundaries.test.js` | ✅ |
| **ESLint** | 0 errors |
| **Prisma Validate** | ✅ Valid |
| **Prisma Generate** | ✅ Success |
| **Migration Status** | ✅ Up to date (3 migrations) |

### Test Coverage Highlights
- Health endpoints: liveness, DB readiness, Redis readiness
- Tenant CRUD: create, get, update, delete, duplicate slug, validation, status enum
- Phase 03 schema: all 31 models create/read, unique constraints per tenant, cross-tenant isolation, Decimal types, TIMESTAMPTZ, soft delete, relationships
- Request boundaries: JSON size limit, malformed JSON, rate limit headers

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
- **Rate Limiting** — sliding window, configurable (`RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`)
- **HPP** — HTTP Parameter Pollution protection
- **Compression** — response compression
- **JSON Body Limits** — configurable (`REQUEST_BODY_LIMIT`, default 1mb)
- **Request IDs** — generated or client-supplied, included in errors
- **Structured Logging** — Pino JSON, no sensitive data in logs
- **Centralized Errors** — consistent format, no stack traces in production responses
- **Zod Validation** — all inputs validated at route level
- **Prisma Parameterized Queries** — SQL injection prevention via ORM

### NOT Implemented (Future Phases)
- JWT Authentication
- Refresh Token Rotation
- Password Hashing (Argon2id/bcrypt)
- Email Verification
- Password Reset
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
- **Target phase:** Phase 04/05 if stricter DB-level isolation required

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

---

## Summary of Implementation Status

| Area | Status |
|------|--------|
| Project Foundation (Phase 01) | ✅ Complete & Verified |
| Multi-Tenant Foundation (Phase 02) | ✅ Complete & Verified |
| Database Schema & Migrations (Phase 03) | ✅ Complete & Verified |
| Authentication (Phase 04) | ⏳ Not Started |
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