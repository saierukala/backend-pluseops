# API Documentation

This document describes **only APIs that actually exist in the repository** as of Phase 22 completion (OpenAPI 3.0.3, 81 path keys, 115 operations, 115 unique operationIds, 26 schemas, Swagger UI at `/api-docs`, JSON at `/api-docs.json`/`/openapi.json`/`/api/v1/openapi.json`).

---

## Health APIs

### GET /health
**Liveness probe** — Works without PostgreSQL or Redis.

**Response 200:**
```json
{
  "success": true,
  "data": { "status": "ok" },
  "message": "Service is healthy"
}
```

### GET /health/db
**PostgreSQL readiness probe** — Returns `503` until connected.

**Response 200 (healthy):**
```json
{
  "success": true,
  "data": { "name": "database", "status": "up" },
  "message": "Database is healthy"
}
```

**Response 503 (unavailable):**
```json
{
  "success": false,
  "data": { "name": "database", "status": "down" },
  "message": "Database is unavailable"
}
```

### GET /health/redis
**Redis readiness probe** — Returns `503` until connected.

**Response 200 (healthy):**
```json
{
  "success": true,
  "data": { "name": "redis", "status": "up" },
  "message": "Redis is healthy"
}
```

**Response 503 (unavailable):**
```json
{
  "success": false,
  "data": { "name": "redis", "status": "down" },
  "message": "Redis is unavailable"
}
```

### Versioned Health Endpoints
The same three endpoints are also exposed under `/api/v1/health`, `/api/v1/health/db`, `/api/v1/health/redis` for API-versioned access. Infrastructure probes should prefer the root `/health` routes.

---

## Swagger / OpenAPI Documentation (Phase 22 — OpenAPI 3.0.3)

**Specification:** `src/docs/openapi.js` aggregates `src/docs/components/schemas.js` (26 schemas) + 10 path modules (`health`, `tenants`, `auth`, `rbac`, `catalog`, `inventory-warehouses`, `orders-payments`, `audit-notifications`, `jobs`, `analytics-storage`) into `openApiSpec: {openapi:3.0.3, info:{title:PulseOps API, version:1.0.0}, servers:[{url:http://localhost:3000}], tags:21, paths:81 keys → 115 operations, components:{securitySchemes:{bearerAuth:{type:http, scheme:bearer, bearerFormat:JWT}}, schemas, responses, parameters}}`.

**Servers:** Single server `http://localhost:3000` (description: Local development). All `paths` already contain full `/api/v1` prefix (e.g., `/api/v1/auth/login`), so `SERVER BASE + PATH = ACTUAL EXPRESS ROUTE` (e.g., `http://localhost:3000` + `/api/v1/products` = `GET /api/v1/products`). No duplicated `/api/v1/api/v1`.

**Security:** `bearerAuth` (`Authorization: Bearer <token>`). 19 public `security:[]` (health 6, tenants 4, auth 7 public, `POST /api/v1/payments/webhook` HMAC, `GET /api/v1/storage/signed` HMAC) — no `authenticate()`; 96 protected `security:[{bearerAuth:[]}]` — `authenticate()` + `authorize('resource:action')` per endpoint (e.g., `product:create`, `order:cancel`, `analytics:read`). 403 `FORBIDDEN` if missing permission, 401 if missing/invalid JWT.

**Tags (21):** Health, Tenants, Auth, Roles, Permissions, Users, Categories, Products, Variants, Attributes, Product Images, Warehouses, Inventory, Orders, Payments, Audit, Notifications, Jobs, Dashboard, Analytics, Storage.

**Schemas (26 reusable):** `ErrorResponse` (`success:false, error:{code,message,details}, requestId`), `SuccessResponse`, `PaginationMeta`, `Tenant`, `User`, `Role`, `Permission`, `Category`, `Product`, `ProductVariant`, `AttributeDefinition`, `AttributeValue`, `ProductImage`, `Warehouse`, `Inventory`, `InventoryMovement`, `Order`, `OrderItem`, `Payment`, `PaymentTransaction`, `Refund`, `Notification`, `AuditLog`, `ActivityLog`, `HealthStatus` — all with `type`, `format:uuid|email|date-time`, `enum`, `pattern`, `example`, no secrets.

