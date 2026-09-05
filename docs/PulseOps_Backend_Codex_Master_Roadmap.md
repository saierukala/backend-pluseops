# PulseOps Backend — Phase-by-Phase Codex Implementation Roadmap

> **Single source of truth.** The former `PulseOps_Roadmap_Required_Updates.md` has been merged into this
> file and deleted. Stack: Node.js · Express · **PostgreSQL** · Prisma · Redis · BullMQ · Socket.IO.

## 0. Purpose

This document is the **single source of truth** for implementing the PulseOps backend. It supersedes every
earlier roadmap draft and separate "required updates" note; there is intentionally only one roadmap file.

### What PulseOps is

PulseOps is a **multi-tenant business operations SaaS platform** that lets different businesses manage their
products, product variants, attributes, images, inventory, warehouses, customers, orders, payments,
employees, notifications, analytics, and operational workflows from one secure platform.

PulseOps must be **business-agnostic**. It must support businesses such as:

```text
Clothing            Electronics         Cosmetics
Furniture           Food & Beverage     Accessories
Sports Equipment    Beauty Products     Home Goods
Small Manufacturing Wholesale           Retail
```

The system must never hard-code clothing-specific — or any other industry-specific — concepts into the core
product architecture. A clothing business is only one example tenant/domain.

### Stack

The backend must be built incrementally using:

- Node.js
- Express.js
- PostgreSQL
- Prisma ORM
- Redis
- BullMQ
- Socket.IO
- JWT
- Refresh-token rotation
- Zod for validation
- Pino/Winston for logging
- Jest + Supertest for testing
- Swagger/OpenAPI
- Docker
- GitHub Actions

The goal is to create a **production-style, scalable, secure, multi-tenant modular monolith** that demonstrates strong backend and full-stack engineering skills.

---

# 1. Critical Rules for Codex

These rules apply to every phase.

## 1.1 Build only the requested phase

Do **not** implement future phases unless explicitly requested.

If a future module is required conceptually, create only the minimum abstraction/interface needed by the current phase.

## 1.2 Preserve the existing architecture

Before changing code:

1. Inspect the existing project.
2. Understand the current folder structure.
3. Reuse existing utilities and patterns.
4. Do not duplicate functionality.
5. Do not rewrite working modules unnecessarily.

## 1.3 Never break previous phases

Every phase must preserve all functionality from previous phases.

Before finishing a phase:

- run tests
- run linting
- run type/static checks if configured
- verify database migrations
- verify application startup
- verify relevant API endpoints

## 1.4 Multi-tenancy is mandatory

PulseOps uses:

> Shared PostgreSQL database + shared schema + tenant_id isolation.

Every tenant-owned table must contain `tenant_id`.

Never trust `tenant_id` supplied by the frontend.

The tenant must be derived from authenticated context.

Expected request flow:

```text
Request
  ↓
Authentication
  ↓
User
  ↓
Tenant Context
  ↓
Authorization
  ↓
Validation
  ↓
Controller
  ↓
Service
  ↓
Repository
  ↓
Tenant-scoped Database Query
```

## 1.5 Layered module architecture

Use:

```text
Route
  ↓
Controller
  ↓
Service
  ↓
Repository
  ↓
Database
```

Controllers must not contain database queries.

Business logic belongs in services.

Database access belongs in repositories.

## 1.6 Security by default

All protected APIs must consider:

- authentication
- authorization
- tenant isolation
- input validation
- rate limiting
- secure password handling
- safe error messages
- SQL injection prevention
- sensitive data protection
- auditability

## 1.7 Testing is part of every phase

Do not postpone all testing until the end.

Each phase must include appropriate:

- unit tests
- integration tests
- API tests
- negative/error tests
- authorization tests
- tenant-isolation tests where relevant

## 1.8 PostgreSQL is the only database

PostgreSQL is the sole relational database. Do not introduce MySQL-specific SQL, types, or Prisma
attributes anywhere in the codebase.

Standing conventions:

```text
Prisma datasource provider  -> postgresql
Money/decimals              -> Decimal @db.Decimal(12, 2)   (never Float)
Timestamps                  -> timestamptz (@db.Timestamptz(6)), always store UTC
Primary keys                -> UUID (gen_random_uuid()) or bigint identity — pick one and stay consistent
Enumerations               -> native PostgreSQL enums via Prisma `enum`, or CHECK constraints
Flexible payloads           -> jsonb (never a text blob of JSON)
Case-insensitive uniqueness -> citext column or a unique index on lower(column)
Text search                 -> GIN index (tsvector or pg_trgm) instead of LIKE '%term%' scans
Soft delete                 -> nullable deleted_at + partial indexes (WHERE deleted_at IS NULL)
```

Raw SQL must always be parameterized (`$queryRaw` with template parameters, never string concatenation).

Use transactions through Prisma (`$transaction`) for multi-step writes, and set explicit isolation levels
where correctness depends on it (inventory adjustments, order creation, payment state changes).

---

# 2. Target Backend Architecture

## 2.1 Domain model at a glance

```text
                         PULSEOPS
             Multi-Tenant Business SaaS
                         |
                         v
                       Tenant
                         |
        +----------------+----------------+
        |                |                |
      Users           Products         Customers
                         |
              +----------+----------+
              |          |          |
           Category    Variants    Images
                         |
               +---------+---------+
               |         |         |
              SKU     Attributes  Price
                         |
                         v
                      Inventory
                         |
                      Warehouse
                         |
                         v
                       Orders
                         |
                       Payment
```

The product architecture must be generic enough that the same tables and the same module can represent:

```text
Clothing:
T-Shirt -> Color + Size + Material

Electronics:
Headphones -> Color + Connectivity + Battery Life

Cosmetics:
Face Serum -> Volume + Skin Type + Finish

Furniture:
Office Chair -> Color + Material + Dimensions

Food:
Coffee -> Weight + Roast + Pack Size
```

