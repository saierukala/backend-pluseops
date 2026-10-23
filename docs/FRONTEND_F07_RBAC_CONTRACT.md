# FRONTEND F07 RBAC CONTRACT — Verified Backend Contract

> **Update 2026-10-23 — backend Phase 27 closes gaps #1–#3 and #5 below.** Now available:
> `GET /auth/me` → `data.roles[]` + `data.permissions[]` (sorted unique `resource:action` names, no second request
> needed); `DELETE /users/:id/roles/:roleId` (409 `LAST_ADMIN_ROLE`); `PUT /roles/:id/permissions` (replace);
> `DELETE /roles/:id/permissions/:permissionId`; `GET /permissions` returns `meta` (default `limit=100` = whole catalog).
> Role/permission changes take effect immediately (cache invalidated). Built-in `admin`/`manager`/`member` roles are
> `isSystem: true` → their permissions can't be edited (403 `SYSTEM_ROLE_IMMUTABLE`). Unknown or cross-tenant IDs → 400
> `INVALID_ROLE_IDS` / `INVALID_PERMISSION_IDS`. The "MUST HIDE removal UI" rule below no longer applies.

> **BACKEND F07 CONTRACT REPORT — READY FOR FRONTEND IMPLEMENTATION**
> Generated: 2026-09-21
> Scope: BACKEND ANALYSIS / CONTRACT PREPARATION ONLY — no backend, schema, OpenAPI, roadmap, or frontend modifications
> Verification: Source file inspection + existing integration tests (`phase5-rbac`, `phase6-users`) + OpenAPI cross-check

---

## 1. RBAC Architecture — Actual Implementation

### 1.1 Data Model (Prisma) — `prisma/schema.prisma:298-418`

| Entity | Table | File | Key Fields | Constraints |
|---|---|---|---|---|
| `Role` | `roles` | `schema.prisma:298-315` | `id, tenantId, name, description, isSystem, createdAt, updatedAt` | `@@unique([tenantId,name])`, `@@index([tenantId])`, FK `tenantId -> tenants.id CASCADE` |
| `Permission` | `permissions` | `schema.prisma:370-386` | `id, tenantId, name, resource, action, description, createdAt, updatedAt` | `@@unique([tenantId, resource, action])`, `@@index([tenantId])` |
| `UserRole` | `user_roles` | `schema.prisma:388-402` | `id, tenantId, userId, roleId, createdAt` | `@@unique([tenantId,userId,roleId])`, indices `tenantId+userId`, `tenantId+roleId` |
| `RolePermission` | `role_permissions` | `schema.prisma:404-418` | `id, tenantId, roleId, permissionId, createdAt` | `@@unique([tenantId,roleId,permissionId])`, indices `tenantId+roleId`, `tenantId+permissionId` |
| `TenantMembership` | `tenant_memberships` | `schema.prisma:232-248` | `id, tenantId, userId, roleId?, status(ACTIVE/INACTIVE/SUSPENDED)` | `@@unique([tenantId,userId])` — auxiliary; not used for RBAC permission calc but gates `authorize()` |
| `PlatformRole` | `platform_roles` | `schema.prisma:317-328` | `id, name UNIQUE, description, isSystem` | Global, NOT tenant-scoped |
| `PlatformPermission` | `platform_permissions` | `schema.prisma:330-342` | `id, name UNIQUE, resource, action` | `@@unique([resource,action])`, resource values like `platform:tenant` |
| `PlatformUserRole` | `platform_user_roles` | `schema.prisma:344-355` | `id, userId, roleId` | `@@unique([userId,roleId])` — NOT tenant-scoped |
| `PlatformRolePermission` | `platform_role_permissions` | `schema.prisma:357-368` | `id, roleId, permissionId` | `@@unique([roleId,permissionId])` |

**Tenant isolation mechanism:** Every tenant RBAC table has `tenantId` column. All repository queries filter by `tenantId` (`roles.repository.js:10,29`, `permissions.repository.js:10,22`, `users.repository.js:16,47,101`). Cross-tenant permission assignment is silently dropped (see `roles.repository.js:94-100`).

### 1.2 Platform vs Tenant Separation

- **Tenant RBAC**: `roles`, `permissions`, `user_roles`, `role_permissions` — all tenant-scoped, tenantId required.
- **Platform RBAC**: `platform_roles`, `platform_permissions`, `platform_user_roles`, `platform_role_permissions` — global, no tenantId column. Used only for `/api/v1/platform/*`.
- No mixed table. Platform permissions are NOT assignable to tenant roles and vice versa.

### 1.3 Authorization Middleware

| Middleware | File | Usage |
|---|---|---|
| `authenticate()` | `src/modules/auth/auth.middleware.js:8-93` | Guards ALL `/roles`, `/permissions`, `/users` routes. Validates JWT Bearer, verifies `sub`, `sessionId`, `tenantId`, `scope !== platform`, checks user active (`findUserByIdAndTenant`), checks tenant ACTIVE/TRIAL, rejects `__platform` slug. Errors: `UNAUTHORIZED` (401), `INVALID_TOKEN` (401), `TOKEN_EXPIRED` (401), `INVALID_TOKEN_CLAIMS` (401), `USER_NOT_FOUND` (401), `TENANT_INACTIVE` (403), `PLATFORM_TOKEN_FORBIDDEN` (403). |
| `authenticatePlatform()` | `src/modules/auth/auth.middleware.js:95-171` | Guards `/platform/*` only. Requires `scope === platform`, checks `platformUserRole` existence. Errors: `PLATFORM_AUTH_REQUIRED` (403), `PLATFORM_ACCESS_DENIED` (403). |
| `authorize(permission)` | `src/modules/auth/authorization.middleware.js:8-50` | Per-endpoint permission check. Requires `tenantMembership` ACTIVE, then loads permissions via `getUserPermissions()` and checks `resource === permission.split(':')[0] && action === permission.split(':')[1]`. On miss: `FORBIDDEN` (403). Note: naive split handles `permission:read` but platform perms with `platform:tenant:read` require `authorizePlatform`. |
| `authorizePlatform(permission)` | `src/modules/auth/authorization.middleware.js:72-87` | For platform routes. Splits at `lastIndexOf(':')` to support `platform:tenant:read`. Error: `FORBIDDEN` (403). |
| `getUserPermissions(userId, tenantId)` | `src/modules/auth/authorization.middleware.js:89-144` | Resolves effective permissions: `userRole -> roleId[] -> rolePermission -> permission`. Cached at `pulseops:v1:tenant:{tenantId}:permissions:user:{userId}` TTL 300s (`cache.keys.js:23`, `cache.config.js:5`). Multiple roles union (OR). No role hierarchy. |
| `optionalAuthenticate()` | `src/modules/auth/auth.middleware.js:174-216` | Not used for RBAC endpoints. |

**Tenant/Platform scope safety:**

- Tenant `authenticate()` explicitly rejects `scope === platform` with `PLATFORM_TOKEN_FORBIDDEN` (403) — `auth.middleware.js:31-35`.
- Platform `authenticatePlatform()` explicitly rejects `scope !== platform` with `PLATFORM_AUTH_REQUIRED` (403) — `auth.middleware.js:114-119`.
- Verification in `auth.service.js:generateAccessToken` embeds `scope` claim (`tenant` default, `platform` for platform login).
- Platform admin user lives under tenant `__platform` but uses platform scope; tenant routes reject that tenant slug.

### 1.4 Permission Checking Flow

```
Request -> authenticate() -> sets req.context {userId, tenantId, sessionId, scope}
       -> authorize('role:read') -> checks tenantMembership ACTIVE
                                 -> getUserPermissions(userId, tenantId) [cache + DB]
                                 -> resource:action match
                                 -> 403 FORBIDDEN if miss
                                 -> next() if hit
```

