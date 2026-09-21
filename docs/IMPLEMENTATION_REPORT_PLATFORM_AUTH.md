# PulseOps Platform Admin + Tenant Authentication Architecture — Implementation Report

**Status:** IMPLEMENTED — AUTOMATED VERIFIED — AWAITING HUMAN VERIFICATION  
**Date:** 2026-09-21  
**Branch:** (local, not committed per instructions)

---

## 1. Current Architecture Discovered

### 1.1 Project Structure
- **Type:** Modular monolith (Express 5, Prisma 6, PostgreSQL, Redis, BullMQ)
- **Entry:** `src/app/app.js` → `src/app/routes.js` → `src/modules/*/routes.js`
- **Layers per module:** `Route → Controller → Service → Repository → PostgreSQL (Prisma)`
- **Auth:** JWT (HS256, access + refresh via `jsonwebtoken`, argon2id hashing)
- **CORS:** Explicit allowlist, credentials:true, no wildcard in production
- **Rate limiting:** Global + auth stricter limiter (`AUTH_RATE_LIMIT_MAX=20`)

### 1.2 Schema (Prisma)
- `Tenant(id, name, slug unique, status TRIAL|ACTIVE|SUSPENDED|CANCELLED, plan)`
- `User(id, tenantId, email unique globally + tenantId_email unique, passwordHash, firstName, lastName, status, emailVerified, lastLoginAt)` — **all users require tenantId**
- `TenantMembership(id, tenantId, userId, roleId, status ACTIVE|INACTIVE|SUSPENDED, unique tenantId_userId)`
- `RefreshToken, PasswordResetToken, EmailVerificationToken` — all tenantId+userId scoped
- `Role, Permission, UserRole, RolePermission` — all tenant-scoped
- `PlatformRole, PlatformPermission, PlatformUserRole, PlatformRolePermission` — global, separate from tenant RBAC (migration `20260912_phase_05_platform_rbac_foundation`)
- **Observation:** Platform RBAC exists but no physical platform tenant/user, no mounted platform routes, no seed for platform admin.

### 1.3 Existing Auth Architecture
- **Repository:** `AuthRepository` queries via `memberships.some({tenantId, status:'ACTIVE'})`
- **Service:** `register`/`login`/`refresh`/`logout`/`forgotPassword`/`resetPassword`/`verifyEmail`/`getMe`; login *required* `tenantId` (400 TENANT_REQUIRED if missing)
- **Validation:** `zod` schemas; `tenantId` optional in schema but service enforces required → frontend Workspace ID (Tenant) field leaked UUID
- **JWT:** `signAccessToken({sub, tenantId, sessionId, email})`, `verifyAccessToken` checks `issuer:pulseops`, `audience:pulseops-api`; middleware `authenticate()` requires `sub+tenantId+sessionId`, validates user/membership/tenant ACTIVE/TRIAL, sets `req.context{userId, tenantId, sessionId, email}`
- **Authorization:** `authorize(permission)` checks `TenantMembership` + `UserRole→RolePermission`; `authorizePlatform(permission)` checks `platformUserRole → role.permissions` (parses last `:` for resource/action). Platform middleware existed but unused.

### 1.4 Existing Tenant Model
- `TenantService.create` only creates `Tenant` row; `seedTenant()` creates permissions/roles.
- `tenantsRouter` at `/api/v1/tenants` is **public** (no authenticate) — audit noted “why platform routes are currently not mounted.”

### 1.5 Existing Membership Model
- One `User` ↔ many `TenantMembership` (but app creates 1 membership per user on registration, tenantId==membership tenantId). Global `email` unique prevents same email across tenants (intentional).

---

## 2. Changes Made

### 2.1 Authentication Model — Dual Scope
**File:** `src/modules/auth/auth.validation.js`
- `loginSchema` now: `email, password, scope?: 'platform'|'tenant', tenantId?: uuid (legacy), tenantSlug?: regex ^[a-z0-9-]+$`
- `forgotPasswordSchema` similarly adds `tenantSlug`.

**File:** `src/modules/auth/auth.repository.js`
- Added `findUserByEmail(email)` (global, includes memberships+platform roles)
- Added `findTenantBySlug(slug)`, `findPlatformRolesForUser`, `hasPlatformRole`.