Never create a separate product module per industry.

## 2.2 Folder structure

Recommended structure:

```text
src/
├── app/
│   ├── app.js
│   ├── server.js
│   └── routes.js
│
├── config/
│   ├── env.js
│   ├── database.js
│   ├── redis.js
│   └── logger.js
│
├── common/
│   ├── middleware/
│   ├── errors/
│   ├── validators/
│   ├── utils/
│   ├── constants/
│   └── types/
│
├── modules/
│   ├── auth/
│   ├── tenants/
│   ├── users/
│   ├── roles/
│   ├── permissions/
│   ├── products/
│   ├── attributes/
│   ├── inventory/
│   ├── warehouses/
│   ├── customers/
│   ├── orders/
│   ├── payments/
│   ├── notifications/
│   ├── audit/
│   ├── realtime/
│   ├── storage/
│   ├── integrations/
│   └── analytics/
│
├── jobs/
│   ├── queues/
│   ├── workers/
│   └── processors/
│
├── database/
│   ├── migrations/
│   └── seeders/
│
└── tests/
    ├── unit/
    ├── integration/
    └── e2e/
```

Each feature module should follow this general pattern where appropriate:

```text
module/
├── module.controller.js
├── module.service.js
├── module.repository.js
├── module.routes.js
├── module.validation.js
├── module.schema.js
└── module.test.js
```

Do not create files that are unnecessary for a particular module.

## 2.3 Storage layering

Image bytes never live in PostgreSQL and never bind the catalog to one provider:

```text
Product / Variant Images
          |
          v
    StorageService
          |
          +-- Local Storage          (development)
          |
          +-- S3-compatible Storage  (production)
```

PostgreSQL stores the `storage_key` and metadata; the provider stores the bytes.

---

# 3. API Conventions

Use:

```text
/api/v1
```

Example:

```text
/api/v1/auth/login
/api/v1/products
/api/v1/orders
```

## Standard success response

Use a consistent response format such as:

```json
{
  "success": true,
  "data": {},
  "message": "Operation successful"
}
```

For lists:

```json
{
  "success": true,
  "data": [],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 100,
    "totalPages": 5
  }
}
```

## Standard error response

```json
{
  "success": false,
  "error": {
    "code": "RESOURCE_NOT_FOUND",
    "message": "Resource not found",
    "details": null
  },
  "requestId": "..."
}
```

Do not expose stack traces or sensitive implementation details in production responses.

---

# 4. Development Phase Order

```text
PHASE 01 → Project Foundation
PHASE 02 → Multi-Tenant Foundation
PHASE 03 → Database Schema & Migrations
PHASE 04 → Authentication
PHASE 05 → Authorization / RBAC
PHASE 06 → User Management
PHASE 07 → Product Management
PHASE 08 → Inventory Management
PHASE 09 → Order Management
PHASE 10 → Payment & Transaction Processing
PHASE 11 → Audit & Activity Logs
PHASE 12 → Notifications
PHASE 13 → WebSockets / Real-Time
PHASE 14 → Redis Caching
PHASE 15 → Background Jobs / BullMQ
PHASE 16 → External API Integrations
PHASE 17 → API Orchestration
PHASE 18 → Analytics & Reporting
PHASE 19 → Performance Optimization
PHASE 20 → Security Hardening
PHASE 21 → Complete Testing
PHASE 22 → Swagger / OpenAPI Documentation
PHASE 23 → Docker / CI/CD / Deployment
```

---

# PHASE 01 — PROJECT FOUNDATION

## Objective

Create the production-style backend foundation.

## Build

- Node.js project
- Express.js application
- environment configuration
- environment validation
- PostgreSQL connection
- Prisma setup
- Redis connection placeholder/configuration
- API versioning
- centralized error handling
- request ID
- structured logging
- security middleware
- CORS configuration
- health checks
- graceful shutdown

## Initial endpoints

```http
GET /health
GET /health/db
GET /health/redis
```

## Requirements

The application must:

- start successfully
- connect to PostgreSQL
- expose health endpoints
- handle uncaught errors safely
- shut down gracefully
- load configuration from environment variables

## Do not build yet

- authentication
- users
- products
- inventory
- orders
- payments
- notifications

## Tests

Test:

- application startup
- health endpoint
- database health
- Redis health
- centralized error handling

## Completion criteria

Do not move to Phase 2 until:

- server starts
- database connection works
- health checks work
- tests pass
- lint/checks pass

---

# PHASE 02 — MULTI-TENANT FOUNDATION

## Objective

Create tenant management and the tenant-isolation foundation.

## Tables

```text
tenants
tenant_settings
tenant_domains
```

Suggested tenant fields:

```text
id
name
slug
status
plan
created_at
updated_at
```

Tenant statuses:

```text
ACTIVE
SUSPENDED
TRIAL
CANCELLED
```

## APIs

```http
POST   /api/v1/tenants
GET    /api/v1/tenants/:id
PATCH  /api/v1/tenants/:id
DELETE /api/v1/tenants/:id
```

## Business rules

- tenant slug must be unique
- tenant status must be validated
- suspended/cancelled tenants must not perform normal operations
- tenant IDs must not be trusted from client-controlled business requests

## Tenant architecture

Create a reusable tenant context mechanism.

Eventually protected requests should resolve:

```text
req.context.tenantId
```

## Tests

Test:

- tenant creation
- duplicate slug
- tenant retrieval
- update
- tenant status
- invalid tenant
- tenant isolation foundations

## Completion criteria

Tenant creation and retrieval must work and the tenant context mechanism must be ready for later modules.

---

# PHASE 03 — DATABASE SCHEMA & MIGRATIONS

## Objective

Establish the core relational data model without implementing all business APIs.

## Core tables