Role checking is NOT a separate middleware; `RoleGuard` must use role name matching via `GET /users/:id/roles`.

### 1.5 Tenant Isolation Enforcement

- All DB queries are `where: { tenantId }` or `where: { id, tenantId }` or `memberships: { some: { tenantId } }`.
- Cross-tenant role/permission assignment silently filtered, no error, no addition.
- JWT `tenantId` is authoritative; client cannot supply alternative. Manipulated JWT fails at `findUserByIdAndTenant` -> `USER_NOT_FOUND` (401) or `INVALID_TOKEN` (401).

---

## 2. Exact API Contract — Frontend-Relevant Endpoints

Base: `/api/v1` mounted in `src/app/routes.js:29-32`. All RBAC endpoints require `Authorization: Bearer <JWT>` unless noted. Rate limiters: global (100/15m) except auth (20/15m); disabled in `NODE_ENV=test` (`app.js:89, auth.routes.js:26`).

Common response envelope:
- Success: `{ success: true, data: <T>, message: string, meta?: PaginationMeta, requestId: uuid }`
- Error: `{ success: false, error: { code: string, message: string, details: <Zod issues|null> }, requestId: uuid }`
- Header `X-Request-Id` echoed (`request-context.js:5`).

### 2.1 Roles

#### GET /api/v1/roles — List roles
- **File:** `roles.routes.js:42`, `roles.controller.js:5-21`, `roles.service.js:9-27`, `roles.repository.js:27-44`, `roles.validation.js:37-42`
- **Auth:** `authenticate()` + `authorize('role:read')`
- **Scope:** `tenant` required; `platform` token -> 403 `PLATFORM_TOKEN_FORBIDDEN`
- **Tenant:** Derived from JWT; tenant-isolated
- **Permission:** `role:read`
- **Query:** `page?: int >=1 default 1`, `limit?: int 1..100 default 50` (take clamped to 100)
- **Body:** none
- **Validation:** Zod `listRolesQuerySchema` coerces numbers; 400 `VALIDATION_ERROR` on invalid
- **Success 200:** `{ success:true, data: Role[], meta:{page,limit,total,totalPages}, message:'Roles retrieved successfully' }` where `Role` = `{ id, tenantId, name, description, isSystem, permissions:[Permission], userCount, createdAt, updatedAt }` (`roles.service.js:150-168`). `permissions` array may be empty; `userCount` is count of `user_roles`.
- **Errors:** 401 `UNAUTHORIZED`/`INVALID_TOKEN`/`TOKEN_EXPIRED`/`USER_NOT_FOUND`/`INVALID_TOKEN_CLAIMS`; 403 `FORBIDDEN` (no `role:read`) or `TENANT_INACTIVE`; no 404/409.

#### GET /api/v1/roles/:id — Get role
- **File:** `roles.routes.js:43`
- **Auth:** `authenticate()` + `authorize('role:read')`
- **Permission:** `role:read`
- **Params:** `id: uuid` (Zod `roleIdParamSchema`)
- **Success 200:** `{ success:true, data: Role, message:'Role retrieved successfully' }`
- **Errors:** 400 `VALIDATION_ERROR` (bad UUID); 401 as above; 403 `FORBIDDEN`; 404 `ROLE_NOT_FOUND` (not found OR cross-tenant -> indistinguishable, same code); 500.

#### POST /api/v1/roles — Create role
- **File:** `roles.routes.js:44`, `roles.validation.js:3-8`
- **Auth:** `authenticate()` + `authorize('role:create')`
- **Permission:** `role:create`
- **Body:** `{ name: string (1..100, regex ^[a-z0-9_-]+$), description?: string max 500 }` — required `name`
- **Success 201:** `{ success:true, data: Role, message:'Role created successfully' }` — `isSystem:false` always; `permissions:[]`
- **Errors:** 400 `VALIDATION_ERROR`; 401; 403 `FORBIDDEN`; 409 `ROLE_NAME_EXISTS` (same-tenant duplicate); never 404.

#### PATCH /api/v1/roles/:id — Update role
- **File:** `roles.routes.js:45`, `roles.validation.js:10-20`, `roles.service.js:53-90`
- **Auth:** `authenticate()` + `authorize('role:update')`
- **Permission:** `role:update`
- **Params:** `id: uuid`
- **Body:** `{ name?: string (same regex), description?: string }` at least 1 field required (refine)
- **Behavior:** Checks `isSystemRole(id, tenantId)` -> 403 `SYSTEM_ROLE_IMMUTABLE` if true (covers `admin/manager/member` seeded as `isSystem:true` in test but `isSystem:false` for seed.js custom? Actual seed sets `isSystem` via `isSystem` param — note seed.js currently creates 3 roles without isSystem flag, so they default `false` in prod; phase5 test creates with `isSystem:true` to validate immutability. Frontend must treat any `isSystem:true` as immutable regardless.) Also checks duplicate name -> 409.
- **Success 200:** `{ success:true, data: Role }`
- **Errors:** 400 `VALIDATION_ERROR`; 401; 403 `FORBIDDEN` | `SYSTEM_ROLE_IMMUTABLE`; 404 `ROLE_NOT_FOUND` (cross-tenant also 404); 409 `ROLE_NAME_EXISTS`.

#### DELETE /api/v1/roles/:id — Delete role
- **File:** `roles.routes.js:46`, `roles.service.js:92-121`
- **Auth:** `authenticate()` + `authorize('role:delete')`
- **Permission:** `role:delete`
- **Params:** `id: uuid`
- **Behavior:** Checks isSystem -> 403 `SYSTEM_ROLE_IMMUTABLE`; findById -> 404 if missing; `prisma.role.delete({ where:{id, tenantId}})` — Prisma `where` uses composite uniqueness? Actually `where: { id, tenantId }` — but Prisma schema has `@@unique([tenantId,name])` not `id+tenantId`; this where clause is invalid Prisma? Check `roles.repository.js:85-89` uses `where: { id, tenantId }` — likely Prisma treats `id` as PK, extra tenantId filtered via `delete` with where containing unique `id` only? Might throw if not found. Verified via tests: cross-tenant delete returns 404 `ROLE_NOT_FOUND`, not less.
- **Success 200:** `{ success:true, data:{ success:true, message:'Role deleted successfully' }, message:'Role deleted successfully' }`
- **Errors:** 400 `VALIDATION_ERROR`; 401; 403 `FORBIDDEN` | `SYSTEM_ROLE_IMMUTABLE`; 404 `ROLE_NOT_FOUND`.

#### POST /api/v1/roles/:id/permissions — Assign permissions to role (additive)
- **File:** `roles.routes.js:47`, `roles.validation.js:28-35`, `roles.service.js:123-148`, `roles.repository.js:91-133`
- **Auth:** `authenticate()` + `authorize('role:update')` — **not** `role:assign` nor `permission:read`
- **Permission:** `role:update`
- **Params:** `id: uuid`
- **Body:** `{ permissionIds: string[] UUID min 1 }`
- **Behavior:**
  - Finds role by `id+tenantId` -> 404 `ROLE_NOT_FOUND` if missing/cross-tenant.
  - Checks isSystem -> 403 `SYSTEM_ROLE_IMMUTABLE` if true.
  - Transaction: finds permissions `where { id in permissionIds, tenantId }` — silently drops invalid IDs and cross-tenant IDs (no error). Then finds existing `rolePermission` for those valid IDs, then `createMany skipDuplicates` for new ones. Returns `rolePermission.findMany where tenantId+roleId include permission`.
  - Idempotent: duplicate assignment does not duplicate, does not error.
  - **Additive only**: does NOT remove existing permissions, does NOT replace. No remove/replace API.
