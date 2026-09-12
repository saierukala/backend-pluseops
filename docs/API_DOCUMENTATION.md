# API Documentation

This document describes **only APIs that actually exist in the repository** as of Phase 04 completion.

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

## APIs NOT Implemented

The following API groups are **NOT implemented** in the repository as of Phase 04 completion:

| Category | Status |
|----------|--------|
| RBAC Authorization (`/api/v1/roles`, `/api/v1/permissions`, `/api/v1/users/:id/roles`) | ⏳ Not started |
| User Management (`/api/v1/users`) | ⏳ Not started |
| Product Management (`/api/v1/products`, `/api/v1/categories`, `/api/v1/attributes`) | ⏳ Not started |
| Inventory (`/api/v1/inventory`) | ⏳ Not started |
| Orders (`/api/v1/orders`) | ⏳ Not started |
| Payments (`/api/v1/payments`) | ⏳ Not started |
| Notifications (`/api/v1/notifications`, `/api/v1/notification-preferences`) | ⏳ Not started |
| WebSockets / Real-Time | ⏳ Not started |
| Redis Caching APIs | ⏳ Not started |
| BullMQ / Job APIs | ⏳ Not started |
| External Integrations | ⏳ Not started |
| Analytics / Reporting | ⏳ Not started |
| Swagger / OpenAPI | ⏳ Not started |

Only the Health APIs, Tenant APIs, and Authentication APIs listed above are implemented and tested.