```text
tenants                       (created in Phase 02)
tenant_settings               (created in Phase 02)
tenant_domains                (created in Phase 02)

users
roles
permissions
user_roles
role_permissions

products
categories
product_categories

product_variants
product_variant_attributes
product_images

attribute_definitions
attribute_values

inventory
inventory_movements
warehouses
warehouse_inventory

customers

orders
order_items
order_status_history

payments
payment_transactions
refunds

notifications
notification_preferences
notification_templates

audit_logs
activity_logs
```

Only create tables that are justified by the current architecture.

## Business-agnostic product model

The product domain is split into a general **product** and one or more sellable **variants (SKUs)**.
Industry-specific concepts such as colour, size, volume, or storage capacity are never columns — they are
tenant-defined attributes.

### Product

A product represents the general, non-sellable concept:

```text
Product
- id
- tenant_id
- name
- description
- brand
- category_id / category relationship
- status
- base_price (optional)
- created_at
- updated_at
- deleted_at (if soft delete is used)
```

### ProductVariant

A variant represents a specific sellable SKU:

```text
ProductVariant
- id
- tenant_id
- product_id
- sku
- barcode (optional)
- price
- cost_price (optional)
- status
- created_at
- updated_at
- deleted_at (if appropriate)
```

Every sellable variant must have a unique SKU within its tenant:

```text
UNIQUE (tenant_id, sku)
```

### ProductImage

```text
ProductImage
- id
- tenant_id
- product_id
- variant_id (nullable)
- storage_key
- url (optional/cached delivery URL)
- alt_text
- sort_order
- is_primary
- created_at
- updated_at
```

Rules:

- `variant_id = NULL` means the image belongs to the general product.
- `variant_id != NULL` means the image belongs to a specific variant.
- Images must always remain tenant-scoped.
- Multiple images per product are supported.
- Multiple images per variant are supported.
- Never store image binaries in PostgreSQL as the normal architecture; store a `storage_key` and keep the
  bytes in the storage provider (see Phase 16).

### Generic attributes

Do not make `color`, `size`, or any industry-specific field mandatory on every variant. Support flexible,
tenant-defined attributes instead:

```text
AttributeDefinition
- id
- tenant_id
- name
- code
- data_type
- is_required
- created_at
- updated_at

ProductVariantAttribute
- id
- tenant_id
- variant_id
- attribute_definition_id
- value
- created_at
- updated_at
```

Supported `data_type` values:

```text
TEXT
NUMBER
BOOLEAN
OPTION
```

For option-based attributes:

```text
AttributeValue
- id
- tenant_id
- attribute_definition_id
- value
- display_name
```

Examples of the same model across industries:

```text
Clothing            Electronics                 Cosmetics
Color = Black       Color = Black               Volume   = 100ml
Size  = M           Connectivity = Bluetooth    SkinType = All
Material = Cotton   BatteryLife  = 40 hours     Finish   = Matte
```

```text
Attribute: Color            Attribute: Size
Values: Black, White, Red   Values: S, M, L, XL
```

Do not require every tenant to define the same attributes.

## Tenant isolation for product data

Every tenant-owned product-domain table must carry `tenant_id`:

```text
products
categories
product_categories
product_variants
product_variant_attributes
product_images
attribute_definitions
attribute_values
```

Composite indexes and unique constraints must include tenant scope. Cross-tenant product or image access
must be impossible through normal APIs.

## Requirements

Implement:

- foreign keys
- indexes
- unique constraints
- tenant indexes
- timestamps (`timestamptz`)
- soft delete where appropriate
- appropriate numeric/decimal types (`numeric`/`Decimal`, never floating point for money)
- transaction-ready relationships
- PostgreSQL conventions from rule 1.8

## Important indexes

Examples:

```text
products(tenant_id, status)
products(tenant_id, created_at)
products(tenant_id, category_id)

product_variants(tenant_id, product_id)
product_variants(tenant_id, sku)          -- UNIQUE
product_variants(tenant_id, barcode)

product_variant_attributes(tenant_id, variant_id)
product_variant_attributes(tenant_id, attribute_definition_id, value)

product_images(tenant_id, product_id)
product_images(tenant_id, variant_id)

attribute_definitions(tenant_id, code)    -- UNIQUE

inventory(tenant_id, product_variant_id, warehouse_id)   -- UNIQUE
inventory_movements(tenant_id, product_variant_id, created_at)

orders(tenant_id, status)
orders(tenant_id, created_at)
order_items(tenant_id, product_variant_id)
```

SKU uniqueness lives on `product_variants`, not on `products`.

## Completion criteria

- clean migrations
- database can be created from scratch
- seed strategy exists
- relationships are correct
- migrations can be rolled forward safely

---

# PHASE 04 — AUTHENTICATION

## Objective

Implement secure authentication.

## Tables

```text
users
refresh_tokens
password_reset_tokens
email_verification_tokens
```

## APIs

```http
POST /api/v1/auth/register
POST /api/v1/auth/login
POST /api/v1/auth/refresh
POST /api/v1/auth/logout

POST /api/v1/auth/forgot-password
POST /api/v1/auth/reset-password

POST /api/v1/auth/verify-email
GET  /api/v1/auth/me
```

## JWT

Access token should contain only required claims.

Example:

```json
{
  "sub": "user-id",
  "tenantId": "tenant-id",
  "sessionId": "session-id"
}
```

## Refresh tokens

Implement:

- secure storage
- rotation
- revocation
- expiration
- reuse detection where appropriate

## Security

Use a strong password hashing algorithm such as Argon2id or bcrypt with appropriate cost.

Never store plaintext passwords.

## Tests

Test:

- registration
- duplicate account
- login success
- invalid credentials
- access token
- refresh token
- refresh rotation
- logout
- password reset
- email verification
- unauthorized access

## Completion criteria

A user can securely authenticate and retrieve `/auth/me`.

---

# PHASE 05 — AUTHORIZATION / RBAC

## Objective

Implement role-based and permission-based authorization.

