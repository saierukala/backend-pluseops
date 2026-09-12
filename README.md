# PulseOps Backend

A production-minded, multi-tenant backend for PulseOps, built with Node.js, Express, PostgreSQL, Prisma, and Redis. The project follows a modular-monolith architecture and is being delivered incrementally so that every foundation layer is tested before business modules are introduced.

**Current status:** Phase 05 — Authorization / RBAC is **COMPLETE and VERIFIED**.

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

Latest verification results (all passing):

- **Tests:** 145/145 passing (integration: health, tenants, request boundaries, Phase 03 schema, Phase 04 auth, Phase 05 RBAC)
- **Lint:** ESLint 0 errors
- **Prisma validate:** ✅ Valid
- **Prisma generate:** ✅ Success
- **Migration status:** Database schema up to date (5 migrations applied)

## Operational notes

At startup the API attempts to connect to PostgreSQL and Redis. In development and test, unavailable configured services leave the API running in degraded mode so liveness remains available and readiness returns `503`. Production fails fast by default; set `FAIL_ON_DEPENDENCY_ERROR=false` only when degraded startup is intentional. On `SIGINT` or `SIGTERM`, the server stops accepting connections and closes Redis and Prisma cleanly.

## Current scope

- Phase 01 provides operational infrastructure only.
- Phase 02 provides tenant management and the tenant context foundation.
- Phase 03 provides the complete core relational schema (31 models) with tenant isolation, proper indexes, constraints, Decimal money, and TIMESTAMPTZ(6) timestamps.
- Phase 04 provides authentication (JWT, refresh tokens, password reset, email verification).
- Phase 05 provides role-based and permission-based authorization (RBAC) with tenant isolation.
- User management, Product management, Inventory, Orders, Payments, Notifications, WebSockets, Redis caching, BullMQ, External integrations, Analytics, Swagger/OpenAPI, Docker/CI/CD are **NOT implemented yet**.
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
| Phase 06 | User Management | ⏳ Not started |
| Phase 07 | Product Management | ⏳ Not started |
| Phase 08 | Inventory | ⏳ Not started |
| Phase 09 | Orders | ⏳ Not started |
| Phase 10 | Payments | ⏳ Not started |
| Phase 11 | Audit | ⏳ Not started |
| Phase 12 | Notifications | ⏳ Not started |
| Phase 13 | WebSockets | ⏳ Not started |
| Phase 14 | Redis Caching | ⏳ Not started |
| Phase 15 | BullMQ | ⏳ Not started |
| Phase 16 | External Integrations | ⏳ Not started |
| Phase 17 | API Orchestration | ⏳ Not started |
| Phase 18 | Analytics | ⏳ Not started |
| Phase 19 | Performance | ⏳ Not started |
| Phase 20 | Security Hardening | ⏳ Not started |
| Phase 21 | Complete Testing | ⏳ Not started |
| Phase 22 | Swagger/OpenAPI | ⏳ Not started |
| Phase 23 | Docker/CI/CD/Deployment | ⏳ Not started |

**Phase 05 is COMPLETE and VERIFIED. Phase 06 is the NEXT authorized development phase.**