**Endpoints:**

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api-docs/` | none (public) | Swagger UI — `swagger-ui-express@5.0.1`, Try it out, persistAuthorization |
| GET | `/api-docs.json` | none | OpenAPI JSON — `openapi:3.0.3`, 81 paths, 115 ops, 573 `$ref` (0 unresolved) |
| GET | `/openapi.json` | none | Alias |
| GET | `/api/v1/openapi.json` | none | Alias under prefix |

All three JSON endpoints return `200` `content-type: application/json` with same `openApiSpec`. Setup via `src/docs/swagger.js:setupSwagger(app)` mounted in `src/app/app.js:67` before `/health`/`/api/v1` (only `requestContext`, `helmet`, `cors`, `compression`, `globalLimiter` before; no auth). No secrets exposed (`spec` contains only `user@example.com`, `3fa85f64`).

**Coverage:** 115/115 production routes documented (0 undocumented, 0 phantom, 0 method mismatch, PUT only at `PUT /api/v1/products/{productId}/variants/{variantId}/attributes`), 115 unique `operationId` (e.g., `liveHealth`, `createTenant`, `register`, `listRoles`, `createVariant`, `setVariantAttributes`, `getSignedFile`), 573 `$ref` all `#/components/schemas/...` resolved.

**Request/Response:** Path params `in:path, required:true, schema:{type:string, format:uuid}`, query `page/limit/search/status`, bodies from Zod (`createTenantSchema` etc.), multipart `image` binary, success `200/201` envelope `{success:true, data, message, meta}`, errors `400 VALIDATION_ERROR`, `401 TOKEN_EXPIRED`, `403 FORBIDDEN`, `404 NotFound`, `409 Conflict`, `429 RateLimited` via `ErrorResponse`.

**Verification:** `GET /api-docs/` 200 html, `GET /api-docs.json` 200 `openapi:3.0.3`, 16 dedicated tests in `tests/integration/phase22-swagger.test.js` (JSON, UI, valid, all 115, no phantom, PUT only, bearerAuth, public, schemas, body, health).

**Limitations:** Swagger UI is public (no auth) — acceptable for Phase 22 dev/docs; spec is static JS (manual update, guarded by test); synthetic examples; no Docker/CI/CD.

---

## Tenant APIs

All tenant endpoints are under `/api/v1/tenants` and use the standard response format:
- Success: `{ "success": true, "data": <tenant>, "message": "..." }`
- Error: `{ "success": false, "error": { "code": "...", "message": "...", "details": null }, "requestId": "..." }`

Request IDs are generated automatically or accepted via `X-Request-Id` header.

---

### POST /api/v1/tenants
**Create a new tenant.**

**Request Body:**
```json
{
  "name": "string (1-255 chars, required)",
  "slug": "string (1-100 chars, required, regex ^[a-z0-9-]+$)",
  "status": "ACTIVE | SUSPENDED | TRIAL | CANCELLED (optional, default: TRIAL)",
  "plan": "string max 50 chars (optional, default: free)"
}
```

**Validation:**
- `name`: required, 1-255 characters
- `slug`: required, 1-100 characters, lowercase alphanumeric + hyphen, must be unique
- `status`: optional, must be one of the four enum values
- `plan`: optional, max 50 characters