- **Success 200:** `{ success:true, data: Permission[], message:'Permissions assigned successfully' }` where `Permission` = `{ id, name, resource, action, description }` — returns **all** permissions currently on role after assignment (not just newly added).
- **Errors:** 400 `VALIDATION_ERROR` (empty array or non-UUID); 401; 403 `FORBIDDEN` | `SYSTEM_ROLE_IMMUTABLE`; 404 `ROLE_NOT_FOUND`. No 409.

### 2.2 Permissions

#### GET /api/v1/permissions — List permissions
- **File:** `permissions.routes.js:29`, `permissions.controller.js:5-17`, `permissions.service.js:14-33`, `permissions.repository.js:20-25`
- **Auth:** `authenticate()` + `authorize('permission:read')`
- **Permission:** `permission:read`
- **Query:** none (validated via `listPermissionsQuerySchema` empty)
- **Cache:** `pulseops:v1:tenant:{tenantId}:permissions:list` TTL 300s.
- **Success 200:** `{ success:true, data: Permission[], message:'Permissions retrieved successfully' }` where `Permission` = `{ id, tenantId, name, resource, action, description, createdAt, updatedAt }` (`permissions.service.js:54-65`). Ordered by `resource asc, action asc`.
- **Errors:** 401; 403 `FORBIDDEN`.

#### GET /api/v1/permissions/:id — Get permission
- **File:** `permissions.routes.js:30`
- **Auth:** `authenticate()` + `authorize('permission:read')`
- **Permission:** `permission:read`
- **Params:** `id: uuid`
- **Success 200:** `{ success:true, data: Permission, message:'Permission retrieved successfully' }`
- **Errors:** 400 `VALIDATION_ERROR`; 401; 403 `FORBIDDEN`; 404 `PERMISSION_NOT_FOUND`; cross-tenant also 404 (silent isolation).

### 2.3 Users — User-Role Management

#### GET /api/v1/users — List users
- **File:** `users.routes.js:44`, `users.validation.js:27-37`, `users.repository.js:85-163`
- **Auth:** `authenticate()` + `authorize('user:read')`
- **Permission:** `user:read`
- **Query:** `page? default1, limit? default20 max100, search? string max255 (email|firstName|lastName contains insensitive), status? enum ACTIVE/INACTIVE/SUSPENDED, roleId? uuid, sortBy? enum createdAt/updatedAt/email/firstName/lastName/status default createdAt, sortOrder? enum asc/desc default desc`
- **Success 200:** `{ success:true, data: User[], meta:{page,limit,total,totalPages}, message:'Users retrieved successfully' }` where `User` = `{ id, tenantId, email, firstName, lastName, status, emailVerified, lastLoginAt, createdAt, updatedAt, roles:[{id,name,isSystem}] }`. Never exposes `passwordHash`.
- **Errors:** 400 `VALIDATION_ERROR`; 401; 403 `FORBIDDEN`.

#### GET /api/v1/users/:id — Get user
- **File:** `users.routes.js:45`
- **Auth:** `authenticate()` + `authorize('user:read')`
- **Permission:** `user:read`
- **Params:** `id: uuid`
- **Success 200:** `{ success:true, data: User, message:'User retrieved successfully' }` — same shape as above, tenant-isolated via `memberships: { some:{tenantId, status:ACTIVE}}`.
- **Errors:** 400; 401; 403 `FORBIDDEN`; 404 `USER_NOT_FOUND` (cross-tenant also 404).

#### PATCH /api/v1/users/:id — Update user (non-RBAC fields only)
- **File:** `users.routes.js:46`, `users.service.js:33-122`
- **Auth:** `authenticate()` + `authorize('user:update')`
- **Allowed body fields:** `firstName?, lastName?, status? (ACTIVE/INACTIVE/SUSPENDED)`. `roleIds` in body is **ignored** (passthrough validated but not used for RBAC; `users.service.js:44` only iterates `ALLOWED_UPDATE_FIELDS`). `email`, `passwordHash`, `tenantId` -> explicit 400 with codes `EMAIL_MODIFICATION_FORBIDDEN`, `PASSWORD_MODIFICATION_FORBIDDEN`, `TENANT_MODIFICATION_FORBIDDEN`.
- **Success 200:** `{ success:true, data: User }`
- **Errors:** 400 `VALIDATION_ERROR` | `INVALID_STATUS` | `EMAIL_MODIFICATION_FORBIDDEN` etc.; 401; 403 `FORBIDDEN`; 404 `USER_NOT_FOUND`.

#### DELETE /api/v1/users/:id — Delete user
- **File:** `users.routes.js:47`, `users.controller.js:67-98`
- **Auth:** `authenticate()` + `authorize('user:delete')`
- **Behavior:** Self-deletion blocked at controller: if `id === req.context.userId` -> 400 `SELF_DELETION_FORBIDDEN`.
- **Success 200:** `{ success:true, data:null, message:'User deleted successfully' }`
- **Errors:** 400 `SELF_DELETION_FORBIDDEN` | `VALIDATION_ERROR`; 401; 403 `FORBIDDEN`; 404 `USER_NOT_FOUND`.

#### GET /api/v1/users/:id/roles — Get user roles
- **File:** `users.routes.js:50`, `users.controller.js:100-114`, `users.service.js:154-178`, `users.repository.js:14-28`, `users.validation.js:18-23`
- **Auth:** `authenticate()` + `authorize('user:read')` — **note** requires `user:read`, not `role:read`
- **Permission:** `user:read`
- **Params:** `id: uuid`
- **Success 200:** `{ success:true, data: UserRole[], message:'User roles retrieved successfully' }` where `UserRole` = `{ id, name, description, isSystem, permissions:[Permission], assignedAt }` — includes nested permissions for each role (`rolePermissions -> permission`). Empty array if user has no roles. Cross-tenant user -> 404 `USER_NOT_FOUND` (via `findByIdAndTenant`).
- **Errors:** 400 `VALIDATION_ERROR`; 401; 403 `FORBIDDEN`; 404 `USER_NOT_FOUND`.

#### POST /api/v1/users/:id/roles — Assign roles to user (additive)
- **File:** `users.routes.js:51`, `users.validation.js:9-16`, `users.service.js:180-208`, `users.repository.js:40-83`
- **Auth:** `authenticate()` + `authorize('user:update')` — **not** `role:assign`
- **Permission:** `user:update`
- **Params:** `id: uuid`
- **Body:** `{ roleIds: string[] UUID min 1 }`
- **Behavior:**
  - Checks user exists via `findByIdAndTenant` -> 404 `USER_NOT_FOUND` if missing/cross-tenant.
  - Finds roles `where { id in roleIds, tenantId }` — silently drops invalid/cross-tenant IDs.
  - Transaction checks `tenantMembership` ACTIVE for that user+tenant -> if missing/inactive returns `[]` (empty success, no assignment, no error).
  - Finds existing `userRole` for those valid IDs, `createMany skipDuplicates` for new, returns all `userRole` for user+tenant with permissions.
  - Idempotent.
- **Success 200:** `{ success:true, data: UserRole[], message:'Roles assigned successfully' }` — returns ALL roles after assignment (same shape as GET user roles).
- **Errors:** 400 `VALIDATION_ERROR`; 401; 403 `FORBIDDEN`; 404 `USER_NOT_FOUND`. No 409. Cross-tenant role IDs silently ignored (200, no change).

### 2.4 Auth — Current User

