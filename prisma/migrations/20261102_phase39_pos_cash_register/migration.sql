-- Phase 39: counter POS and cash register.

-- Where an order came from
ALTER TABLE "orders" ADD COLUMN "channel" TEXT NOT NULL DEFAULT 'STAFF';
UPDATE "orders" SET "channel" = 'STOREFRONT' WHERE "metadata"->>'source' = 'storefront';

-- Cash registers (counters) and their shifts
CREATE TABLE "cash_registers" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cash_registers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cash_registers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "cash_registers_tenant_id_name_key" ON "cash_registers"("tenant_id", "name");

CREATE TABLE "cash_sessions" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "register_id" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "opening_float" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "expected_cash" DECIMAL(12,2),
  "counted_cash" DECIMAL(12,2),
  "variance" DECIMAL(12,2),
  "opened_by" TEXT,
  "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closed_by" TEXT,
  "closed_at" TIMESTAMPTZ(6),
  "note" TEXT,
  CONSTRAINT "cash_sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cash_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "cash_sessions_register_id_fkey" FOREIGN KEY ("register_id") REFERENCES "cash_registers"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "cash_sessions_tenant_id_register_id_opened_at_idx" ON "cash_sessions"("tenant_id", "register_id", "opened_at");
-- At most one open shift per counter
CREATE UNIQUE INDEX "cash_sessions_one_open_per_register" ON "cash_sessions"("register_id") WHERE "status" = 'OPEN';

CREATE TABLE "cash_movements" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "session_id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "reason" TEXT,
  "order_id" TEXT,
  "payment_id" TEXT,
  "created_by" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cash_movements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cash_movements_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "cash_movements_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "cash_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "cash_movements_tenant_id_session_id_idx" ON "cash_movements"("tenant_id", "session_id");

-- Sales parked at the counter, resumed later
CREATE TABLE "pos_held_sales" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "user_id" TEXT,
  "label" TEXT,
  "cart" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_held_sales_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_held_sales_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "pos_held_sales_tenant_id_created_at_idx" ON "pos_held_sales"("tenant_id", "created_at");

-- Idempotency-Key replay store (double-clicked or retried checkouts)
CREATE TABLE "idempotency_keys" (
  "scope_id" TEXT NOT NULL,
  "key" VARCHAR(255) NOT NULL,
  "route" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "status_code" INTEGER,
  "response" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("scope_id", "key")
);
CREATE INDEX "idempotency_keys_created_at_idx" ON "idempotency_keys"("created_at");

-- New permissions for every business that already exists, granted to its admin and manager roles
INSERT INTO "permissions" ("id", "tenant_id", "name", "resource", "action", "created_at", "updated_at")
SELECT gen_random_uuid()::text, r."tenant_id", p.name, p.resource, p.action, NOW(), NOW()
FROM "roles" r
CROSS JOIN (VALUES ('pos:sell', 'pos', 'sell'), ('cash_register:read', 'cash_register', 'read'), ('cash_register:manage', 'cash_register', 'manage')) AS p(name, resource, action)
WHERE r."name" = 'admin' AND r."is_system" = true
ON CONFLICT ("tenant_id", "resource", "action") DO NOTHING;

INSERT INTO "role_permissions" ("id", "tenant_id", "role_id", "permission_id", "created_at")
SELECT gen_random_uuid()::text, r."tenant_id", r."id", perm."id", NOW()
FROM "roles" r
JOIN "permissions" perm ON perm."tenant_id" = r."tenant_id" AND perm."resource" IN ('pos', 'cash_register')
WHERE r."is_system" = true AND (r."name" IN ('admin', 'manager') OR (r."name" = 'member' AND perm."action" = 'read'))
ON CONFLICT DO NOTHING;