## Tables

```text
roles
permissions
user_roles
role_permissions
```

## Permission format

Use:

```text
product:create
product:read
product:update
product:delete

order:create
order:read
order:update
order:cancel

inventory:read
inventory:update
```

## Middleware

Provide a reusable authorization mechanism similar to:

```text
authenticate()
authorize("product:create")
```

## APIs

```http
GET    /api/v1/roles
POST   /api/v1/roles
PATCH  /api/v1/roles/:id
DELETE /api/v1/roles/:id

GET    /api/v1/permissions
POST   /api/v1/roles/:id/permissions

POST   /api/v1/users/:id/roles
```

## Security

Authorization must always be tenant-aware.

A user from Tenant A must never gain permissions or resources belonging to Tenant B.

## Tests

Test:

- allowed permission
- denied permission
- missing role
- cross-tenant authorization
- protected routes

## Completion criteria

RBAC and permission checks are reusable across all future modules.

---

# PHASE 06 — USER MANAGEMENT

## Objective

Build tenant-scoped user administration.

## APIs

```http
GET    /api/v1/users
GET    /api/v1/users/:id
PATCH  /api/v1/users/:id
DELETE /api/v1/users/:id
```

Support:

- pagination
- search
- filtering
- sorting
- status filtering
- role filtering

## Rules

- all user queries are tenant scoped
- sensitive fields must never be returned
- authorization required
- users cannot modify privileged fields without permission

## Tests

Include cross-tenant isolation tests.

## Completion criteria

Tenant administrators can safely manage users.

---

# PHASE 07 — PRODUCT MANAGEMENT

## Objective

Implement a **business-agnostic product catalog system** supporting products, categories, variants, SKUs,
flexible attributes, and multiple images.

Do not create separate product modules per industry.

## Tables

```text
products
categories
product_categories

product_variants
product_variant_attributes
product_images

attribute_definitions
attribute_values
```

Variants are **not optional** — they are the sellable unit.

## Product relationships

```text
Product
 |
 +-- Categories
 |
 +-- Product Images
 |
 +-- Product Variants
       |
       +-- SKU
       +-- Price
       +-- Attributes
       +-- Variant Images
       +-- Inventory
```

## APIs

```http
POST   /api/v1/products
GET    /api/v1/products
GET    /api/v1/products/:id
PATCH  /api/v1/products/:id
DELETE /api/v1/products/:id

POST   /api/v1/categories
GET    /api/v1/categories
PATCH  /api/v1/categories/:id
DELETE /api/v1/categories/:id
```

### Variant APIs

```http
POST   /api/v1/products/:productId/variants
GET    /api/v1/products/:productId/variants
GET    /api/v1/products/:productId/variants/:variantId
PATCH  /api/v1/products/:productId/variants/:variantId
DELETE /api/v1/products/:productId/variants/:variantId
```

### Product image APIs

```http
POST   /api/v1/products/:productId/images
GET    /api/v1/products/:productId/images
PATCH  /api/v1/products/:productId/images/:imageId
DELETE /api/v1/products/:productId/images/:imageId
```

### Variant image APIs

```http
POST   /api/v1/products/:productId/variants/:variantId/images
GET    /api/v1/products/:productId/variants/:variantId/images
```

The implementation may reuse the same `ProductImage` service/repository for both.

### Attribute APIs

Tenant-scoped attribute configuration:

```http
POST   /api/v1/attributes
GET    /api/v1/attributes
PATCH  /api/v1/attributes/:id
DELETE /api/v1/attributes/:id
```

Variant attribute assignment:

```http
PUT /api/v1/products/:productId/variants/:variantId/attributes
```

## Storage

Image uploads must go through a `StorageService` abstraction, not direct provider calls. Phase 07 only needs
the local provider; the S3-compatible provider arrives in Phase 16. Storage keys are tenant-scoped:

```text
tenants/{tenantId}/products/{productId}/{filename}
tenants/{tenantId}/products/{productId}/variants/{variantId}/{filename}
```

Never let a client choose an arbitrary storage path.

## Product list requirements

Support:

```text
page
limit
search
sort
order
category
status
price range

attribute filters
variant filters
SKU
barcode
```

Examples:

```http
GET /api/v1/products?attribute[color]=Black
GET /api/v1/products?attribute[size]=M
GET /api/v1/products?attribute[storage]=256GB
GET /api/v1/products?sku=UTS-BLK-M
GET /api/v1/products?barcode=8901234567890
```

The exact query syntax can be finalized during implementation, but attribute and SKU filtering must work.

## Product examples that must be possible

```text
Clothing:                  Electronics:              Cosmetics:
Oversized T-Shirt          Wireless Headphones       Vitamin C Serum
- Black / S                - Black                   - 30ml
- Black / M                - White                   - 50ml
- White / M                                          - 100ml
```

## Security

Every product, variant, attribute, and image operation must be tenant scoped and permission checked.

## Tests

Test CRUD, validation, search, attribute/SKU filtering, pagination, authorization, and tenant isolation —
for products, variants, attributes, and images.

---

# PHASE 08 — INVENTORY MANAGEMENT

## Objective

Implement inventory tracking and movement history at the **sellable variant/SKU level**.

Inventory attaches to `product_variant_id`, not to `product_id`:

```text
Product
  |
  +-- Variant / SKU
        |
        +-- Warehouse Inventory
```

Example:

```text
SKU        Color   Size   Hyderabad   Bangalore
------------------------------------------------
UTS-BLK-S  Black   S          12          8
UTS-BLK-M  Black   M          25         14
UTS-WHT-M  White   M          10          6
```

## Tables

```text
inventory                 -> tenant_id, product_variant_id, warehouse_id, quantity
inventory_movements       -> tenant_id, product_variant_id, warehouse_id, ...
warehouses
warehouse_inventory
```

## APIs

