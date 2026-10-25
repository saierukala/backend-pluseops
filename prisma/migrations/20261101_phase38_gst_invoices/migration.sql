-- Phase 38: GST tax invoices (per-item GST, CGST/SGST/IGST, B2B customers, invoice numbers per financial year).

-- Products: HSN/SAC code, own GST rate (null = workspace default) and taxability
ALTER TABLE "products" ADD COLUMN "hsn_code" VARCHAR(8);
ALTER TABLE "products" ADD COLUMN "gst_rate_percent" DECIMAL(5,2);
ALTER TABLE "products" ADD COLUMN "gst_taxability" TEXT NOT NULL DEFAULT 'TAXABLE';
ALTER TABLE "products" ADD COLUMN "unit" VARCHAR(10);

-- Variants: printed maximum retail price
ALTER TABLE "product_variants" ADD COLUMN "mrp" DECIMAL(12,2);

-- Customers: consumer or registered business
ALTER TABLE "customers" ADD COLUMN "customer_type" TEXT NOT NULL DEFAULT 'CONSUMER';
ALTER TABLE "customers" ADD COLUMN "company_name" TEXT;
ALTER TABLE "customers" ADD COLUMN "gstin" VARCHAR(15);
ALTER TABLE "customers" ADD COLUMN "pan" VARCHAR(10);
ALTER TABLE "customers" ADD COLUMN "state_code" VARCHAR(2);

-- Orders: the tax invoice
ALTER TABLE "orders" ADD COLUMN "invoice_number" TEXT;
ALTER TABLE "orders" ADD COLUMN "invoice_date" TIMESTAMPTZ(6);
ALTER TABLE "orders" ADD COLUMN "place_of_supply" VARCHAR(2);
ALTER TABLE "orders" ADD COLUMN "supply_type" TEXT;
ALTER TABLE "orders" ADD COLUMN "cgst_total" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "orders" ADD COLUMN "sgst_total" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "orders" ADD COLUMN "igst_total" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "orders" ADD COLUMN "buyer_snapshot" JSONB;
ALTER TABLE "orders" ADD COLUMN "seller_snapshot" JSONB;
CREATE UNIQUE INDEX "orders_tenant_id_invoice_number_key" ON "orders"("tenant_id", "invoice_number");

-- Order lines: what the tax was worked out on
ALTER TABLE "order_items" ADD COLUMN "hsn_code" VARCHAR(8);
ALTER TABLE "order_items" ADD COLUMN "gst_rate_percent" DECIMAL(5,2) NOT NULL DEFAULT 0;
ALTER TABLE "order_items" ADD COLUMN "taxable_value" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "order_items" ADD COLUMN "cgst" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "order_items" ADD COLUMN "sgst" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "order_items" ADD COLUMN "igst" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- Existing lines: taxable value = price × qty − discount; their tax counted as intra-state
UPDATE "order_items" SET "taxable_value" = "unit_price" * "quantity" - "discount", "cgst" = FLOOR("tax" * 100 / 2) / 100, "sgst" = "tax" - FLOOR("tax" * 100 / 2) / 100;
UPDATE "orders" o SET "cgst_total" = t.cgst, "sgst_total" = t.sgst, "supply_type" = 'INTRA'
FROM (SELECT "order_id", SUM("cgst") AS cgst, SUM("sgst") AS sgst FROM "order_items" GROUP BY "order_id") t
WHERE t."order_id" = o."id";

-- One running invoice counter per workspace per financial year
CREATE TABLE "invoice_sequences" (
  "tenant_id" TEXT NOT NULL,
  "financial_year" VARCHAR(7) NOT NULL,
  "last_number" INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "invoice_sequences_pkey" PRIMARY KEY ("tenant_id", "financial_year"),
  CONSTRAINT "invoice_sequences_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