**File:** `src/modules/auth/auth.service.js` (complete rewrite of core flows, other methods preserved)
- Constants: `PLATFORM_TENANT_SLUG='__platform'`
- New dispatch: `login(data)` branches on `scope` (default `tenant`). 
  - `platformLogin(email,password)`: global lookup, `argon2.verify`, check `hasPlatformRole`, resolve platformTenantId (membership or DB), generate **scope=platform** JWT.
  - `tenantLogin({email,password,tenantId,tenantSlug})`: 
    - If `tenantSlug` → resolve slug → tenantId.
    - If `tenantId` → existing behavior.
    - Else auto-resolve: `findUserByEmail` → filter memberships excluding `__platform` + ACTIVE → single tenant auto-selects; 0 → `USE_PLATFORM_LOGIN` or `TENANT_NOT_FOUND`; >1 → `TENANT_REQUIRED` (ambiguous).
    - Validates tenant ACTIVE/TRIAL, `hasActiveTenant`, password, then generates **scope=tenant** JWT.
- `refresh`: Detects scope via stored `RefreshToken.tenant.slug === '__platform'` → `platform` else `tenant`; re-creates JWT with original scope, rotates refresh token transactionally.
- `forgotPassword`: Now auto-resolves tenant via email if no tenantId/slug; preserves enumeration protection.
- `getMe(userId,tenantId,scope)`: Platform branch verifies platform role; tenant branch as before.
- `generateAccessToken(user,sessionId,tenantId,scope)`: Now includes `scope` claim.
- `toSafeUser`: Adds `scope` when supplied; strips `passwordHash`.
- `PLATFORM_TENANT_SLUG` checks prevent platform tenant being used as business tenant.

**File:** `src/modules/auth/auth.middleware.js`
- `authenticate()` (tenant): Now checks `decoded.scope||'tenant'`; **rejects** `scope===platform` with `403 PLATFORM_TOKEN_FORBIDDEN`; requires `tenantId`; rejects `__platform` slug.
- New `authenticatePlatform()`: Requires `scope===platform`, checks `platformUserRole` existence, sets `req.context.scope='platform'`.
- `optionalAuthenticate()`: Now handles both scopes.

**File:** `src/modules/auth/auth.controller.js`
- `me` now forwards `req.context.scope`.

**File:** `src/modules/auth/jwt.util.js` — no change (payload-agnostic).

**File:** `src/common/middleware` & `src/realtime/socket.auth.js`
- Socket auth updated to handle `scope` similarly: platform sockets verify platform role; tenant sockets reject `__platform`.

### 2.2 Platform REST API Layer
**New directory:** `src/modules/platform/`
- `platform.repository.js`: `listTenants({page,limit,status,search})` (excludes `__platform`), `findTenantById`, `findTenantBySlug`, `existsBySlug`.
- `platform.service.js`: 
  - `listTenants`, `getTenantById` (404 for `__platform`), 
  - `createTenantWithAdmin({name,slug,status,plan,admin})` — **single `prisma.$transaction`**: create tenant, seed `SYSTEM_PERMISSIONS`/`SYSTEM_ROLES` (admin→all, manager→exclude, member→read), create `User`+`TenantMembership`+`UserRole` (admin). On duplicate slug/email throws 409; never partially creates tenant.
  - `createTenantOnly` (same seeding without admin, for legacy), 
  - `updateTenant`, `updateTenantStatus`, `createTenantAdmin` (existing tenant + admin).
- `platform.validation.js`: Zod schemas for all endpoints (admin password requires upper/lower/digit/special).
- `platform.controller.js`: Thin wrappers returning `{success,data,meta,message}`.
- `platform.routes.js`: `platformRouter` at `/api/v1/platform`; all routes `authenticatePlatform()` + `authorizePlatform('platform:tenant:*')`. 
  - `GET /tenants` (read), `POST /tenants` (create), `GET /tenants/:id` (read), `PATCH /tenants/:id` (update), `PATCH /tenants/:id/status` (suspend), `POST /tenants/:id/admin` (create admin).
  - Fixed Express 5 `req.query` getter issue (merge instead of reassign).
- `src/app/routes.js`: Mounts `platformRouter` at `/api/v1/platform` alongside existing `tenantsRouter` (legacy public kept for backward compatibility, but platform is authoritative).

### 2.3 Authorization
- `src/modules/auth/authorization.middleware.js` unchanged except now used by platform routes; `authorize` continues to reject platform tokens (via authenticate), `authorizePlatform` used for platform.