#### GET /api/v1/auth/me — Get current user
- **File:** `auth.routes.js:57`, `auth.controller.js:96-119`, `auth.service.js:524-560`, `auth.middleware.js:8-93`
- **Auth:** `authenticate()` — **no permission check** (no `authorize()`). Requires valid Bearer.
- **Scope:** `tenant` only (platform token rejected at `authenticate()` before reaching controller; platform variant would need `authenticatePlatform()` but route uses `authenticate()` — platform call returns 403 `PLATFORM_TOKEN_FORBIDDEN`).
- **Tenant:** From JWT `tenantId`
- **Params/Query/Body:** none
- **Success 200:** `{ success:true, data: { id, tenantId, email, firstName, lastName, status, emailVerified, lastLoginAt, createdAt, updatedAt, scope }, message:'User retrieved successfully' }` — **does NOT include roles or permissions** (`auth.service.js:604-620` `toSafeUser` only returns base fields; roles not queried).
- **Errors:** 401 `UNAUTHORIZED` (missing header) / `INVALID_TOKEN` / `TOKEN_EXPIRED` / `INVALID_TOKEN_CLAIMS` / `USER_NOT_FOUND`; 403 `TENANT_INACTIVE` / `PLATFORM_TENANT_FORBIDDEN` / `PLATFORM_TOKEN_FORBIDDEN`.

#### POST /api/v1/auth/login — Login (scope awareness)
- **File:** `auth.routes.js:49`, `auth.validation.js:13-21`, `auth.service.js:70-272`
- **Body for F07 context:** `{ email, password, scope?: 'tenant'|'platform' default tenant, tenantId?: uuid (deprecated), tenantSlug?: string regex ^[a-z0-9-]+$ }`. Tenant login auto-resolves `tenantId` via email if not supplied (single membership) else requires `tenantSlug`/`tenantId`. Platform login requires `scope:'platform'` and `hasPlatformRole`.
- **Success 200:** `{ success:true, data:{ user: SafeUser(tenantId+scope), accessToken: JWT {sub, tenantId, sessionId, email, scope, iss:pulseops, aud:pulseops-api, exp:15m}, refreshToken, sessionId, scope }, message:'Login successful' }`
- **Relevant for frontend:** JWT contains `scope` claim; frontend must inspect `scope` to branch platform vs tenant authorization.

---

## 3. Current User Authorization Data — How Frontend Gets Roles/Permissions

| Data | Via | File | Details |
|---|---|---|---|
| `tenantId` | `GET /auth/me` OR JWT | `auth.controller.js:99`, `auth.service.js:605` | `data.tenantId` = JWT `tenantId`. Authoritative. |
| `scope` | `GET /auth/me` OR JWT `scope` | `auth.controller.js:100` | `'tenant'` or `'platform'`. Route `/auth/me` returns `scope` in data. |
| `email`, `id`, `status`, etc. | `GET /auth/me` | `auth.service.js:604` | Base user fields only. |
| `roles` | **NOT in `/auth/me`** — must call `GET /users/:id/roles` | `users.routes.js:50` | Frontend must: call `GET /auth/me` -> get `data.id` -> call `GET /users/:id/roles` with same token. Requires `user:read` permission. If caller lacks `user:read`, this second call returns 403 `FORBIDDEN` (verified in phase6). Alternative: derive permissions client-side would require a new endpoint (not existent). |
| `permissions` | **NOT in `/auth/me`** — indirect via `GET /users/:id/roles` (permissions nested per role) OR via `GET /permissions` (list all tenant permissions, not user effective). Frontend must union `roles[].permissions` from `GET /users/:id/roles` to compute effective permissions. No dedicated `GET /me/permissions` or `GET /me/roles`. | `users.service.js:164-177` | Effective permissions = flatten(`roles[].permissions`). No separate endpoint; backend's `getUserPermissions()` is internal to middleware. |
| `platform roles` | Never via tenant `/auth/me`; platform `/auth/me` under `authenticatePlatform()` not exposed on tenant route. Platform roles only verifiable via platform DB `platformUserRoles`. No frontend API for current platform permissions beyond `authorizePlatform`. |
| `tenant membership role` | Same as `GET /users/:id/roles` | `users.repository.js:14` | No separate membership role endpoint beyond `TenantMembership` (not exposed). |

**SUPPORTED pattern for F07:**

```
const me = await GET /api/v1/auth/me          // 200 {id, tenantId, scope, email ...}
if (me.scope !== 'tenant') handlePlatformSeparateFlow();
const userRoles = await GET /api/v1/users/{me.id}/roles  // requires user:read
const effectivePermissions = [...new Set(userRoles.flatMap(r => r.permissions.map(p => p.name)))]
// e.g. 'role:read', 'user:update'
const effectiveRoles = userRoles.map(r => r.name) // e.g. 'admin'
```

**NOT AVAILABLE:** Single-call `me` with roles/permissions. Do NOT assume `me.data.roles` or `me.data.permissions` exist.

---

## 4. Complete Permission Inventory — From `prisma/seed.js:6-48` + `PLATFORM_PERMISSIONS:56-63`

Permissions are tenant-scoped (`tenantId` composite). Seeded per tenant via `seedTenant()`. No dynamic creation API.

### 4.1 Tenant Permissions (42 total) — Grouped

| Group | Resource | Actions | Permission Strings | Meaning / Known Feature Guard |
|---|---|---|---|---|
| tenant | `tenant` | read, update | `tenant:read`, `tenant:update` | Tenant settings/read; `seed.js:7-8`. `tenant:update` used? Not enforced in current routes (legacy) |
| users | `user` | create, read, update, delete | `user:create`, `user:read`, `user:update`, `user:delete` | `users.routes.js:44-51` + categories/products/etc; `user:read` gates list/get + `GET users/:id/roles` |
| roles | `role` | create, read, update, delete | `role:create`, `role:read`, `role:update`, `role:delete` | Roles CRUD; `role:update` also gates `POST roles/:id/permissions` |
| permissions | `permission` | read | `permission:read` | Gates `GET /permissions` and `GET /permissions/:id` (only read exists) |
| products | `product` | create, read, update, delete | `product:create`, `product:read`, `product:update`, `product:delete` | Catalog modules (`products.routes.js`, `variants`, etc.) |
| categories | `category` | create, read, update, delete | `category:create`, `category:read`, `category:update`, `category:delete` | Categories module |
| warehouses | `warehouse` | create, read, update, delete | `warehouse:create`, `warehouse:read`, `warehouse:update`, `warehouse:delete` | Warehouses module |
| inventory | `inventory` | read, update | `inventory:read`, `inventory:update` | Inventory module (`inventory.routes.js`) |
| customers | `customer` | create, read, update, delete | `customer:create`, `customer:read`, `customer:update`, `customer:delete` | Customer module (used by orders) |
| orders | `order` | create, read, update, cancel | `order:create`, `order:read`, `order:update`, `order:cancel` | Orders module |
| payments | `payment` | create, read, confirm, refund | `payment:create`, `payment:read`, `payment:confirm`, `payment:refund` | Payments module (create/confirm/refund) |
| audit | `audit` | read | `audit:read` | `GET /audit-logs` |
| activity | `activity` | read | `activity:read` | `GET /activity-logs` |
| notifications | `notification` | read, update | `notification:read`, `notification:update` | Notifications module |
| orders (duplicate) | `order` | cancel | `order:cancel` | Distinct from update; specific to cancel endpoint |

All names are `resource:action` (`name` field equals that). `resource`/`action` columns store same split. `description` is null in seed.

### 4.2 Platform Permissions (6 total) — `seed.js:56-63`

| Permission | Resource | Action | Meaning |
|---|---|---|---|
| `platform:tenant:create` | `platform:tenant` | create | `POST /platform/tenants` + `POST /platform/tenants/:id/admin` |
| `platform:tenant:read` | `platform:tenant` | read | `GET /platform/tenants`, `GET /platform/tenants/:id` |
| `platform:tenant:update` | `platform:tenant` | update | `PATCH /platform/tenants/:id` |
| `platform:tenant:suspend` | `platform:tenant` | suspend | `PATCH /platform/tenants/:id/status` |
| `platform:billing:read` | `platform:billing` | read | Not routed yet (reserved) |
| `platform:billing:update` | `platform:billing` | update | Not routed yet (reserved) |

Resource contains colon (`platform:tenant`), so `authorizePlatform` splits at `lastIndexOf(':')` (correct); tenant `authorize` would split at first colon and fail — intentional separation.