**Success Response 201:**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "name": "Example Tenant",
    "slug": "example-tenant",
    "status": "TRIAL",
    "plan": "free",
    "created_at": "2025-09-11T12:00:00.000000Z",
    "updated_at": "2025-09-11T12:00:00.000000Z",
    "settings": { "id": "uuid", "tenant_id": "uuid", "metadata": {}, "created_at": "...", "updated_at": "..." },
    "domains": []
  },
  "message": "Tenant created successfully"
}
```

**Error Responses:**

| Status | Code | Message |
|--------|------|---------|
| 400 | ZodError | Validation failed (invalid body) |
| 409 | TENANT_SLUG_EXISTS | Tenant with this slug already exists |

---

### GET /api/v1/tenants/:id
**Retrieve a tenant by UUID.**

**Path Parameters:**
- `id` (UUID, required)

**Success Response 200:**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "name": "Example Tenant",
    "slug": "example-tenant",
    "status": "TRIAL",
    "plan": "free",
    "created_at": "2025-09-11T12:00:00.000000Z",
    "updated_at": "2025-09-11T12:00:00.000000Z",
    "settings": { "id": "uuid", "tenant_id": "uuid", "metadata": {}, "created_at": "...", "updated_at": "..." },
    "domains": []
  },
  "message": "Tenant retrieved successfully"
}
```

**Error Responses:**

| Status | Code | Message |
|--------|------|---------|
| 400 | ZodError | Invalid UUID format |
| 404 | TENANT_NOT_FOUND | Tenant not found |

---

### PATCH /api/v1/tenants/:id
**Update a tenant. At least one field must be provided.**

**Path Parameters:**
- `id` (UUID, required)

**Request Body (all optional, at least one required):**
```json
{
  "name": "string (1-255 chars)",
  "slug": "string (1-100 chars, regex ^[a-z0-9-]+$)",
  "status": "ACTIVE | SUSPENDED | TRIAL | CANCELLED",
  "plan": "string max 50 chars"
}
```

**Validation:**
- `slug`: if provided, must be unique (not used by another tenant)
- Body cannot be empty

**Success Response 200:**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "name": "Updated Name",
    "slug": "updated-slug",
    "status": "ACTIVE",
    "plan": "pro",
    "created_at": "2025-09-11T12:00:00.000000Z",
    "updated_at": "2025-09-11T12:05:00.000000Z",
    "settings": { ... },
    "domains": []
  },
  "message": "Tenant updated successfully"
}
```

**Error Responses:**

| Status | Code | Message |
|--------|------|---------|
| 400 | ZodError | Validation failed (invalid body, empty body, or invalid UUID) |
| 404 | TENANT_NOT_FOUND | Tenant not found |
| 409 | TENANT_SLUG_EXISTS | Tenant with this slug already exists |

---

### DELETE /api/v1/tenants/:id
**Delete a tenant.**

**Path Parameters:**
- `id` (UUID, required)

**Success Response 200:**
```json
{
  "success": true,
  "data": null,
  "message": "Tenant deleted successfully"
}
```

**Error Responses:**

| Status | Code | Message |
|--------|------|---------|
| 400 | ZodError | Invalid UUID format |
| 404 | TENANT_NOT_FOUND | Tenant not found |

---

## Authentication APIs

All authentication endpoints are under `/api/v1/auth` and use the standard response format.

### POST /api/v1/auth/register
**Register a new user.**

**Request Body:**
```json
{
  "email": "string (valid email, required)",
  "password": "string (min 8, max 128, requires uppercase, lowercase, number, special char)",
  "firstName": "string (1-100 chars, required)",
  "lastName": "string (1-100 chars, required)",
  "tenantId": "string (UUID, required)"
}
```

**Validation:**
- `email`: valid email format
- `password`: min 8, max 128 chars, must contain uppercase, lowercase, number, special char
- `firstName`, `lastName`: required, 1-100 chars
- `tenantId`: required, valid UUID, tenant must exist and be ACTIVE or TRIAL

**Success Response 201:**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "tenantId": "uuid",
    "email": "user@example.com",
    "firstName": "John",
    "lastName": "Doe",
    "status": "ACTIVE",
    "emailVerified": false,
    "createdAt": "2025-09-11T12:00:00.000000Z",
    "updatedAt": "2025-09-11T12:00:00.000000Z"
  },
  "message": "Registration successful. Please verify your email."
}
```

**Error Responses:**

| Status | Code | Message |
|--------|------|---------|
| 400 | ZodError | Validation failed |
| 400 | TENANT_REQUIRED | Tenant ID is required for registration |
| 404 | TENANT_NOT_FOUND | Tenant not found |
| 403 | TENANT_INACTIVE | Tenant is not active |
| 409 | USER_ALREADY_EXISTS | User with this email already exists in this tenant |

