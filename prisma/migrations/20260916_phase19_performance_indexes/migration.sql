-- Phase 19 Performance Optimization Indexes
-- These indexes were added to optimize query performance for tenant-scoped filtering and sorting

-- ProductVariant: tenantId + price for price range filtering
CREATE INDEX IF NOT EXISTS "product_variants_tenant_id_price_idx" ON "public"."product_variants" USING btree ("tenant_id", "price");

-- ProductVariant: tenantId + status + createdAt for status filtering with sort
CREATE INDEX IF NOT EXISTS "product_variants_tenant_id_status_created_at_idx" ON "public"."product_variants" USING btree ("tenant_id", "status", "created_at");

-- Inventory: tenantId + quantity for low-stock queries
CREATE INDEX IF NOT EXISTS "inventory_tenant_id_quantity_idx" ON "public"."inventory" USING btree ("tenant_id", "quantity");

-- Order: tenantId + customerId + createdAt for customer order history pagination
CREATE INDEX IF NOT EXISTS "orders_tenant_id_customer_id_created_at_idx" ON "public"."orders" USING btree ("tenant_id", "customer_id", "created_at");