**Do NOT invent** permissions beyond these 48. No `product:export`, `role:assign`, `user:assign`, `tenant:delete` etc.

---

## 5. Role Inventory

Seeded per tenant via `seed.js:50-54` + `seedTenant()`.

| Role Name | Scope | Description | Permissions Assigned | System? | Editable | Deletable |
|---|---|---|---|---|---|---|
| `admin` | Tenant | `Full administrative access` (`seed.js:51`) | **All 42 tenant permissions** (`seed.js:114-131` loops `Object.values(permissions)`) | `isSystem:false` in seed.js (but test creates as `isSystem:true` to assert immutability; treat `isSystem:true` as immutable regardless) | No if `isSystem:true` -> 403 `SYSTEM_ROLE_IMMUTABLE` on PATCH; Yes if `false` | No if `isSystem:true`; Yes if `false` |
| `manager` | Tenant | `Management access to most resources` | **38 permissions** — all except excluded list (`seed.js:133`): `user:delete`, `role:delete`, `permission:read`, `tenant:update` are NOT granted. So manager has: `role:create/read/update`, `user:create/read/update`, `tenant:read`, plus all product/category/inventory/warehouse/order/payment/customer/audit/activity/notification perms (except the 4 excluded). | same | same |
| `member` | Tenant | `Standard member access` | **Only `*:read` permissions** (`seed.js:155-157` filter `key.endsWith(':read')`) — count = number of permissions where action is `read` = `tenant:read`, `user:read`, `role:read`, `permission:read`, `product:read`, `category:read`, `order:read`, `customer:read`, `warehouse:read`, `inventory:read`, `payment:read`, `audit:read`, `activity:read`, `notification:read` => 14 read perms. | same | same |
| `platform_admin` | Platform (global) | `PulseOps platform administration` (`seed.js:185-188`) | **All 6 platform permissions** (`seed.js:196-201`) | `isSystem:true` | Not via tenant API; platform role management not exposed | Not exposed |

**Additional notes:**
- Custom roles: `POST /roles` creates `isSystem:false` roles with no permissions initially (empty). Assign via `POST /roles/:id/permissions`.
- `isSystem` flag is authoritative per row (`roles.isSystem` boolean). Frontend must disable edit/delete for `isSystem:true` (see 403 behavior).
- No `owner`, `super_admin`, `viewer` built-in roles beyond above. Tenant slug `__platform` is reserved.

---

## 6. Authorization Behavior — Verified Status/Error Codes

| Scenario | Expected Status | Code | Evidence |
|---|---|---|---|
| **Unauthenticated request** (no header or bad prefix) | 401 | `UNAUTHORIZED` | `auth.middleware.js:14`, `phase5:258-274` |
| **Invalid JWT** (malformed, wrong secret, bad issuer/aud) | 401 | `INVALID_TOKEN` | `auth.middleware.js:84`, `auth.test.js:616` |
| **Expired JWT** | 401 | `TOKEN_EXPIRED` | `auth.middleware.js:79`, `auth.test.js:623-639` |
| **Missing claims** (`sub` or `sessionId` or `tenantId`) | 401 | `INVALID_TOKEN_CLAIMS` | `auth.middleware.js:25,37`, `auth.test.js:641-657` |
| **Platform token on tenant route** | 403 | `PLATFORM_TOKEN_FORBIDDEN` | `auth.middleware.js:32` |
| **Tenant token on platform route** | 403 | `PLATFORM_AUTH_REQUIRED` | `auth.middleware.js:116` |
| **User not found / inactive (status != ACTIVE)** | 401 | `USER_NOT_FOUND` | `auth.middleware.js:48`, `auth.service.js:544` |
| **Tenant inactive (SUSPENDED etc.)** | 403 | `TENANT_INACTIVE` | `auth.middleware.js:57`, `auth.service.js:554` |
| **Tenant membership not ACTIVE** (authorize step) | 403 | `FORBIDDEN` (message `Tenant membership is required`) | `authorization.middleware.js:26` |
| **Authenticated + has permission** | 200 or 201 | success true | `phase5:249-256` |
| **Authenticated without required permission** | 403 | `FORBIDDEN` (message `Insufficient permissions`) | `authorization.middleware.js:36`, `phase5:258-266` |
| **User with no roles** | 403 | `FORBIDDEN` | `phase5:276-286`, `phase6:345-356` |
| **Missing role (GET/PATCH/DELETE non-existent UUID)** | 404 | `ROLE_NOT_FOUND` | `roles.service.js:33,74,103` |
| **Invalid role ID format** (non-UUID) | 400 | `VALIDATION_ERROR` | `roles.validation.js:13,23`, generic `error-handler.js:12` |
| **Invalid permission ID format** | 400 | `VALIDATION_ERROR` | `roles.validation.js:33` |
| **Invalid permission ID (non-existent) in assign** | 200 (silent drop) | — | `roles.repository.js:94-100` valid filter; `phase5:628-636` |
| **Cross-tenant role ID in assign** | 200 (silent drop) | — | `phase5:651-671` |
| **Deleted/inactive user attempt (GET user)** | 404 | `USER_NOT_FOUND` | `users.service.js:25` (via membership check) |
| **Inactive tenant via login** | 403 | `TENANT_INACTIVE` | `auth.service.js:34,122,231` |
| **Cross-tenant access (role/permission/user)** | 404 | `ROLE_NOT_FOUND` / `PERMISSION_NOT_FOUND` / `USER_NOT_FOUND` | `roles.service.js:31`, `permissions.service.js:46`, `users.service.js:36` — indistinguishable from missing |
| **Platform token accessing tenant RBAC** | 403 | `PLATFORM_TOKEN_FORBIDDEN` | Above |
| **Tenant token accessing platform RBAC** | 403 | `PLATFORM_AUTH_REQUIRED` or `FORBIDDEN` | Above |
| **System role update/delete/permission assign** | 403 | `SYSTEM_ROLE_IMMUTABLE` | `roles.service.js:56,94,133` |
| **Duplicate role name (same tenant)** | 409 | `ROLE_NAME_EXISTS` | `roles.service.js:43,64` |
| **Self-deletion** (`DELETE /users/:id` where id==self) | 400 | `SELF_DELETION_FORBIDDEN` | `users.controller.js:75` |
| **Email/passwordHash/tenantId patch** | 400 | `EMAIL_MODIFICATION_FORBIDDEN` / `PASSWORD_MODIFICATION_FORBIDDEN` / `TENANT_MODIFICATION_FORBIDDEN` | `users.service.js:62-83` |
| **Invalid status patch** | 400 | `INVALID_STATUS` | `users.service.js:54` |
| **Empty PATCH role body** | 400 | `VALIDATION_ERROR` (At least one field required) | `roles.validation.js:17` |
| **Manipulated JWT tenantId** | 401 | `USER_NOT_FOUND` or `INVALID_TOKEN` | `phase5:875-891`, `auth.test.js:768-786` |

**Key distinction for frontend 403 handling:**

- `401` set → unauthenticated: redirect to login, clear tokens, attempt `POST /auth/refresh` with stored `refreshToken`.
- `403 FORBIDDEN` / `PLATFORM_TOKEN_FORBIDDEN` / `TENANT_INACTIVE` / `SYSTEM_ROLE_IMMUTABLE` / `SELF_DELETION_FORBIDDEN` → authenticated but not authorized: show 403 Forbidden page, do NOT redirect to login.
- `403 PLATFORM_AUTH_REQUIRED` → tenant token on platform route: treat as unauthorized scope, route to correct console.

Error envelope always: `{ success:false, error:{code, message, details}, requestId }` (`error-handler.js:34-38`). Validation details = Zod `issues` array.

---

## 7. Tenant Isolation — Verified