```http
GET  /api/v1/inventory
GET  /api/v1/inventory/variants/:variantId

POST /api/v1/inventory/adjust
POST /api/v1/inventory/transfer

GET  /api/v1/inventory/movements
GET  /api/v1/inventory/low-stock
```

Adjust/transfer request bodies reference the variant/SKU and warehouse, never a bare product.

## Important rule

Inventory changes must create inventory movement records.

Do not silently change stock quantities.

Example movement:

```text
product_variant_id
warehouse
quantity_before
quantity_changed
quantity_after
reason
reference_type
reference_id
created_by
created_at
```

## Transactions

Inventory updates that affect multiple records must use database transactions.

Concurrency must be handled explicitly in PostgreSQL — lock the inventory row
(`SELECT ... FOR UPDATE`) or use a conditional update guarded by a non-negative CHECK constraint. Do not
read-then-write without protection.

## Tests

Test:

- positive adjustment
- negative adjustment
- insufficient stock
- transfers
- movement history
- concurrent update protection
- tenant isolation

---

# PHASE 09 — ORDER MANAGEMENT

## Objective

Implement order lifecycle management.

## Tables

```text
orders
order_items
order_status_history
```

Order items must reference the **specific ProductVariant/SKU** being purchased:

```text
order_items.product_variant_id
```

Each order item preserves a snapshot of commercial data so historical orders stay accurate even after the
product or variant later changes:

```text
product_name_snapshot
variant_name_snapshot / attribute_snapshot
sku_snapshot
unit_price
quantity
discount
tax
line_total
```

Example:

```text
Order
 +-- Order Item
       +-- Product:    Oversized T-Shirt
       +-- Variant:    Black / M
       +-- SKU:        UTS-BLK-M
       +-- Quantity:   2
       +-- Unit Price: 1299.00
```

Snapshots are write-once: never backfill them from the current catalog.

## APIs

```http
POST /api/v1/orders
GET  /api/v1/orders
GET  /api/v1/orders/:id

PATCH /api/v1/orders/:id/status
POST  /api/v1/orders/:id/cancel

GET /api/v1/orders/:id/history
```

## Order creation flow

```text
Create Order
 ↓
Validate variants (tenant-scoped, active, sellable)
 ↓
Check inventory for each variant/warehouse
 ↓
Calculate totals
 ↓
Create order
 ↓
Create order items (with snapshots)
 ↓
Reserve/reduce variant inventory
 ↓
Record inventory movements
 ↓
Create status history
 ↓
Commit transaction
```

## Transaction requirement

Order creation must use a database transaction.

If any operation fails:

```text
rollback everything
```

## Tests

Test successful order creation and every rollback/error scenario.

---

# PHASE 10 — PAYMENT & TRANSACTION PROCESSING

## Objective

Build payment processing and provider webhook handling.

Payments stay product- and business-agnostic: a payment relates to an **order**, never to clothing,
electronics, or cosmetics specifics. No architectural change is needed for the business-agnostic catalog.

```text
Order
  ↓
Payment
  ↓
Payment Transaction
  ↓
Refund
```

## Tables

```text
payments
payment_transactions
refunds
```

## APIs

```http
POST /api/v1/payments/create
POST /api/v1/payments/confirm
POST /api/v1/payments/webhook

GET  /api/v1/payments/:id
POST /api/v1/payments/:id/refund
```

## Critical requirement

Webhook processing must be idempotent.

Store a unique external event/payment identifier.

Repeated webhook:

```text
first request  → process
duplicate      → safely ignore
```

In PostgreSQL, enforce this with a unique constraint on the provider event identifier and an
`INSERT ... ON CONFLICT DO NOTHING` (or Prisma equivalent) rather than a read-then-write check.

## Security

Validate webhook signatures.

Never trust payment status sent directly by the frontend.

## Tests

Test:

- successful payment
- failed payment
- duplicate webhook
- invalid webhook
- refund
- transaction rollback

---

# PHASE 11 — AUDIT & ACTIVITY LOGS

## Objective

Track important system actions.

## Tables

```text
audit_logs
activity_logs
```

Suggested fields:

```text
tenant_id
user_id
action
resource
resource_id
old_value
new_value
ip_address
user_agent
created_at
```

Avoid storing secrets, passwords, tokens, or unnecessary sensitive data.

## APIs

```http
GET /api/v1/audit-logs
GET /api/v1/activity-logs
GET /api/v1/activity-logs/:id
```

## Requirements

Audit logging should be reusable by future modules.

Test that important mutations create appropriate records.

---

# PHASE 12 — NOTIFICATIONS

## Objective

Build the notification domain.

## Tables

```text
notifications
notification_preferences
notification_templates
```

## APIs

```http
GET   /api/v1/notifications
PATCH /api/v1/notifications/:id/read
POST  /api/v1/notifications/read-all

GET   /api/v1/notification-preferences
PATCH /api/v1/notification-preferences
```

## Notification channels

Design for:

```text
in-app
email
SMS
push
```

Do not tightly couple business services to a specific provider.

Use a notification service abstraction.

---

# PHASE 13 — WEBSOCKETS / REAL-TIME

## Objective

Add Socket.IO for real-time operations.

## Events

Examples:

```text
order.created
order.updated
inventory.low_stock
payment.completed
notification.created
```

## Rooms

Use tenant-aware rooms:

```text
tenant:{tenantId}
user:{userId}
```

## Security

Socket connections must authenticate users.

A socket must never subscribe to another tenant's room.

## Tests

Test:

- authenticated connection
- rejected unauthenticated connection
- tenant room isolation
- event delivery

---

# PHASE 14 — REDIS CACHING

## Objective

Introduce Redis for performance and shared state.

## Cache candidates

```text
tenant settings
permissions
product lists
dashboard metrics
frequently accessed configuration
```

## Requirements

Implement:

- cache keys
- TTL
- invalidation
- cache-aside strategy
- safe serialization
- cache failure fallback

