-- Phase 40: quotes, sales returns (credit notes), customer balances, recurring invoices.

-- Running numbers for other documents (QUOTE, CREDIT_NOTE) per workspace per financial year
CREATE TABLE "document_sequences" (
  "tenant_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "financial_year" VARCHAR(7) NOT NULL,
  "last_number" INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "document_sequences_pkey" PRIMARY KEY ("tenant_id", "kind", "financial_year"),
  CONSTRAINT "document_sequences_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "quotes" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "number" TEXT NOT NULL,
  "customer_id" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "valid_until" DATE,
  "items" JSONB NOT NULL,
  "subtotal" DECIMAL(12,2) NOT NULL,
  "discount_total" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "tax_total" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "total" DECIMAL(12,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "place_of_supply" VARCHAR(2),
  "supply_type" TEXT,
  "notes" TEXT,
  "converted_order_id" TEXT,
  "created_by" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "quotes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "quotes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "quotes_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "quotes_tenant_id_number_key" ON "quotes"("tenant_id", "number");
CREATE INDEX "quotes_tenant_id_status_created_at_idx" ON "quotes"("tenant_id", "status", "created_at");
CREATE INDEX "quotes_tenant_id_customer_id_idx" ON "quotes"("tenant_id", "customer_id");

CREATE TABLE "credit_notes" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "number" TEXT NOT NULL,
  "order_id" TEXT NOT NULL,
  "customer_id" TEXT NOT NULL,
  "reason" TEXT,
  "refund_method" TEXT NOT NULL,
  "items" JSONB NOT NULL,
  "taxable_total" DECIMAL(12,2) NOT NULL,
  "tax_total" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "cgst_total" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "sgst_total" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "igst_total" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "total" DECIMAL(12,2) NOT NULL,
  "refunded_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "created_by" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "credit_notes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "credit_notes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "credit_notes_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "credit_notes_tenant_id_number_key" ON "credit_notes"("tenant_id", "number");
CREATE INDEX "credit_notes_tenant_id_order_id_idx" ON "credit_notes"("tenant_id", "order_id");
CREATE INDEX "credit_notes_tenant_id_customer_id_idx" ON "credit_notes"("tenant_id", "customer_id");

CREATE TABLE "recurring_invoices" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "customer_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "items" JSONB NOT NULL,
  "warehouse_id" TEXT,
  "frequency" TEXT NOT NULL,
  "start_on" DATE NOT NULL,
  "next_run_on" DATE NOT NULL,
  "end_on" DATE,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "send_payment_link" BOOLEAN NOT NULL DEFAULT false,
  "runs_count" INTEGER NOT NULL DEFAULT 0,
  "last_run_at" TIMESTAMPTZ(6),
  "last_order_id" TEXT,
  "last_error" TEXT,
  "created_by" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "recurring_invoices_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "recurring_invoices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "recurring_invoices_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "recurring_invoices_status_next_run_on_idx" ON "recurring_invoices"("status", "next_run_on");
CREATE INDEX "recurring_invoices_tenant_id_idx" ON "recurring_invoices"("tenant_id");

-- New permissions for existing businesses: admin/manager get all, member gets the read ones
INSERT INTO "permissions" ("id", "tenant_id", "name", "resource", "action", "created_at", "updated_at")
SELECT gen_random_uuid()::text, r."tenant_id", p.name, p.resource, p.action, NOW(), NOW()
FROM "roles" r
CROSS JOIN (VALUES
  ('quote:create', 'quote', 'create'), ('quote:read', 'quote', 'read'), ('quote:update', 'quote', 'update'), ('quote:delete', 'quote', 'delete'),
  ('order:return', 'order', 'return'),
  ('recurring_invoice:create', 'recurring_invoice', 'create'), ('recurring_invoice:read', 'recurring_invoice', 'read'),
  ('recurring_invoice:update', 'recurring_invoice', 'update'), ('recurring_invoice:delete', 'recurring_invoice', 'delete')
) AS p(name, resource, action)
WHERE r."name" = 'admin' AND r."is_system" = true
ON CONFLICT ("tenant_id", "resource", "action") DO NOTHING;

INSERT INTO "role_permissions" ("id", "tenant_id", "role_id", "permission_id", "created_at")
SELECT gen_random_uuid()::text, r."tenant_id", r."id", perm."id", NOW()
FROM "roles" r
JOIN "permissions" perm ON perm."tenant_id" = r."tenant_id"
  AND (perm."resource" IN ('quote', 'recurring_invoice') OR (perm."resource" = 'order' AND perm."action" = 'return'))
WHERE r."is_system" = true AND (r."name" IN ('admin', 'manager') OR (r."name" = 'member' AND perm."action" = 'read'))
ON CONFLICT DO NOTHING;