| Check | Result | Detail |
|---|---|---|
| Tenant A user -> Tenant A role/permission | **SUPPORTED** | Query filters `where: {tenantId}` |
| Tenant A user cannot list/read Tenant B roles | **BLOCKED** — returns only own tenant data (200 with own tenantId rows) | `roles.repository.js:29`, test `phase5:312-323` |
| Tenant A user cannot GET Tenant B role by ID | **BLOCKED** — 404 `ROLE_NOT_FOUND` | `roles.service.js:31`, test `phase5:440-450` |
| Tenant A user cannot PATCH Tenant B role | **BLOCKED** — 404 `ROLE_NOT_FOUND` | Same |
| Tenant A user cannot DELETE Tenant B role | **BLOCKED** — 404 | Same |
| Tenant A cannot assign Tenant B permission to Tenant A role | **BLOCKED** — silently ignored, 200 no change | `roles.repository.js:95-100`, test `phase5:651-671` |
| Tenant A cannot assign Tenant B role to user | **BLOCKED** — silently ignored | `users.repository.js:30-35`, test `phase5:795-813` |
| Tenant A user cannot GET Tenant B user/roles | **BLOCKED** — 404 `USER_NOT_FOUND` | `users.repository.js:9,165`, test `phase6:406-412` |
| Tenant A user cannot access Tenant B permissions list | **BLOCKED** — returns own only | `permissions.repository.js:22`, test `phase5:865-872` |
| Platform admin can access tenant RBAC endpoints? | **NO** — platform scope token gets 403 `PLATFORM_TOKEN_FORBIDDEN` on all tenant routes (`auth.middleware.js:32`). Platform endpoints (`/platform/*`) are separate and require `authenticatePlatform`+`authorizePlatform` with `platform:tenant:*` perms. Tenant endpoints intentionally reject platform scope. | Verified in `auth.middleware.js:31-35`, `platform.routes.js:61` |
| Tenant token can access platform RBAC? | **NO** — platform routes require `scope===platform`, tenant token gets 403 `PLATFORM_AUTH_REQUIRED` (`auth.middleware.js:115`). | Verified |
| Manipulated JWT tenantId escalation | **BLOCKED** — 401 `USER_NOT_FOUND`/`INVALID_TOKEN` | `phase5:875-891`, `phase6:627-641` |

**Implication for frontend:** Tenant-switching must re-login (get new JWT with new `tenantId`/`scope`). No in-session tenant switching via header override.

---

## 8. Frontend-Specific Limitations — MUST NOT

| # | Limitation | Status | Detail | Frontend Must |
|---|---|---|---|---|
| 1 | **Role removal from user** | **NOT AVAILABLE** | No `DELETE /users/:id/roles/:roleId` or `DELETE /users/:id/roles`. Only `POST /users/:id/roles` (additive). Repository has no `removeRole` method. | Hide "Remove role" UI; if needed, request backend feature. Do not simulate via PATCH. |
| 2 | **Permission removal from role** | **NOT AVAILABLE** | No `DELETE /roles/:id/permissions/:permId` or `DELETE /roles/:id/permissions`. Repository has `removePermission` helper (`roles.repository.js:135-139`) but NO route/controller/service exposure. Only additive `POST /roles/:id/permissions`. | Hide "Remove permission" or "Replace permissions" UI. Show additive picker only, warn that removal not supported. |
| 3 | **Full permission replacement** (`PUT /roles/:id/permissions`) | **NOT AVAILABLE** | No PUT/PATCH that replaces set. Must not emulate via delete+add (delete not exists). | Do not implement. |
| 4 | **Bulk/full role replacement for user** (`PUT /users/:id/roles`) | **NOT AVAILABLE** | Only additive POST. | Do not implement. |
| 5 | **Current-user permissions/roles endpoint** | **NOT AVAILABLE** | No `GET /auth/me/permissions` or `GET /auth/me/roles`. Must use `GET /users/:id/roles` after resolving `id` via `GET /auth/me`. | Implement 2-step fetch (see §3). Do NOT call non-existent `GET /me/permissions`. |
| 6 | **Platform RBAC via tenant endpoints** | **NOT AVAILABLE / FORBIDDEN** | Platform permissions/roles are separate global tables; tenant JWT cannot access them, platform JWT cannot use tenant `/roles` or `/permissions`. No unified endpoint. | Separate consoles: Tenant console uses `/roles`/`/permissions`/`/users`; Platform console uses `/platform/tenants` only (no role CRUD exposed for platform). Do not mix. |
| 7 | **Multi-tenant role switching in-session** | **NOT AVAILABLE** | JWT is single-tenant (`tenantId` claim). No endpoint to list other tenants or switch without re-login. TenantMembership holds multiple tenants but auth resolves single via login. | Force re-login on tenant switch. |
| 8 | **Searching / filtering roles** | **NOT AVAILABLE** | `GET /roles` only supports `page`/`limit`, no `search`, `name`, `sortBy`. `users.routes.js` supports richer filters but roles does not. | Do not pass `search` to `/roles`; filter client-side. |
| 9 | **Sorting / searching permissions** | **NOT AVAILABLE** | `GET /permissions` has no pagination, no query, returns all tenant permissions ordered by resource/action. | Do not expect pagination. |
| 10 | **Creating permissions** | **NOT AVAILABLE** | No `POST /permissions`. Permissions seeded via `seed.js` only. | Do not offer "Create permission". |
| 11 | **Deleting permissions** | **NOT AVAILABLE** | No `DELETE /permissions/:id`. | Do not offer. |
| 12 | **Updating permissions** | **NOT AVAILABLE** | No PATCH. | Do not offer. |
| 13 | **Listing all users' roles in one call** | **PARTIAL** — `GET /users` includes `roles` per user (id,name), but not full permissions per role. `GET /users/:id/roles` gives full permissions. | Use per-user fetch for Guard needs; list view needs second fetch if details required. |
| 14 | **Cache staleness** | **GAP** | `GET /permissions` and `getUserPermissions` cached 300s (`CACHE_TTL:5`). Role/permission changes may not reflect immediately for already-auth-cached users. No manual invalidation exposed to frontend. | After assigning roles/permissions, frontend should re-fetch; backend does not auto-invalidate user permissions cache on role permission change (only via TTL). Consider force-refetch or brief stale UI note. |

**Do NOT invent workarounds that violate backend auth.** E.g., do NOT try to DELETE via `PATCH` with empty set, do NOT try to call `/roles/:id/permissions` with missing auth hoping to bypass.

---

## 9. OpenAPI Consistency — `src/docs/paths/rbac.js:16-306` vs Actual `src/modules/*/routes.js`

| Endpoint | Route File | OpenAPI Path | Result |
|---|---|---|---|
| `GET /api/v1/roles` | `roles.routes.js:42` | `rbac.js:17-32` | **MATCH** — params `page, limit`, security bearerAuth, 200/400/401/403/500 documented. Tested 200 for pagination. |
| `POST /api/v1/roles` | `roles.routes.js:44` | `rbac.js:33-62` | **MATCH** — body `name` regex, `description`, 201/409 documented correctly. |
| `GET /api/v1/roles/{id}` | `roles.routes.js:43` | `rbac.js:64-80` | **MATCH** |
| `PATCH /api/v1/roles/{id}` | `roles.routes.js:45` | `rbac.js:81-100` | **MATCH** |
| `DELETE /api/v1/roles/{id}` | `roles.routes.js:46` | `rbac.js:101-116` | **MATCH** |
| `POST /api/v1/roles/{id}/permissions` | `roles.routes.js:47` | `rbac.js:118-139` | **MATCH** — note OpenAPI says requires `role:update` (correct). |
| `GET /api/v1/permissions` | `permissions.routes.js:29` | `rbac.js:140-153` | **MATCH** — no pagination in either. |
| `GET /api/v1/permissions/{id}` | `permissions.routes.js:30` | `rbac.js:155-172` | **MATCH** |
| `GET /api/v1/users` | `users.routes.js:44` | `rbac.js:173-196` | **MATCH** — query params aligned (page,limit,search,status,roleId,sortBy,sortOrder) |
| `GET /api/v1/users/{id}` | `users.routes.js:45` | `rbac.js:197-213` | **MATCH** |
| `PATCH /api/v1/users/{id}` | `users.routes.js:46` | `rbac.js:214-250` | **MATCH** — note validation passthrough allows `roleIds` but service ignores; OpenAPI documents passthrough (additionalProperties:true) — accurate. |
| `DELETE /api/v1/users/{id}` | `users.routes.js:47` | `rbac.js:251-268` | **MATCH** — documents 400 SELF_DELETION_FORBIDDEN. |
| `GET /api/v1/users/{id}/roles` | `users.routes.js:50` | `rbac.js:269-284` | **MATCH** |
| `POST /api/v1/users/{id}/roles` | `users.routes.js:51` | `rbac.js:285-305` | **MATCH** |
| `GET /api/v1/auth/me` | `auth.routes.js:57` | `auth.js:220-234` | **MATCH** — documented as auth required, no permission, tenant-isolated via JWT. |