Redis failure should not unnecessarily bring down core database-backed operations.

## Tests

Test:

- cache hit
- cache miss
- invalidation
- expiration
- Redis unavailable behavior

---

# PHASE 15 — BACKGROUND JOBS / BULLMQ

## Objective

Move slow/non-critical work outside HTTP requests.

## Queues

Potential queues:

```text
emailQueue
notificationQueue
reportQueue
analyticsQueue
cleanupQueue
webhookQueue
```

## Worker architecture

```text
API
 ↓
Queue
 ↓
Worker
 ↓
Processor
 ↓
External service / database
```

## Jobs

Examples:

- send email
- send notification
- generate report
- process webhook
- cleanup expired tokens
- calculate analytics

## Requirements

Implement:

- retries
- exponential backoff where appropriate
- failed jobs
- idempotency
- logging
- dead-letter/failure handling strategy

---

# PHASE 16 — EXTERNAL API INTEGRATIONS

## Objective

Integrate external services using clean adapters.

Possible integrations:

```text
payment provider
email provider
SMS provider
cloud/object storage provider
shipping API
maps/location API
```

## Architecture

```text
Controller
 ↓
Service
 ↓
Integration Adapter
 ↓
External API
```

Do not put external API calls directly in controllers.

## Object storage

Product and variant images must go through a provider-independent storage abstraction:

```text
StorageService
      |
      +-- LocalStorageProvider     (development)
      |
      +-- S3StorageProvider        (production, S3-compatible)
```

The product module only ever calls:

```text
storage.upload()
storage.delete()
storage.getUrl()
```

Never hard-code AWS/S3 calls inside product services. The storage implementation decides whether bytes land
on local disk or in cloud object storage.

S3 is **not** required for local development — `STORAGE_PROVIDER=local` is enough. Production may use any
S3-compatible service:

```text
Amazon S3
Cloudflare R2
Google Cloud Storage
Azure Blob Storage
```

Storage keys are always tenant-scoped and server-generated:

```text
tenants/{tenantId}/products/{productId}/{filename}
tenants/{tenantId}/products/{productId}/variants/{variantId}/{filename}
```

Never allow users to choose arbitrary storage paths.

## Requirements

Implement:

- timeouts
- retries where appropriate
- error normalization
- provider response mapping
- secret management
- webhook verification
- provider-independent interfaces

---

# PHASE 17 — API ORCHESTRATION

## Objective

Create high-value APIs that aggregate multiple backend modules.

Example:

```http
GET /api/v1/dashboard/overview
```

It may combine:

```text
orders
inventory
payments
users
notifications
analytics
```

## Architecture

```text
Dashboard Controller
 ↓
Dashboard Service
 ├── Order Service
 ├── Inventory Service
 ├── Payment Service
 ├── User Service
 └── Analytics Service
```

Avoid unnecessary HTTP calls between internal modules.

Use internal services directly.

## Requirements

- efficient queries
- parallelizable operations where safe
- Redis caching where appropriate
- consistent response
- authorization
- tenant isolation

---

# PHASE 18 — ANALYTICS & REPORTING

## Objective

Build analytics using existing transactional data.

## APIs

```http
GET /api/v1/analytics/overview
GET /api/v1/analytics/sales
GET /api/v1/analytics/orders
GET /api/v1/analytics/inventory
GET /api/v1/analytics/customers
GET /api/v1/analytics/revenue
```

Support:

```text
date range
groupBy
category
product
status
tenant
```

Example:

```http
GET /api/v1/analytics/sales?from=2026-08-01&to=2026-08-31&groupBy=day
```

## Requirements

- efficient aggregation
- indexes
- pagination where applicable
- caching for expensive dashboard queries
- tenant isolation

---

# PHASE 19 — PERFORMANCE OPTIMIZATION

## Objective

Optimize only after functionality is proven.

## Database

Review:

- indexes
- slow queries
- N+1 queries
- connection pooling
- unnecessary SELECT *
- pagination
- query plans

## API

Review:

- response size
- compression
- pagination
- selective fields
- caching
- rate limiting

## Redis

Review:

- cache hit rate
- TTLs
- invalidation
- memory usage

## Requirement

Measure before/after optimization where possible.

Do not make speculative optimizations without evidence.

---

# PHASE 20 — SECURITY HARDENING

## Objective

Perform a full security review.

## Review

```text
Helmet
CORS
Rate limiting
Input validation
SQL injection prevention
XSS protection
CSRF considerations
Secure cookies
Password hashing
JWT security
Refresh-token rotation
Token revocation
Request size limits
File upload validation
Webhook signatures
Audit logs
Tenant isolation
Authorization
Secrets management
```

## File upload & storage security

```text
file type validation
file size limits
image validation
malicious file handling
filename sanitization
storage path isolation
tenant isolation
private/public access policy
signed URLs where appropriate
upload authorization
```

A tenant must never be able to read, overwrite, or enumerate another tenant's images. Never expose storage
credentials to the frontend.

## Critical security tests

Attempt:

```text
Tenant A → Tenant B resource
User → unauthorized endpoint
Expired token → protected endpoint
Revoked refresh token → refresh
Invalid webhook → payment endpoint
Malformed input → API
Rate-limit abuse → endpoint
Tenant A → Tenant B image / storage key
```

All must fail safely.

---

# PHASE 21 — COMPLETE TESTING

## Objective

Perform full-system validation.

## Unit tests

Test:

```text
services
business rules
validators
permission logic
utilities
```

## Integration tests

Test:

```text
API
 ↓
Service
 ↓
Repository
 ↓
PostgreSQL
```

## E2E tests

Test the complete workflows.

### Main workflow

```text
Register
 ↓
Login
 ↓
Define Attributes
 ↓
Create Product
 ↓
Create Variants (SKUs) + Images
 ↓
Add Variant Inventory
 ↓
Create Order (variant/SKU line items)
 ↓
Process Payment
 ↓
Update Inventory
 ↓
Create Notification
 ↓
Create Audit Log
 ↓
Emit WebSocket event
```