---

### POST /api/v1/auth/login
**Authenticate a user and obtain access/refresh tokens.**

**Request Body:**
```json
{
  "email": "string (valid email, required)",
  "password": "string (required)",
  "tenantId": "string (UUID, required)"
}
```

**Validation:**
- `email`: valid email format
- `password`: required
- `tenantId`: required, valid UUID, tenant must exist and be ACTIVE or TRIAL

**Success Response 200:**
```json
{
  "success": true,
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refreshToken": "a1b2c3d4e5f6...",
    "sessionId": "uuid",
    "user": {
      "id": "uuid",
      "tenantId": "uuid",
      "email": "user@example.com",
      "firstName": "John",
      "lastName": "Doe",
      "status": "ACTIVE",
      "emailVerified": false,
      "lastLoginAt": "2025-09-11T12:00:00.000000Z",
      "createdAt": "2025-09-11T12:00:00.000000Z",
      "updatedAt": "2025-09-11T12:00:00.000000Z"
    },
    "sessionId": "uuid"
  },
  "message": "Login successful"
}
```

**Error Responses:**

| Status | Code | Message |
|--------|------|---------|
| 400 | ZodError | Validation failed |
| 400 | TENANT_REQUIRED | Tenant ID is required for login |
| 401 | INVALID_CREDENTIALS | Invalid credentials |
| 403 | ACCOUNT_INACTIVE | Account is not active |
| 403 | TENANT_INACTIVE | Tenant is not active |

---

### POST /api/v1/auth/refresh
**Rotate refresh token and obtain new access/refresh token pair.**

**Request Body:**
```json
{
  "refreshToken": "string (required)"
}
```

**Success Response 200:**
```json
{
  "success": true,
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refreshToken": "new_refresh_token_value",
    "sessionId": "uuid",
    "user": {
      "id": "uuid",
      "tenantId": "uuid",
      "email": "user@example.com",
      "firstName": "John",
      "lastName": "Doe",
      "status": "ACTIVE",
      "emailVerified": false,
      "lastLoginAt": "2025-09-11T12:00:00.000000Z",
      "createdAt": "2025-09-11T12:00:00.000000Z",
      "updatedAt": "2025-09-11T12:00:00.000000Z"
    },
    "sessionId": "uuid"
  },
  "message": "Token refreshed successfully"
}
```

**Error Responses:**

| Status | Code | Message |
|--------|------|---------|
| 400 | ZodError | Validation failed |
| 401 | INVALID_REFRESH_TOKEN | Invalid refresh token |
| 401 | REFRESH_TOKEN_EXPIRED | Refresh token has expired |
| 401 | REFRESH_TOKEN_REVOKED | Refresh token has been revoked |

---

### POST /api/v1/auth/logout
**Revoke refresh token (logout).**

**Request Body:**
```json
{
  "refreshToken": "string (optional)"
}
```

**Success Response 200:**
```json
{
  "success": true,
  "data": { "success": true, "message": "Logout successful" },
  "message": "Logout successful"
}
```

---

### POST /api/v1/auth/forgot-password
**Request password reset token (account enumeration safe).**

**Request Body:**
```json
{
  "email": "string (valid email, required)",
  "tenantId": "string (UUID, required)"
}
```

**Success Response 200:**
```json
{
  "success": true,
  "data": {
    "success": true,
    "message": "If the email exists, a reset link has been sent",
    "devToken": "raw_reset_token_for_development_only"
  },
  "message": "If the email exists, a reset link has been sent"
}
```

**Error Responses:**

| Status | Code | Message |
|--------|------|---------|
| 400 | ZodError | Validation failed |
| 400 | TENANT_REQUIRED | Tenant ID is required |

---

### POST /api/v1/auth/reset-password
**Reset password using reset token.**

**Request Body:**
```json
{
  "token": "string (required)",
  "password": "string (min 8, max 128, requires uppercase, lowercase, number, special char)"
}
```