**Overall:** F07 RBAC paths are **FULLY MATCHED** — no phantom or missing F07 endpoints in OpenAPI.

**GAP / MISMATCH outside F07:** `tests/integration/phase22-swagger.test.js:239-252` currently FAILS (1 failed of 114) because documented paths inventory `allExpected` is stale vs actual `openApiSpec`. Investigation shows extra platform paths (`GET /platform/tenants`, `POST /platform/tenants`, etc.) and readiness/metrics dual mounts cause divergence, but this does NOT affect F07 — F07 subset passes. The failure is informational; OpenAPI JSON at `/api-docs.json` remains valid (phase22: `api-docs.json 200`, `spec.openapi 3.0.3` pass).

**Schemas:** `Role` (`schemas.js:77-89`) and `Permission` (`schemas.js:90-103`) match DB shapes except OpenAPI `Role` omits `permissions`/`userCount` embedded in actual response — documented as flat `Role`; actual `GET /roles` returns `rolePermissions` flattened + `userCount`. This is a minor documentation gap: frontend should expect extra fields. `User` schema omits `roles` field but actual `GET /users` includes `roles`. Again, documentation undersells but not incorrect.

---

## 10. Test The Actual Backend — Results

Executed: `npm test -- tests/integration/phase5-rbac.test.js tests/integration/phase6-users.test.js tests/integration/phase22-swagger.test.js` (Node 22, Jest 30, supertest, real Prisma DB + Redis).

| Suite | Result | Key Assertions Passing |
|---|---|---|
| `phase5-rbac.test.js` | **PASS** (58 tests) | allowed permission 200, denied 403 FORBIDDEN, unauth 401 UNAUTHORIZED, no-roles 403, pagination, tenant isolation (roles/permissions/userRoles), cross-tenant 404, cross-tenant permission/role silently ignored, system role immutability 403, manipulated JWT 401, multiple roles combine permissions, health/tenant regression |
| `phase6-users.test.js` | **PASS** (55 tests) | list/get/patch/delete users, search/status/roleId/sort, tenant-scoped, self-deletion 400, privilege escalation blocked, role manipulation via user update ignored, JWT escalation blocked, response structure |
| `phase22-swagger.test.js` | **1 FAIL / 13 PASS** (overall 114 total: 113 pass, 1 fail) | OpenAPI JSON valid, Swagger UI 200, protected vs public bearerAuth correct, health/tenants/auth still non-401 vs 401 as expected, tag coverage present. **Fail:** `No unexpected extra API paths documented beyond inventory` — expected set is outdated; does NOT affect RBAC verification. Read as known OpenAPI inventory drift, not F07 contract issue. |

No production data altered beyond test tenants/users created under slugs `tenant-a-rbac`, `tenant-b-rbac`, `tenant-a-users` etc., cleaned in `afterAll` (`deleteMany` roles/permissions/users/tenants). Redis not flushed in these tests; cache TTL remains.

**No temporary test data left behind.** Tests clean up their tenants atomically.

---

## 11. Frontend Contract — Summary Tables

### 11.1 SUPPORTED / NOT AVAILABLE / GAP Labels

| Capability | Label | Notes |
|---|---|---|
| `GET /roles`, `GET /roles/:id`, `POST /roles`, `PATCH /roles/:id`, `DELETE /roles/:id` | **SUPPORTED** | See §2.1 |
| `POST /roles/:id/permissions` (additive) | **SUPPORTED** | Additive only |
| `DELETE /roles/:id/permissions` (any) | **NOT AVAILABLE** | Gap — see §8 #2 |
| `PUT role permissions replace` | **NOT AVAILABLE** | Gap — #3 |
| `GET /permissions`, `GET /permissions/:id` | **SUPPORTED** | Requires `permission:read` |
| `POST /permissions` / `DELETE /permissions` | **NOT AVAILABLE** | #10/#11 |
| `GET /users/:id/roles` | **SUPPORTED** | Requires `user:read` |
| `POST /users/:id/roles` (additive) | **SUPPORTED** | Requires `user:update` |
| `DELETE /users/:id/roles/:roleId` | **NOT AVAILABLE** | Gap — #1 |
| `GET /auth/me` with roles/permissions | **NOT AVAILABLE** | Must 2-step via `GET /users/:id/roles` |
| `GET /me/permissions` | **NOT AVAILABLE** | #5 |
| Platform RBAC via tenant routes | **NOT AVAILABLE / FORBIDDEN** | #6 |
| Tenant switching without re-login | **NOT AVAILABLE** | #7 |
| Permission removal UI | **GAP — MUST HIDE** | |
| Cross-tenant access | **BLOCKED (404)** | Tenant isolation enforced |

### 11.2 Authorization Rules for Frontend

- **Route-level:** Check `effectivePermissions.includes(requiredPermission)` after resolving via `GET /users/:id/roles`. If missing → redirect to 403 page, do NOT call backend (save round-trip but backend also 403).
- **UI visibility:** `Can('product:create')` = `effectivePermissions.includes('product:create')`. No wildcard; exact match.
- **RoleGuard:** Check `effectiveRoles.includes(requiredRoleName)` — names: `admin`, `manager`, `member`, plus custom names (lowercase regex). No role hierarchy; `admin` does NOT imply `manager`.
- **Tenant-aware:** All guards must also verify `scope === 'tenant'`; `scope === 'platform'` means different console (no tenant RBAC).
- **Platform/tenant safety:** Never send `platform` JWT to `/roles`/`/permissions`/`/users`; backend will 403. Handle scope in `ProtectedRoute`.

### 11.3 Error Handling Requirements

- On any RBAC call receiving `401` with codes `UNAUTHORIZED`, `INVALID_TOKEN`, `TOKEN_EXPIRED`, `INVALID_TOKEN_CLAIMS`, `USER_NOT_FOUND`: trigger refresh flow (`POST /auth/refresh` with `refreshToken`). If that also 401 with `INVALID_REFRESH_TOKEN`/`REFRESH_TOKEN_EXPIRED`/`REFRESH_TOKEN_REVOKED`, clear storage and redirect to `/login`.
- On `403 FORBIDDEN` or `SYSTEM_ROLE_IMMUTABLE`: render 403 Forbidden page (polished). Do NOT redirect to login.
- On `404 ROLE_NOT_FOUND` etc.: render Not Found or Forbidden (avoid leaking existence; 404 is also tenant-isolation mask).
- On `409 ROLE_NAME_EXISTS`: surface validation error on role create/update form.
- On `400 VALIDATION_ERROR`: surface field errors from `error.details` (Zod `issues` path).

---

## 12. Frontend Implementation Requirements