## Required testing areas

- authentication
- authorization
- tenant isolation
- CRUD
- variant/SKU catalog, attributes, and attribute filtering
- image upload and storage isolation
- transactions
- rollback
- idempotency
- caching
- queues
- WebSockets
- external integrations
- error handling
- rate limiting

---

# PHASE 22 — SWAGGER / OPENAPI

## Objective

Document every production API.

Every endpoint should document:

```text
method
path
authentication
permissions
parameters
request body
response
validation errors
authorization errors
common errors
```

Swagger must reflect the actual implementation.

Do not document endpoints that do not exist.

---

# PHASE 23 — DOCKER / CI/CD / DEPLOYMENT

## Objective

Make the backend production-ready.

## Docker services

At minimum consider:

```text
api
worker
postgres
redis
```

Development can use Docker Compose. Use an official `postgres` image with a named volume, a healthcheck
(`pg_isready`), and migrations run as a separate step before the API starts.

## CI/CD

Pipeline should include:

```text
install
 ↓
lint
 ↓
test
 ↓
build
 ↓
migration validation
 ↓
deployment
```

## Production concerns

Implement/document:

- environment variables
- secrets
- database migrations
- health checks
- graceful shutdown
- logs
- monitoring
- error tracking
- backups
- rollback strategy
- HTTPS/reverse proxy
- object storage configuration

## Object storage configuration

Document the storage environment contract:

```text
STORAGE_PROVIDER
STORAGE_BUCKET
STORAGE_REGION
STORAGE_ENDPOINT
STORAGE_ACCESS_KEY
STORAGE_SECRET_KEY
```

```text
Local development:  STORAGE_PROVIDER=local
Production:         STORAGE_PROVIDER=s3
```

The exact variables depend on the chosen provider. Never commit credentials.

## Database configuration

```text
DATABASE_URL=postgresql://user:password@host:5432/pulseops?schema=public
```

Document connection pooling (PgBouncer or Prisma `connection_limit`), SSL mode for managed PostgreSQL, and
`prisma migrate deploy` as the production migration command — never `migrate dev`.

---

# 5. Phase Completion Protocol

After completing every phase, Codex must report:

```text
1. Summary
2. Files created
3. Files modified
4. Dependencies added
5. Database changes
6. APIs added
7. Business logic implemented
8. Security implemented
9. Tests added
10. Commands executed
11. Test results
12. Known limitations
13. Recommended next phase
```

Do not move to the next phase automatically.

The human developer must verify the current phase first.

---

# 6. Codex Prompt Template

Use this template whenever giving Codex a phase.

```text
You are implementing Phase [NUMBER] of the PulseOps backend.

FIRST:
Inspect the existing repository and understand the architecture.
Do not rewrite existing working functionality unnecessarily.

PROJECT:
PulseOps

STACK:
Node.js
Express.js
PostgreSQL
Prisma
Redis
BullMQ
Socket.IO
JWT
Zod
Jest
Supertest

ARCHITECTURE:
Use the existing modular monolith architecture.

LAYERING:
Route
→ Controller
→ Service
→ Repository
→ Database

MULTI-TENANCY:
Use shared database/shared schema with tenant_id isolation.
Never trust tenant_id from client input.
Tenant context must come from authenticated context where authentication is required.

CURRENT PHASE:
[INSERT PHASE]

OBJECTIVE:
[INSERT OBJECTIVE]

IMPLEMENT:
[INSERT EXACT REQUIREMENTS]

DATABASE:
[INSERT TABLES/MIGRATIONS]

APIS:
[INSERT ENDPOINTS]

BUSINESS RULES:
[INSERT BUSINESS RULES]

SECURITY:
[INSERT SECURITY REQUIREMENTS]

VALIDATION:
[INSERT VALIDATION REQUIREMENTS]

TESTING:
Create unit/integration/API tests appropriate for this phase.
Include negative cases and authorization/tenant-isolation cases where applicable.

DO NOT IMPLEMENT:
Do not implement future phases.
Do not add unrelated features.
Do not introduce unnecessary abstractions.

ACCEPTANCE CRITERIA:
[INSERT ACCEPTANCE CRITERIA]

BEFORE FINISHING:
1. Run tests.
2. Run lint/static checks.
3. Verify migrations.
4. Verify application startup.
5. Verify the new APIs.
6. Check that previous functionality still works.

FINAL RESPONSE:
Report:
- files created
- files modified
- dependencies added
- database changes
- APIs created
- business logic
- security
- tests
- commands executed
- test results
- known limitations
- next phase
```

---

# 7. Non-Negotiable Architecture Rules

## Rule 1 — Tenant isolation

Every tenant-owned query must be tenant scoped.

## Rule 2 — No database logic in controllers

Controllers should orchestrate HTTP input/output only.

## Rule 3 — No business logic in routes

Routes should configure middleware and handlers.

## Rule 4 — Services contain business logic

Services coordinate domain operations.

## Rule 5 — Repositories handle persistence

Repositories communicate with PostgreSQL/Prisma.

## Rule 6 — Transactions for multi-step critical operations

Especially:

```text
order creation
inventory updates
payment state changes
refunds
```

## Rule 7 — External APIs through adapters

Never couple business logic directly to one provider.

## Rule 8 — Async work through queues

Email, reports, notifications, and other slow jobs should not unnecessarily block HTTP requests.

## Rule 9 — Audit important mutations

Important administrative and business changes should be traceable.

## Rule 10 — Idempotency

Use idempotency for operations that can be retried:

```text
payment webhooks
external callbacks
important asynchronous jobs
```

## Rule 11 — Validate all external input

Never trust:

```text
body
query
params
headers
webhooks
external API responses
```