**Success Response 200:**
```json
{
  "success": true,
  "data": { "success": true, "message": "Password has been reset successfully" },
  "message": "Password has been reset successfully"
}
```

**Error Responses:**

| Status | Code | Message |
|--------|------|---------|
| 400 | ZodError | Validation failed |
| 400 | INVALID_RESET_TOKEN | Invalid or expired reset token |
| 400 | RESET_TOKEN_EXPIRED | Reset token has expired |
| 400 | RESET_TOKEN_USED | Reset token has already been used |

---

### POST /api/v1/auth/verify-email
**Verify user's email address.**

**Request Body:**
```json
{
  "token": "string (required)"
}
```

**Success Response 200:**
```json
{
  "success": true,
  "data": { "success": true, "message": "Email verified successfully" },
  "message": "Email verified successfully"
}
```

**Error Responses:**

| Status | Code | Message |
|--------|------|---------|
| 400 | ZodError | Validation failed |
| 400 | INVALID_VERIFICATION_TOKEN | Invalid or expired verification token |
| 400 | VERIFICATION_TOKEN_EXPIRED | Verification token has expired |
| 400 | VERIFICATION_TOKEN_USED | Verification token has already been used |

---

### GET /api/v1/auth/me
**Get authenticated user profile.**

**Headers:**
- `Authorization: Bearer <access_token>`

**Success Response 200:**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "tenantId": "uuid",
    "email": "user@example.com",
    "firstName": "John",
    "lastName": "Doe",
    "status": "ACTIVE",
    "emailVerified": false,
    "lastLoginAt": "2025-09-11T12:00:00.000000Z",
    "createdAt": "2025-09-11T12:00:00.000000Z",
    "updatedAt": "2025-09-11T12:00:00.000000Z"
  },
  "message": "User retrieved successfully"
}
```

**Error Responses:**

| Status | Code | Message |
|--------|------|---------|
| 401 | UNAUTHORIZED | Authentication required |
| 401 | INVALID_TOKEN | Invalid access token |
| 401 | TOKEN_EXPIRED | Access token has expired |
| 401 | INVALID_TOKEN_CLAIMS | Invalid token claims |
| 401 | USER_NOT_FOUND | User not found or inactive |
| 403 | ACCOUNT_INACTIVE | Account is not active |
| 403 | TENANT_INACTIVE | Tenant is not active |

---

## RBAC Authorization APIs

### Authorization Middleware

All RBAC endpoints require authentication via the `authenticate()` middleware, followed by the `authorize(permission)` middleware that checks the authenticated user's permissions.

**Permission Format:** `resource:action` (e.g., `product:create`, `order:read`)

**Error Codes:**
| Status | Code | Description |
|--------|------|-------------|
| 401 | UNAUTHORIZED | Missing or invalid access token |
| 403 | FORBIDDEN | Authenticated but missing required permission |

---

### Role APIs

All role endpoints are under `/api/v1/roles` and require authentication + appropriate permission.

#### GET /api/v1/roles
**List roles (tenant-scoped, paginated).**

**Headers:** `Authorization: Bearer <access_token>`
**Permission:** `role:read`
**Query Parameters:**
- `page` (integer, default: 1)
- `limit` (integer, default: 50, max: 100)

**Success Response 200:**
```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "tenantId": "uuid",
      "name": "admin",
      "description": "Full administrative access",
      "isSystem": true,
      "permissions": [...],
      "userCount": 5,
      "createdAt": "2025-09-11T12:00:00.000000Z",
      "updatedAt": "2025-09-11T12:00:00.000000Z"
    }
  ],
  "meta": { "page": 1, "limit": 50, "total": 3, "totalPages": 1 },
  "message": "Roles retrieved successfully"
}
```

---

#### GET /api/v1/roles/:id
**Retrieve a role by ID (tenant-scoped).**

**Permission:** `role:read`
**Path Parameters:** `id` (UUID)

**Success Response 200:** Returns role object with permissions and userCount.

**Error Responses:**
| Status | Code | Message |
|--------|------|---------|
| 400 | ZodError | Invalid UUID format |
| 404 | ROLE_NOT_FOUND | Role not found |

---

#### POST /api/v1/roles
**Create a new role.**

**Permission:** `role:create`

**Request Body:**
```json
{
  "name": "string (1-100 chars, required, regex ^[a-z0-9_-]+$)",
  "description": "string (optional, max 500 chars)"
}
```

**Validation:**
- `name`: required, 1-100 chars, lowercase alphanumeric + underscore + hyphen, unique per tenant
- `description`: optional, max 500 chars

**Success Response 201:**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "tenantId": "uuid",
    "name": "custom_role",
    "description": "Custom role description",
    "isSystem": false,
    "permissions": [],
    "userCount": 0,
    "createdAt": "2025-09-11T12:00:00.000000Z",
    "updatedAt": "2025-09-11T12:00:00.000000Z"
  },
  "message": "Role created successfully"
}
```

