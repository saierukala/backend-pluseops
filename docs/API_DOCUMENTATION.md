# API Documentation

This document describes **only APIs that actually exist in the repository** as of Phase 03 completion.

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

## APIs NOT Implemented

The following API groups are **NOT implemented** in the repository as of Phase 03 completion:

| Category | Status |
|----------|--------|
| Authentication (`/api/v1/auth/*`) | ⏳ Not started |
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

Only the Health APIs and Tenant APIs listed above are implemented and tested.