## Rule 12 — Never leak secrets

Never return:

```text
password_hash
refresh_token
API secrets
provider credentials
internal stack traces
```

## Rule 13 — The catalog stays business-agnostic

Products, variants, attributes, and images must work unchanged for clothing, electronics, cosmetics,
furniture, food, or any other tenant. Industry-specific concepts belong in tenant-defined attributes, never
in columns, enums, or per-industry modules.

## Rule 14 — Files go through the storage abstraction

All uploads and deletions go through `StorageService`. No module calls a storage provider SDK directly, and
storage keys are always server-generated and tenant-scoped.

## Rule 15 — PostgreSQL only

One database engine: PostgreSQL. No MySQL-specific SQL, types, or Prisma attributes (see rule 1.8).

---

# 8. Final Backend Dependency Graph

```text
                    PROJECT FOUNDATION
                           │
                           ▼
                   MULTI-TENANCY
                           │
                           ▼
                    DATABASE MODEL
                           │
                           ▼
                    AUTHENTICATION
                           │
                           ▼
                  AUTHORIZATION / RBAC
                           │
                           ▼
                    USER MANAGEMENT
                           │
             ┌─────────────┴─────────────┐
             ▼                           ▼
       PRODUCT MODULE              USER OPERATIONS
             │
             ▼
       INVENTORY MODULE
             │
             ▼
        ORDER MODULE
             │
             ▼
       PAYMENT MODULE
             │
       ┌─────┴─────────┐
       ▼               ▼
   AUDIT LOGS      NOTIFICATIONS
       │               │
       └───────┬───────┘
               ▼
          REAL-TIME
         SOCKET.IO
               │
               ▼
             REDIS
               │
               ▼
          BULLMQ JOBS
               │
               ▼
       EXTERNAL INTEGRATIONS
               │
               ▼
        API ORCHESTRATION
               │
               ▼
           ANALYTICS
               │
               ▼
        PERFORMANCE
               │
               ▼
          SECURITY
               │
               ▼
            TESTING
               │
               ▼
       API DOCUMENTATION
               │
               ▼
          DEPLOYMENT
```

---

# 9. Final Definition of Done

The PulseOps backend is considered complete only when:

- [ ] Multi-tenant architecture works
- [ ] Tenant isolation is tested
- [ ] Authentication works
- [ ] Refresh-token rotation works
- [ ] RBAC works
- [ ] Permission checks work
- [ ] User management works
- [ ] Product management works
- [ ] Product architecture is business-agnostic
- [ ] Multiple business types can use the same product module
- [ ] Products support multiple variants
- [ ] Variants support unique tenant-scoped SKUs
- [ ] Variants support flexible attributes
- [ ] Attributes are not industry-specific
- [ ] Products support multiple images
- [ ] Variants support multiple images
- [ ] Images are stored through a storage abstraction
- [ ] Local storage works for development
- [ ] Cloud/object storage is supported for production
- [ ] S3-compatible storage can be configured
- [ ] Product images are tenant isolated
- [ ] Product filtering supports attributes/SKUs
- [ ] Inventory management works
- [ ] Inventory is tracked at variant/SKU level
- [ ] Inventory movements are recorded
- [ ] Orders work
- [ ] Orders reference the purchased variant/SKU
- [ ] Historical order item data is preserved
- [ ] Order transactions/rollback work
- [ ] Payments work
- [ ] Payment webhooks are idempotent
- [ ] Audit logs work
- [ ] Notifications work
- [ ] Socket.IO real-time events work
- [ ] Redis caching works
- [ ] Background workers work
- [ ] External integrations are isolated behind adapters
- [ ] API orchestration works
- [ ] Analytics work
- [ ] Pagination/filtering/searching work
- [ ] Security hardening is complete
- [ ] Unit tests exist
- [ ] Integration tests exist
- [ ] E2E workflows pass
- [ ] Swagger/OpenAPI is complete
- [ ] Docker setup works
- [ ] CI/CD works
- [ ] PostgreSQL migrations run cleanly from an empty database
- [ ] Object storage configuration is documented
- [ ] Production deployment is documented

---

# 10. Business-Agnostic Acceptance Test

Before considering the Product/Inventory architecture complete, verify that a single implementation — no
industry-specific code paths — can create all three of these:

```text
TENANT A — CLOTHING            TENANT B — ELECTRONICS      TENANT C — COSMETICS
Product: Oversized T-Shirt     Product: Wireless           Product: Vitamin C Serum
Variants:                               Headphones         Variants:
- Black / S                    Variants:                   - 30ml
- Black / M                    - Black                     - 50ml
- White / M                    - White                     - 100ml
Images:                        Images:                     Images:
- product images               - product images            - product images
- black variant images         - black variant images      - variant images
- white variant images
```

Then verify isolation:

```text
Tenant A cannot see Tenant B products.
Tenant B cannot see Tenant C products.
Tenant C cannot see Tenant A images.
```

Each of the three catalogs must be built through the same endpoints, the same service layer, and the same
tables. If any industry needs its own branch in the product code, the architecture has failed this test.

---

# 11. Important Instruction for the Developer

**Do not attempt to build all 23 phases at once.**

Build exactly one phase, verify it, commit it, and then move to the next phase.

Recommended workflow:

```text
Phase
 ↓
Codex implementation
 ↓
Run application
 ↓
Run tests
 ↓
Manual API testing
 ↓
Review database
 ↓
Review tenant isolation
 ↓
Review security
 ↓
Git commit
 ↓
Next phase
```

The objective is not merely to make PulseOps work.

The objective is to make the codebase demonstrate:

```text
Architecture
+
Scalability
+
Security
+
Database expertise
+
API design
+
Transactions
+
Async processing
+
Caching
+
Real-time systems
+
External integrations
+
Testing
+
Production readiness
```

This backend roadmap should be completed and verified before beginning the React frontend implementation.