**Error Responses:**
| Status | Code | Message |
|--------|------|---------|
| 400 | ZodError | Validation failed |
| 409 | ROLE_NAME_EXISTS | Role with this name already exists |
| 403 | FORBIDDEN | Missing role:create permission |

---

#### PATCH /api/v1/roles/:id
**Update a role.**

**Permission:** `role:update`

**Path Parameters:** `id` (UUID)

**Request Body (at least one field required):**
```json
{
  "name": "string (1-100 chars, regex ^[a-z0-9_-]+$)",
  "description": "string (max 500 chars)"
}
```

**Constraints:**
- Cannot modify system roles (`is_system=true`) — returns 403 `SYSTEM_ROLE_IMMUTABLE`
- Cannot change name to existing role name in same tenant

**Error Responses:**
| Status | Code | Message |
|--------|------|---------|
| 400 | ZodError | Validation failed, empty body |
| 403 | SYSTEM_ROLE_IMMUTABLE | Cannot modify system role |
| 404 | ROLE_NOT_FOUND | Role not found in tenant |
| 409 | ROLE_NAME_EXISTS | Role name already exists |

---

#### DELETE /api/v1/roles/:id
**Delete a role.**

**Permission:** `role:delete`

**Path Parameters:** `id` (UUID)

**Constraints:**
- Cannot delete system roles — returns 403 `SYSTEM_ROLE_IMMUTABLE`

**Success Response 200:**
```json
{ "success": true, "data": { "success": true, "message": "Role deleted successfully" }, "message": "Role deleted successfully" }
```

**Error Responses:**
| Status | Code | Message |
|--------|------|---------|
| 400 | ZodError | Invalid UUID format |
| 403 | SYSTEM_ROLE_IMMUTABLE | Cannot delete system role |
| 404 | ROLE_NOT_FOUND | Role not found in tenant |

---

#### POST /api/v1/roles/:id/permissions
**Assign permissions to a role (idempotent).**

**Permission:** `role:update`

**Path Parameters:** `id` (UUID)

**Request Body:**
```json
{
  "permissionIds": ["uuid", "uuid"]
}
```

**Behavior:**
- Validates all permission IDs exist in the authenticated tenant
- Filters out invalid/cross-tenant permissions
- Idempotent: duplicate assignments are skipped (`skipDuplicates: true`)
- Cannot modify system role permissions — returns 403 `SYSTEM_ROLE_IMMUTABLE`

**Success Response 200:** Returns array of assigned permissions with details.

**Error Responses:**
| Status | Code | Message |
|--------|------|---------|
| 400 | ZodError | Validation failed |
| 403 | SYSTEM_ROLE_IMMUTABLE | Cannot modify system role |
| 404 | ROLE_NOT_FOUND | Role not found in tenant |

---

### Permission APIs

All permission endpoints are under `/api/v1/permissions` and require authentication.

#### GET /api/v1/permissions
**List permissions (tenant-scoped).**

**Permission:** `permission:read`

**Success Response 200:** Returns array of permission objects.

**Error Responses:**
| Status | Code | Message |
|--------|------|---------|
| 403 | FORBIDDEN | Missing permission:read permission |

---

#### GET /api/v1/permissions/:id
**Get permission by ID.**