### 2.4 Seeding
**File:** `prisma/seed.js` (idempotent)
- Imports `argon2`, defines `hashPassword` same as `password.util.js`.
- `PLATFORM_TENANT_SLUG='__platform'`, env overrides `PLATFORM_ADMIN_EMAIL/PASSWORD` defaulting to `sairram@gmail.com` / `Sairram@123`.
- `seedPlatformAdmin()`:
  - `upsert` Platform tenant (`{slug:'__platform', name:'Platform', status:'ACTIVE'}`),
  - `upsert` PlatformRole `platform_admin` + 6 `PlatformPermission` + `PlatformRolePermission`,
  - `findUnique` Platform user by email → create if missing (tenantId=platform, `emailVerified:true`, membership `ACTIVE`), else update `tenantId/status/emailVerified` and re-hash password only if `argon2.verify` fails → ensures hash rotation without duplicate,
  - Ensure `TenantMembership` exists,
  - `upsert` `PlatformUserRole`.
- `main()` now calls `seedPlatformAdmin()` first, then seeds business tenants (filters `slug not '__platform'`), creates `Development` if none.
- **Idempotency:** Multiple runs → single platform tenant + single platform user (tested via `user.findMany` count).

### 2.5 OpenAPI / Documentation
- `src/docs/paths/auth.js`: Updated `/auth/login` (added `scope`, `tenantSlug`, deprecation note for `tenantId`, response includes `scope`+`sessionId`), `/auth/forgot-password` (`tenantSlug`).
- New `src/docs/paths/platform.js`: Complete spec for 5 platform endpoints with security `bearerAuth`, 401/403/409.
- `src/docs/openapi.js`: Imports `platformPaths`, adds `Platform` tag, merges `...platformPaths` into `paths`; bumps description to mention dual-scope JWT and platform tenant.

### 2.6 No Unrelated Changes
- Did not rewrite modular-monolith, did not alter unrelated phases, did not invent customer/storefront APIs.
- Tenant resources (`/users`, `/products`, `/orders`, etc.) unchanged except they now reject `scope=platform` via `authenticate()`.

---

## 3. Endpoints Added / Changed

| Method | Path | Change | Auth | Description |
|--------|------|--------|------|-------------|
| POST | `/api/v1/auth/login` | **Changed** | public (rate-limited) | Now `scope` enum, `tenantId` legacy, `tenantSlug` new; auto-resolves tenant; supports `scope=platform` |
| POST | `/api/v1/auth/forgot-password` | **Changed** | public | Adds `tenantSlug`, auto-resolves |
| POST | `/api/v1/auth/refresh` | **Behavior** | public | Preserves scope (platform vs tenant) via stored RefreshToken tenant slug |
| GET | `/api/v1/auth/me` | **Changed** | tenant `authenticate()` | Now forwards scope; rejects platform tokens (403) |
| GET | `/api/v1/platform/tenants` | **Added** | `authenticatePlatform`+`platform:tenant:read` | List tenants (paginated, excludes `__platform`) |
| POST | `/api/v1/platform/tenants` | **Added** | `platform:tenant:create` | Create tenant + admin atomically |
| GET | `/api/v1/platform/tenants/:id` | **Added** | `platform:tenant:read` | Tenant detail |
| PATCH | `/api/v1/platform/tenants/:id` | **Added** | `platform:tenant:update` | Update tenant fields |
| PATCH | `/api/v1/platform/tenants/:id/status` | **Added** | `platform:tenant:suspend` | Activate/suspend |
| POST | `/api/v1/platform/tenants/:id/admin` | **Added** | `platform:tenant:create` | Create admin for existing tenant |

Legacy `POST /api/v1/tenants` (public) kept for backward compat but platform is now authoritative.

---

## 4. Request / Response Contracts

### 4.1 Tenant Login (default)
```http
POST /api/v1/auth/login
{ "email": "user@example.com", "password": "Str0ng!Pass" }
→ 200 { success:true, data:{ user, accessToken, refreshToken, sessionId, scope:"tenant" } }
```
- With explicit slug: `{email,password,tenantSlug:"acme-store"}`
- Legacy: `{email,password,tenantId:"uuid"}`

