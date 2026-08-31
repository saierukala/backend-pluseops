# PulseOps Backend

A production-minded, multi-tenant backend for PulseOps, built with Node.js, Express, MySQL, Prisma, and Redis. The project follows a modular-monolith architecture and is being delivered incrementally so that every foundation layer is tested before business modules are introduced.

**Current status:** Phase 01 — Project Foundation is complete and verified. Phase 02 will introduce the multi-tenant foundation.

## Implemented foundation

- Express API with versioned routing (`/api/v1`)
- Environment validation with Zod
- Prisma/MySQL and Redis connection configuration
- Liveness and dependency health endpoints
- Request IDs, Pino structured logging, centralized errors
- Helmet, CORS allow-list, HPP, compression, JSON size limits, and rate limiting
- Graceful shutdown for HTTP, Prisma, and Redis clients
- Jest/Supertest integration coverage for health and error behavior

## Prerequisites

- Node.js 22 or newer
- npm 10 or newer
- MySQL and Redis, if you want dependency health checks to report `up`

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

4. Generate Prisma Client after the database model is introduced (Phase 02/03):

   ```bash
   npm run prisma:generate
   ```

5. Start the API:

   ```bash
   npm run dev
   ```

## Environment reference

| Variable | Required | Purpose |
| --- | --- | --- |
| `NODE_ENV` | No | `development`, `test`, or `production`; defaults to `development`. |
| `PORT` / `HOST` | No | HTTP bind address; defaults to `3000` and `0.0.0.0`. |
| `DATABASE_URL` | For DB checks | MySQL Prisma connection string. |
| `REDIS_URL` | For Redis checks | Redis connection string. |
| `CORS_ORIGINS` | No | Comma-separated browser origin allow-list. |
| `LOG_LEVEL` | No | Pino log threshold. |
| `REQUEST_BODY_LIMIT` | No | Maximum JSON request size; defaults to `1mb`. |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` | No | General API rate-limit window and request count. |
| `TRUST_PROXY` | No | Set to `true` when the API runs behind a trusted reverse proxy. |
| `FAIL_ON_DEPENDENCY_ERROR` | No | Defaults to `true` in production and `false` elsewhere. When true, MySQL/Redis startup failures stop the API. |

Never commit `.env`. Use a secret manager or deployment-specific environment variables in production.

## Endpoints

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/health` | Liveness probe. Works without MySQL or Redis. |
| GET | `/health/db` | MySQL readiness probe. Returns `503` until connected. |
| GET | `/health/redis` | Redis readiness probe. Returns `503` until connected. |

The same health endpoints are also exposed under `/api/v1/health`, although infrastructure probes should use the root `/health` routes.

Successful responses use `{ "success": true, "data": ..., "message": "..." }`. Errors include `{ "success": false, "error": ..., "requestId": "..." }`. Send an `X-Request-Id` header to supply your own trace identifier; otherwise one is generated.

## Development commands

```bash
npm run dev
npm start
npm test
npm run lint
npm run prisma:validate
```

## Operational notes

At startup the API attempts to connect to MySQL and Redis. In development and test, unavailable configured services leave the API running in degraded mode so liveness remains available and readiness returns `503`. Production fails fast by default; set `FAIL_ON_DEPENDENCY_ERROR=false` only when degraded startup is intentional. On `SIGINT` or `SIGTERM`, the server stops accepting connections and closes Redis and Prisma cleanly.

## Current scope

- Phase 01 provides operational infrastructure only; tenant models, authentication, roles, permissions, and business APIs begin in later phases.
- MySQL and Redis connectivity are verified locally. The health endpoints distinguish liveness from dependency readiness.
- Docker and deployment configuration are intentionally deferred until their dedicated delivery phase.

## Phase status

Phase 01 is complete. The next roadmap increment is **Phase 02: Multi-Tenant Foundation**.