**Permission:** `permission:read`

**Path Parameters:** `id` (UUID)

**Error Responses:**
| Status | Code | Message |
|--------|------|---------|
| 404 | PERMISSION_NOT_FOUND | Permission not found |

---

### User Role Assignment APIs

#### GET /api/v1/users/:id/roles
**Get roles assigned to a user.**

**Permission:** `user:read`

**Path Parameters:** `id` (UUID) — target user ID

**Error Responses:**
| Status | Code | Message |
|--------|------|---------|
| 404 | USER_NOT_FOUND | User not found in tenant |
| 403 | FORBIDDEN | Missing user:read permission |

---

#### POST /api/v1/users/:id/roles
**Assign roles to a user (idempotent).**

**Permission:** `user:update`

**Path Parameters:** `id` (UUID) — target user ID

**Request Body:**
```json
{
  "roleIds": ["uuid", "uuid"]
}
```

**Behavior:**
- Validates all role IDs exist in the authenticated tenant
- Filters out invalid/cross-tenant roles
- Idempotent: duplicate assignments skipped
- Cannot assign cross-tenant roles

**Success Response 200:** Returns array of assigned roles with details.

**Error Responses:**
| Status | Code | Message |
|--------|------|---------|
| 400 | ZodError | Validation failed |
| 403 | FORBIDDEN | Missing user:update permission |
| 404 | USER_NOT_FOUND | User not found in tenant |

---

## APIs NOT Implemented

The following API groups are **NOT implemented** in the repository as of Phase 22 completion:

| Category | Status |
|----------|--------|
| Docker / CI/CD / Deployment | ⏳ Not started (Phase 23) |

All other API groups are implemented and documented via OpenAPI 3.0.3 (Health, Tenants, Auth, RBAC, Users, Categories, Products, Variants, Attributes, Images, Warehouses, Inventory, Orders, Payments, Audit, Notifications, Jobs, Dashboard, Analytics, Storage, Swagger) — 115 operations.

Only Phase 23 (Docker/CI/CD) remains.

---

## Phase 21 — Complete Testing (no new endpoints, 87 new tests)

### Summary
Phase 21 adds 51 unit (validators/services/utils), 12 E2E (Register→Login→Attributes→Product→Variants+Images→Inventory→Order→Payment→Notification→Audit→WebSocket), 24 extended integration (tenant matrix, rollback, idempotency, cache, queue, websocket, external adapters, error handling, rate-limit config). Total new 87 + 746 baseline = 833 per-suite (controlled individual execution, not one combined 833 run — combined Jest exceeds 600s DB load). No new migration, no Phase 22/23 endpoints.

### Verification honest limitations
- 833 per-suite sum only; full combined not completed (timeout).
- Unit-only coverage ~4%; do not claim 50% project-wide.
- Rate-limit stress not fully performed.
- `npm audit` 3 high dev-chain deepmerge-ts→Prisma remains.
- Lint 0, Prisma valid, 9 migrations up-to-date, security 53/53 regression PASS.

---

## Phase 20 — Security Hardening APIs (added)

### GET /api/v1/products/:productId/images/:imageId/file
Stream product image bytes (private). Auth Bearer + product:read, tenant-scoped, 403 cross-tenant, 401 unauth. Direct /storage/... 404.

### GET /api/v1/products/:productId/images/:imageId/signed-url
Generate signed URL (private). Auth Bearer + product:read, HMAC 900s or SigV4, no credentials in URL.

### GET /api/v1/storage/signed?key=&expires=&signature=
Stream via HMAC/SigV4 signed URL (no auth, 403 tampered/expired).

### GET /api/v1/storage/file?key=
Stream via authenticated tenant check (Bearer, 403 cross-tenant).

### Security hardening
Helmet, CORS allow-list, global/auth/webhook rate limiting, request-size, webhook raw-body HMAC whitespace-sensitive, Local PRIVATE + S3 PRIVATE-by-default + signed URLs.

### Known limitations
Local private no static; signed URLs are controlled-access; tenant-scoped keys alone not private.