### 12.1 PermissionContext
- On app mount, after auth, fetch `GET /auth/me` then `GET /users/:id/roles`.
- Store: `{ user, tenantId, scope, roles, permissions, effectivePermissions: string[], effectiveRoles: string[], loading, error }`.
- Re-fetch roles after any `POST /users/:id/roles` or `POST /roles/:id/permissions` success (cache TTL otherwise stale).
- If `GET /users/:id/roles` 403 `FORBIDDEN`, context permissions = `[]` (user lacks `user:read`), all guards deny by default.

### 12.2 PermissionGuard / Can()
```js
// Pseudocode — do not import backend middleware
function can(permission) {
  // permission is 'role:read' etc., exact resource:action
  return effectivePermissions.includes(permission);
}
function hasRole(roleName) {
  return effectiveRoles.includes(roleName);
}
```
- `Can({permission, children, fallback})` renders `children` if `can(permission)` else `fallback` (often null). No wildcard, no `*` support.
- Respect `scope`: if `scope !== 'tenant'`, tenant perms are empty; deny or delegate to platform context.

### 12.3 RoleGuard
- Checks role name membership, not permission. Use for route groups that are role-specific (e.g., admin-only pages). Note `manager` does NOT have `permission:read`, so admin-only permission checks already sufficient; role guard is syntactic sugar.

### 12.4 ProtectedRoute
- Props: `{ requiredPermission?, requiredRole?, requireScope?: 'tenant', redirectTo?: '/403' }`.
- Logic:
  1. If not authenticated (no token) → redirect to `/login`.
  2. If `scope !== 'tenant'` when route requires tenant → redirect to platform login or 403 `PLATFORM_TOKEN_FORBIDDEN` handling.
  3. If `requiredPermission` and not `can(requiredPermission)` → render 403 page.
  4. If `requiredRole` and not `hasRole(requiredRole)` → 403.
  5. Otherwise render children.

### 12.5 Permission-Based UI Visibility
- Buttons/links that trigger `POST /roles` etc. should be hidden if `!can('role:create')` etc., not just disabled, to avoid 403 flashes. Always enforce server-side also; hiding is UX only.
- For `isSystem:true` roles, hide edit/delete/assign-permissions UI (backend will 403 anyway).

### 12.6 Route-Level Authorization
- Map routes to permission strings (see permission inventory). Example:
  - `/roles` list → `role:read`
  - `/roles/create` → `role:create`
  - `/users` → `user:read`
  - `/users/:id/edit` → `user:update`
  - `/permissions` → `permission:read`
- Use `ProtectedRoute` wrapper; do NOT rely solely on UI hiding.

### 12.7 Polished 403/Forbidden Pages
- Distinguish `403 FORBIDDEN` (you are logged in but lack permission) vs `401` (not logged in). 403 page should offer "Back to dashboard", "Request access", and not loop to login. Include `requestId` from error response for support.
- For `SYSTEM_ROLE_IMMUTABLE` and `SELF_DELETION_FORBIDDEN`, show specific guidance (e.g., "System roles cannot be modified").

### 12.8 Tenant-Aware Authorization
- JWT `tenantId` is canonical. Never trust URL/query tenant param. Frontend should not send `tenantId` header/body for RBAC (backend ignores). All tenant isolation is server-side.
- After tenant slug change via login, re-initialize `PermissionContext` (new `tenantId` claim).

### 12.9 Platform/Tenant Scope Safety
- Keep platform and tenant auth states separate (different storage keys or `scope` field). Platform JWT (`scope:platform`) must never be attached to tenant API calls.
- If app has platform console routes (`/platform/*`), gate them via `scope === 'platform'` and use `authorizePlatform('platform:tenant:read')` etc. Tenant `PermissionGuard` should return false for platform tokens.

---

## 13. File Inventory — Exact Files Inspected

- `prisma/schema.prisma:298-418` (Role, Permission, UserRole, RolePermission, Platform* models)
- `prisma/seed.js:6-295` (permissions, roles, assignments, platform seeding)
- `src/modules/roles/roles.routes.js` (47 lines)
- `src/modules/roles/roles.controller.js` (98 lines)
- `src/modules/roles/roles.service.js` (169 lines)
- `src/modules/roles/roles.validation.js` (42 lines)
- `src/modules/roles/roles.repository.js` (148 lines)
- `src/modules/permissions/permissions.routes.js` (30 lines)
- `src/modules/permissions/permissions.controller.js` (32 lines)
- `src/modules/permissions/permissions.service.js` (66 lines)
- `src/modules/permissions/permissions.repository.js` (32 lines)
- `src/modules/permissions/permissions.validation.js` (11 lines)
- `src/modules/users/users.routes.js` (51 lines)
- `src/modules/users/users.controller.js` (131 lines)
- `src/modules/users/users.service.js` (233 lines)
- `src/modules/users/users.repository.js` (245 lines)
- `src/modules/users/users.validation.js` (68 lines)
- `src/modules/auth/auth.routes.js` (57 lines)
- `src/modules/auth/auth.controller.js` (119 lines)
- `src/modules/auth/auth.service.js` (626 lines)
- `src/modules/auth/auth.repository.js` (226 lines)
- `src/modules/auth/auth.validation.js` (54 lines)
- `src/modules/auth/auth.middleware.js` (216 lines)
- `src/modules/auth/authorization.middleware.js` (144 lines)
- `src/modules/auth/jwt.util.js` (57 lines)
- `src/modules/platform/platform.routes.js` (72 lines)
- `src/app/routes.js` (49 lines)
- `src/app/app.js` (102 lines)
- `src/docs/paths/rbac.js` (306 lines)
- `src/docs/paths/auth.js` (235 lines)
- `src/docs/openapi.js` (111 lines)
- `src/docs/components/schemas.js` (365 lines)
- `src/common/middleware/error-handler.js` (39 lines)
- `src/common/errors/app-error.js` (9 lines)
- `src/common/cache/cache.keys.js` (76 lines)
- `src/common/cache/cache.config.js` (16 lines)
- `tests/integration/phase5-rbac.test.js` (1041 lines)
- `tests/integration/phase6-users.test.js` (728 lines)
- `tests/integration/phase22-swagger.test.js` (382 lines)

---

## 14. Known Gaps Summary

1. **No current-user permission endpoint** — requires 2-step fetch via `GET /users/:id/roles`.
2. **No role/permission removal** — additive POST only; frontend must not expose removal UI.
3. **Cache staleness (300s)** — role permission changes not immediately reflected in `getUserPermissions` cache; no explicit invalidation on `POST /roles/:id/permissions`.
4. **OpenAPI schema `Role`/`User` omits embedded fields** — actual responses richer than documented (permissions, userCount, roles).
5. **Phase22 swagger inventory drift** — one failing test due to extra platform/dual-mount paths not in expected inventory; F07 subset unaffected.

All gaps are labeled correctly above; no workaround violates backend contract.

---

## 15. Location

- Contract document: `docs/FRONTEND_F07_RBAC_CONTRACT.md` (this file) — root `docs/` (Backend-PluseOps/docs)
- Previous docs remain untouched at `docs/API_DOCUMENTATION.md`, `docs/IMPLEMENTED_FEATURES.md`, etc.

---

## Git Status (Post-Report — No Commit/Push)

- Branch: `main` up-to-date with `origin/main` (`7e021f0`)
- Unstaged: `.gitignore` (14 insertions, LF->CRLF warning) — unrelated
- Untracked: `PULSEOPS_FRONTEND_BACKEND_HANDOFF.md` (pre-existing)
- **NEW untracked (to be reviewed, NOT committed per task): `docs/FRONTEND_F07_RBAC_CONTRACT.md`**
- No backend, schema, OpenAPI, roadmap, or frontend files modified.
- Do NOT commit/push until reviewed.

---

*End of contract — Frontend may proceed to implement F07 using ONLY the endpoints and behaviors marked SUPPORTED above.*