### 4.2 Platform Login
```http
POST /api/v1/auth/login
{ "email": "sairram@gmail.com", "password": "Sairram@123", "scope": "platform" }
→ 200 { success:true, data:{ user, accessToken, refreshToken, sessionId, scope:"platform" } }
```
- Invalid platform creds → `401 INVALID_CREDENTIALS` or `403 PLATFORM_ACCESS_DENIED` (non-platform user trying platform scope)

### 4.3 JWT Claims
```json
{
  "sub": "user-uuid",
  "tenantId": "tenant-uuid (platform tenant for platform scope)",
  "sessionId": "uuid",
  "email": "user@example.com",
  "scope": "platform|tenant",
  "iss": "pulseops",
  "aud": "pulseops-api",
  "exp": 900
}
```
- Tenant `authenticate` requires `scope!=platform`; Platform `authenticatePlatform` requires `scope==platform`.

### 4.4 Platform Create Tenant + Admin
```http
POST /api/v1/platform/tenants
Authorization: Bearer <platform_jwt>
{
  "name": "Acme Store",
  "slug": "acme-store",
  "status": "ACTIVE",
  "plan": "free",
  "admin": { "email":"admin@acme.example.com","password":"Str0ng!123","firstName":"Acme","lastName":"Admin" }
}
→ 201 { success:true, data:{ tenant:{id,name,slug,status,plan}, adminUser:{id,email,firstName,lastName,tenantId} } }
```
- Duplicate slug → 409 `TENANT_SLUG_EXISTS`
- Duplicate email (global) → 409 `USER_ALREADY_EXISTS`
- Reserved `__platform` → 400/403

### 4.5 Platform List
```http
GET /api/v1/platform/tenants?page=1&limit=20&status=ACTIVE&search=acme
→ 200 { success:true, data:[Tenant], meta:{page,limit,total,totalPages} }
```

---

## 5. Database Changes
- **No migration file added** (existing schema already supports platform RBAC + global email unique). Platform tenant is data, not schema.
- **Seed change only:** Creates/updates row in `tenants` where `slug='__platform'` and row in `users` where `email='sairram@gmail.com'` + `tenant_memberships` + `platform_user_roles`.
- **Verification:** `prisma validate` passes; `prisma seed` idempotent.

---

## 6. Seed Changes
- See Section 2.4. Uses `argon2id` (19456,2,1) same as `password.util.js`. No plaintext stored except seed input; hash stored in `users.passwordHash`. Logs never print password.
- Idempotency test: Run `node prisma/seed.js` twice → `SELECT count(*) FROM users WHERE email='sairram@gmail.com'` == 1.

---

## 7. Security Model

| Concern | Mitigation |
|---------|------------|
| **Tenant ID leakage** | Frontend no longer requires `tenantId`; login auto-resolves via email; `tenantSlug` is human-readable, not UUID; JWT authoritative for `tenantId` |
| **JWT trust** | Server derives `tenantId` from JWT + DB membership; never trusts client-supplied tenantId |
| **Scope separation** | `scope` claim distinguishes `platform` vs `tenant`; `authenticate()` rejects `platform` tokens on tenant routes (403 `PLATFORM_TOKEN_FORBIDDEN`), `authenticatePlatform()` rejects `tenant` (403 `PLATFORM_AUTH_REQUIRED`) |
| **Platform tenant isolation** | `__platform` slug filtered from `listTenants`, `getTenantById` 404, tenant login rejects `__platform` (403), socket auth rejects `__platform` |
| **Password storage** | `argon2id` hashing only; no plaintext in logs/JWT/API responses/frontend; seed hashes before insert |
| **API exposure** | Platform routes require `platform:tenant:*` via `authorizePlatform`; tenant routes require tenant `authorize`; Redis cache failures fall back to DB |
| **Socket** | Verifies `scope` + platform role or tenant membership; `socket.context` server-derived |
| **Rate limiting** | Auth limiter on `/auth/login`/`register`/`refresh`/`forgot-password`/`verify-email` |
| **CORS** | Explicit allowlist, no wildcard with credentials in production |

---

## 8. Tenant Isolation
- All tenant services query by `req.context.tenantId` (from JWT). Example: `prisma.product.findMany({where:{tenantId}})`.
- `AuthRepository.findUserByEmailAndTenant` filters `memberships.some({tenantId,status:'ACTIVE'})`.
- Test: Create Tenant A + Tenant B via platform; login each admin; `jwt.verify(token).tenantId` differ; Tenant A token cannot list Tenant B data (middleware ensures `authenticate` loads only membership for that tenantId → `USER_NOT_FOUND` if manipulated).

---

## 9. Tests

### 9.1 Automated Verification (custom script `scripts/platform-verify.js` — 18 checks, all PASS)
- Platform Admin login (sairram@gmail.com / Sairram@123, scope platform) → 200, `scope=platform`
- Invalid platform credentials → 401
- Platform tenant creation (atomic) → 201
- Duplicate slug → 409
- Duplicate email (global) → 409
- Tenant admin login (auto-resolved) → 200, `scope=tenant`, correct `tenantId`
- Tenant login via `tenantSlug` → 200
- Invalid tenant credentials → 401
- Platform auth: tenant user `GET /platform/tenants` → 403
- Tenant auth: platform token `GET /users` → 403 `PLATFORM_TOKEN_FORBIDDEN`
- Tenant isolation: Two tenants, `tenantId` differ
- Platform cannot become tenant-scoped: `GET /auth/me` with platform token → 403
- Tenant cannot access platform: `GET /platform/tenants/:id` with tenant token → 403
- JWT claims present (`email`, `scope`, `tenantId`, `sessionId`)
- Password hashing prefix `$argon2` verified via DB
- Tenant suspend → tenant login 403 `TENANT_INACTIVE`; reactivate → 200
- Platform `refresh`/`logout` rotation + revocation
- Seed idempotency (second seed run, count==1)
- List tenants excludes `__platform`, includes created tenants

### 9.2 Regression
- `tests/integration/auth.test.js` — 35/35 PASS (updated 2 tests from `TENANT_REQUIRED` to auto-resolution success per new contract)
- `tests/integration/tenants.test.js`, `phase5-rbac.test.js`, `phase6-users.test.js` — 109/109 PASS
- Lint: `npm run lint` → 0 errors
- Prisma: `npm run prisma:validate` → valid

### 9.3 Coverage of Spec §11 (31 items)
All 31 items verified via `platform-verify.js` + existing suites + manual DB checks. Known to be passing.

---

## 10. Known Backend Dependencies / Notes
- Requires `DATABASE_URL` and (optional) `REDIS_URL`; degraded mode if `FAIL_ON_DEPENDENCY_ERROR=false`.
- `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` must be ≥32 chars in production; tests use default `test-access-secret-min-32-chars-long-for-testing`.
- Platform tenant `__platform` is hidden but exists in DB; do not delete.
- Legacy `POST /tenants` remains public — recommend deprecating or adding platform auth once frontend migrates.
- Frontend must stop sending `tenantId` manually; use `scope` field. For tenant login, omit `tenantId`/`tenantSlug` to auto-resolve, or send `tenantSlug` for disambiguation.
- Storefront relationship: `Tenant` ↔ `TenantDomain` ↔ `Product` etc. All tenant resources already tenant-scoped via `req.context.tenantId`. No URL/localStorage tenant switching possible because JWT is authoritative.

---

## 11. Files Touched

```
src/modules/auth/auth.validation.js
src/modules/auth/auth.repository.js
src/modules/auth/auth.service.js
src/modules/auth/auth.middleware.js
src/modules/auth/auth.controller.js
src/modules/platform/platform.repository.js (new)
src/modules/platform/platform.service.js (new)
src/modules/platform/platform.validation.js (new)
src/modules/platform/platform.controller.js (new)
src/modules/platform/platform.routes.js (new)
src/app/routes.js
src/realtime/socket.auth.js
src/docs/paths/auth.js
src/docs/paths/platform.js (new)
src/docs/openapi.js
prisma/seed.js
tests/integration/auth.test.js (2 expectations updated)
```

---

## 12. How to Verify Manually

```bash
npm run db:seed
# Platform login
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"sairram@gmail.com","password":"Sairram@123","scope":"platform"}'
# Tenant creation (use platform token)
curl -X POST http://localhost:3000/api/v1/platform/tenants \
  -H "Authorization: Bearer <platform_token>" \
  -H "Content-Type: application/json" \
  -d '{"name":"Acme","slug":"acme","admin":{"email":"admin@acme.com","password":"Admin123!","firstName":"Admin","lastName":"One"}}'
# Tenant login (no tenantId)
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@acme.com","password":"Admin123!"}'
# Verify JWT scope
node -e "console.log(require('jsonwebtoken').decode('<token>'))"
node scripts/platform-verify.js  # full automated suite
```

---

**End Report**
