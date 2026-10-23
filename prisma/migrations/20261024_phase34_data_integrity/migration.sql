-- Phase 34 Data Integrity
-- 1. customers: (tenant_id, email) unique only among non-deleted customers, so a soft-deleted email can be reused.
-- 2. Cross-tenant guard: a row may only reference a parent row of the same tenant. Enforced by a trigger per
--    relation (Prisma can't model composite tenant FKs). Not guarded on purpose: audit/activity logs, support
--    sessions and platform audit logs (they point at platform admins in the __platform tenant) and auth-token
--    tables. Existing rows are checked once below; the migration fails if any already cross tenants.

-- 1 ────────────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS "customers_tenant_id_email_key";
CREATE INDEX "customers_tenant_id_email_idx" ON "customers"("tenant_id", "email");
CREATE UNIQUE INDEX "customers_tenant_id_email_active_key" ON "customers"("tenant_id", "email") WHERE "deleted_at" IS NULL;

-- 2 ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION pulseops_assert_same_tenant() RETURNS trigger AS $$
DECLARE
  parent_table text := TG_ARGV[0];
  fk_column text := TG_ARGV[1];
  ref_id text;
  parent_tenant text;
BEGIN
  EXECUTE format('SELECT ($1).%I::text', fk_column) INTO ref_id USING NEW;
  IF ref_id IS NULL THEN
    RETURN NEW;
  END IF;
  EXECUTE format('SELECT tenant_id FROM %I WHERE id = $1', parent_table) INTO parent_tenant USING ref_id;
  IF parent_tenant IS NOT NULL AND parent_tenant IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'cross-tenant reference: %.% points at a % row of another tenant', TG_TABLE_NAME, fk_column, parent_table
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "attribute_values_attribute_definition_id_same_tenant" BEFORE INSERT OR UPDATE OF "attribute_definition_id", "tenant_id" ON "attribute_values"
  FOR EACH ROW EXECUTE FUNCTION pulseops_assert_same_tenant('attribute_definitions', 'attribute_definition_id');
CREATE TRIGGER "cart_items_customer_id_same_tenant" BEFORE INSERT OR UPDATE OF "customer_id", "tenant_id" ON "cart_items"
  FOR EACH ROW EXECUTE FUNCTION pulseops_assert_same_tenant('customers', 'customer_id');
CREATE TRIGGER "cart_items_product_variant_id_same_tenant" BEFORE INSERT OR UPDATE OF "product_variant_id", "tenant_id" ON "cart_items"
  FOR EACH ROW EXECUTE FUNCTION pulseops_assert_same_tenant('product_variants', 'product_variant_id');
CREATE TRIGGER "categories_parent_id_same_tenant" BEFORE INSERT OR UPDATE OF "parent_id", "tenant_id" ON "categories"
  FOR EACH ROW EXECUTE FUNCTION pulseops_assert_same_tenant('categories', 'parent_id');
CREATE TRIGGER "customer_addresses_customer_id_same_tenant" BEFORE INSERT OR UPDATE OF "customer_id", "tenant_id" ON "customer_addresses"
  FOR EACH ROW EXECUTE FUNCTION pulseops_assert_same_tenant('customers', 'customer_id');
CREATE TRIGGER "customer_sessions_customer_id_same_tenant" BEFORE INSERT OR UPDATE OF "customer_id", "tenant_id" ON "customer_sessions"
  FOR EACH ROW EXECUTE FUNCTION pulseops_assert_same_tenant('customers', 'customer_id');
CREATE TRIGGER "customer_tokens_customer_id_same_tenant" BEFORE INSERT OR UPDATE OF "customer_id", "tenant_id" ON "customer_tokens"
  FOR EACH ROW EXECUTE FUNCTION pulseops_assert_same_tenant('customers', 'customer_id');
CREATE TRIGGER "inventory_product_variant_id_same_tenant" BEFORE INSERT OR UPDATE OF "product_variant_id", "tenant_id" ON "inventory"
  FOR EACH ROW EXECUTE FUNCTION pulseops_assert_same_tenant('product_variants', 'product_variant_id');
CREATE TRIGGER "inventory_warehouse_id_same_tenant" BEFORE INSERT OR UPDATE OF "warehouse_id", "tenant_id" ON "inventory"
  FOR EACH ROW EXECUTE FUNCTION pulseops_assert_same_tenant('warehouses', 'warehouse_id');
CREATE TRIGGER "inventory_movements_product_variant_id_same_tenant" BEFORE INSERT OR UPDATE OF "product_variant_id", "tenant_id" ON "inventory_movements"
  FOR EACH ROW EXECUTE FUNCTION pulseops_assert_same_tenant('product_variants', 'product_variant_id');
CREATE TRIGGER "inventory_movements_warehouse_id_same_tenant" BEFORE INSERT OR UPDATE OF "warehouse_id", "tenant_id" ON "inventory_movements"
  FOR EACH ROW EXECUTE FUNCTION pulseops_assert_same_tenant('warehouses', 'warehouse_id');
CREATE TRIGGER "order_items_order_id_same_tenant" BEFORE INSERT OR UPDATE OF "order_id", "tenant_id" ON "order_items"
  FOR EACH ROW EXECUTE FUNCTION pulseops_assert_same_tenant('orders', 'order_id');
CREATE TRIGGER "order_items_product_variant_id_same_tenant" BEFORE INSERT OR UPDATE OF "product_variant_id", "tenant_id" ON "order_items"
  FOR EACH ROW EXECUTE FUNCTION pulseops_assert_same_tenant('product_variants', 'product_variant_id');
CREATE TRIGGER "order_status_history_order_id_same_tenant" BEFORE INSERT OR UPDATE OF "order_id", "tenant_id" ON "order_status_history"
  FOR EACH ROW EXECUTE FUNCTION pulseops_assert_same_tenant('orders', 'order_id');
CREATE TRIGGER "orders_customer_id_same_tenant" BEFORE INSERT OR UPDATE OF "customer_id", "tenant_id" ON "orders"
  FOR EACH ROW EXECUTE FUNCTION pulseops_assert_same_tenant('customers', 'customer_id');
CREATE TRIGGER "payment_transactions_payment_id_same_tenant" BEFORE INSERT OR UPDATE OF "payment_id", "tenant_id" ON "payment_transactions"
  FOR EACH ROW EXECUTE FUNCTION pulseops_assert_same_tenant('payments', 'payment_id');
CREATE TRIGGER "payment_webhook_events_payment_id_same_tenant" BEFORE INSERT OR UPDATE OF "payment_id", "tenant_id" ON "payment_webhook_events"
  FOR EACH ROW EXECUTE FUNCTION pulseops_assert_same_tenant('payments', 'payment_id');
CREATE TRIGGER "payments_order_id_same_tenant" BEFORE INSERT OR UPDATE OF "order_id", "tenant_id" ON "payments"
  FOR EACH ROW EXECUTE FUNCTION pulseops_assert_same_tenant('orders', 'order_id');
CREATE TRIGGER "product_categories_category_id_same_tenant" BEFORE INSERT OR UPDATE OF "category_id", "tenant_id" ON "product_categories"
  FOR EACH ROW EXECUTE FUNCTION pulseops_assert_same_tenant('categories', 'category_id');
CREATE TRIGGER "product_categories_product_id_same_tenant" BEFORE INSERT OR UPDATE OF "product_id", "tenant_id" ON "product_categories"
  FOR EACH ROW EXECUTE FUNCTION pulseops_assert_same_tenant('products', 'product_id');
CREATE TRIGGER "product_images_product_id_same_tenant" BEFORE INSERT OR UPDATE OF "product_id", "tenant_id" ON "product_images"
  FOR EACH ROW EXECUTE FUNCTION pulseops_assert_same_tenant('products', 'product_id');
CREATE TRIGGER "product_images_variant_id_same_tenant" BEFORE INSERT OR UPDATE OF "variant_id", "tenant_id" ON "product_images"
  FOR EACH ROW EXECUTE FUNCTION pulseops_assert_same_tenant('product_variants', 'variant_id');
CREATE TRIGGER "product_variant_attributes_attribute_definition_id_same_tenant" BEFORE INSERT OR UPDATE OF "attribute_definition_id", "tenant_id" ON "product_variant_attributes"
  FOR EACH ROW EXECUTE FUNCTION pulseops_assert_same_tenant('attribute_definitions', 'attribute_definition_id');
CREATE TRIGGER "product_variant_attributes_variant_id_same_tenant" BEFORE INSERT OR UPDATE OF "variant_id", "tenant_id" ON "product_variant_attributes"
  FOR EACH ROW EXECUTE FUNCTION pulseops_assert_same_tenant('product_variants', 'variant_id');
CREATE TRIGGER "product_variants_product_id_same_tenant" BEFORE INSERT OR UPDATE OF "product_id", "tenant_id" ON "product_variants"
  FOR EACH ROW EXECUTE FUNCTION pulseops_assert_same_tenant('products', 'product_id');
CREATE TRIGGER "refunds_payment_id_same_tenant" BEFORE INSERT OR UPDATE OF "payment_id", "tenant_id" ON "refunds"
  FOR EACH ROW EXECUTE FUNCTION pulseops_assert_same_tenant('payments', 'payment_id');
CREATE TRIGGER "reports_requested_by_same_tenant" BEFORE INSERT OR UPDATE OF "requested_by", "tenant_id" ON "reports"
  FOR EACH ROW EXECUTE FUNCTION pulseops_assert_same_tenant('users', 'requested_by');
CREATE TRIGGER "role_permissions_permission_id_same_tenant" BEFORE INSERT OR UPDATE OF "permission_id", "tenant_id" ON "role_permissions"
  FOR EACH ROW EXECUTE FUNCTION pulseops_assert_same_tenant('permissions', 'permission_id');
CREATE TRIGGER "role_permissions_role_id_same_tenant" BEFORE INSERT OR UPDATE OF "role_id", "tenant_id" ON "role_permissions"
  FOR EACH ROW EXECUTE FUNCTION pulseops_assert_same_tenant('roles', 'role_id');
CREATE TRIGGER "tenant_memberships_role_id_same_tenant" BEFORE INSERT OR UPDATE OF "role_id", "tenant_id" ON "tenant_memberships"
  FOR EACH ROW EXECUTE FUNCTION pulseops_assert_same_tenant('roles', 'role_id');
CREATE TRIGGER "tenant_memberships_user_id_same_tenant" BEFORE INSERT OR UPDATE OF "user_id", "tenant_id" ON "tenant_memberships"
  FOR EACH ROW EXECUTE FUNCTION pulseops_assert_same_tenant('users', 'user_id');
CREATE TRIGGER "user_roles_role_id_same_tenant" BEFORE INSERT OR UPDATE OF "role_id", "tenant_id" ON "user_roles"
  FOR EACH ROW EXECUTE FUNCTION pulseops_assert_same_tenant('roles', 'role_id');
CREATE TRIGGER "user_roles_user_id_same_tenant" BEFORE INSERT OR UPDATE OF "user_id", "tenant_id" ON "user_roles"
  FOR EACH ROW EXECUTE FUNCTION pulseops_assert_same_tenant('users', 'user_id');
CREATE TRIGGER "warehouse_inventory_product_variant_id_same_tenant" BEFORE INSERT OR UPDATE OF "product_variant_id", "tenant_id" ON "warehouse_inventory"
  FOR EACH ROW EXECUTE FUNCTION pulseops_assert_same_tenant('product_variants', 'product_variant_id');
CREATE TRIGGER "warehouse_inventory_warehouse_id_same_tenant" BEFORE INSERT OR UPDATE OF "warehouse_id", "tenant_id" ON "warehouse_inventory"
  FOR EACH ROW EXECUTE FUNCTION pulseops_assert_same_tenant('warehouses', 'warehouse_id');

-- Existing data must already be consistent
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(rel, ', ') INTO bad FROM (
  SELECT 'attribute_values.attribute_definition_id' FROM "attribute_values" c JOIN "attribute_definitions" p ON p."id" = c."attribute_definition_id" WHERE p."tenant_id" <> c."tenant_id"
  UNION ALL
  SELECT 'cart_items.customer_id' FROM "cart_items" c JOIN "customers" p ON p."id" = c."customer_id" WHERE p."tenant_id" <> c."tenant_id"
  UNION ALL
  SELECT 'cart_items.product_variant_id' FROM "cart_items" c JOIN "product_variants" p ON p."id" = c."product_variant_id" WHERE p."tenant_id" <> c."tenant_id"
  UNION ALL
  SELECT 'categories.parent_id' FROM "categories" c JOIN "categories" p ON p."id" = c."parent_id" WHERE p."tenant_id" <> c."tenant_id"
  UNION ALL
  SELECT 'customer_addresses.customer_id' FROM "customer_addresses" c JOIN "customers" p ON p."id" = c."customer_id" WHERE p."tenant_id" <> c."tenant_id"
  UNION ALL
  SELECT 'customer_sessions.customer_id' FROM "customer_sessions" c JOIN "customers" p ON p."id" = c."customer_id" WHERE p."tenant_id" <> c."tenant_id"
  UNION ALL
  SELECT 'customer_tokens.customer_id' FROM "customer_tokens" c JOIN "customers" p ON p."id" = c."customer_id" WHERE p."tenant_id" <> c."tenant_id"
  UNION ALL
  SELECT 'inventory.product_variant_id' FROM "inventory" c JOIN "product_variants" p ON p."id" = c."product_variant_id" WHERE p."tenant_id" <> c."tenant_id"
  UNION ALL
  SELECT 'inventory.warehouse_id' FROM "inventory" c JOIN "warehouses" p ON p."id" = c."warehouse_id" WHERE p."tenant_id" <> c."tenant_id"
  UNION ALL
  SELECT 'inventory_movements.product_variant_id' FROM "inventory_movements" c JOIN "product_variants" p ON p."id" = c."product_variant_id" WHERE p."tenant_id" <> c."tenant_id"
  UNION ALL
  SELECT 'inventory_movements.warehouse_id' FROM "inventory_movements" c JOIN "warehouses" p ON p."id" = c."warehouse_id" WHERE p."tenant_id" <> c."tenant_id"
  UNION ALL
  SELECT 'order_items.order_id' FROM "order_items" c JOIN "orders" p ON p."id" = c."order_id" WHERE p."tenant_id" <> c."tenant_id"
  UNION ALL
  SELECT 'order_items.product_variant_id' FROM "order_items" c JOIN "product_variants" p ON p."id" = c."product_variant_id" WHERE p."tenant_id" <> c."tenant_id"
  UNION ALL
  SELECT 'order_status_history.order_id' FROM "order_status_history" c JOIN "orders" p ON p."id" = c."order_id" WHERE p."tenant_id" <> c."tenant_id"
  UNION ALL
  SELECT 'orders.customer_id' FROM "orders" c JOIN "customers" p ON p."id" = c."customer_id" WHERE p."tenant_id" <> c."tenant_id"
  UNION ALL
  SELECT 'payment_transactions.payment_id' FROM "payment_transactions" c JOIN "payments" p ON p."id" = c."payment_id" WHERE p."tenant_id" <> c."tenant_id"
  UNION ALL
  SELECT 'payment_webhook_events.payment_id' FROM "payment_webhook_events" c JOIN "payments" p ON p."id" = c."payment_id" WHERE p."tenant_id" <> c."tenant_id"
  UNION ALL
  SELECT 'payments.order_id' FROM "payments" c JOIN "orders" p ON p."id" = c."order_id" WHERE p."tenant_id" <> c."tenant_id"
  UNION ALL
  SELECT 'product_categories.category_id' FROM "product_categories" c JOIN "categories" p ON p."id" = c."category_id" WHERE p."tenant_id" <> c."tenant_id"
  UNION ALL
  SELECT 'product_categories.product_id' FROM "product_categories" c JOIN "products" p ON p."id" = c."product_id" WHERE p."tenant_id" <> c."tenant_id"
  UNION ALL
  SELECT 'product_images.product_id' FROM "product_images" c JOIN "products" p ON p."id" = c."product_id" WHERE p."tenant_id" <> c."tenant_id"
  UNION ALL
  SELECT 'product_images.variant_id' FROM "product_images" c JOIN "product_variants" p ON p."id" = c."variant_id" WHERE p."tenant_id" <> c."tenant_id"
  UNION ALL
  SELECT 'product_variant_attributes.attribute_definition_id' FROM "product_variant_attributes" c JOIN "attribute_definitions" p ON p."id" = c."attribute_definition_id" WHERE p."tenant_id" <> c."tenant_id"
  UNION ALL
  SELECT 'product_variant_attributes.variant_id' FROM "product_variant_attributes" c JOIN "product_variants" p ON p."id" = c."variant_id" WHERE p."tenant_id" <> c."tenant_id"
  UNION ALL
  SELECT 'product_variants.product_id' FROM "product_variants" c JOIN "products" p ON p."id" = c."product_id" WHERE p."tenant_id" <> c."tenant_id"
  UNION ALL
  SELECT 'refunds.payment_id' FROM "refunds" c JOIN "payments" p ON p."id" = c."payment_id" WHERE p."tenant_id" <> c."tenant_id"
  UNION ALL
  SELECT 'reports.requested_by' FROM "reports" c JOIN "users" p ON p."id" = c."requested_by" WHERE p."tenant_id" <> c."tenant_id"
  UNION ALL
  SELECT 'role_permissions.permission_id' FROM "role_permissions" c JOIN "permissions" p ON p."id" = c."permission_id" WHERE p."tenant_id" <> c."tenant_id"
  UNION ALL
  SELECT 'role_permissions.role_id' FROM "role_permissions" c JOIN "roles" p ON p."id" = c."role_id" WHERE p."tenant_id" <> c."tenant_id"
  UNION ALL
  SELECT 'tenant_memberships.role_id' FROM "tenant_memberships" c JOIN "roles" p ON p."id" = c."role_id" WHERE p."tenant_id" <> c."tenant_id"
  UNION ALL
  SELECT 'tenant_memberships.user_id' FROM "tenant_memberships" c JOIN "users" p ON p."id" = c."user_id" WHERE p."tenant_id" <> c."tenant_id"
  UNION ALL
  SELECT 'user_roles.role_id' FROM "user_roles" c JOIN "roles" p ON p."id" = c."role_id" WHERE p."tenant_id" <> c."tenant_id"
  UNION ALL
  SELECT 'user_roles.user_id' FROM "user_roles" c JOIN "users" p ON p."id" = c."user_id" WHERE p."tenant_id" <> c."tenant_id"
  UNION ALL
  SELECT 'warehouse_inventory.product_variant_id' FROM "warehouse_inventory" c JOIN "product_variants" p ON p."id" = c."product_variant_id" WHERE p."tenant_id" <> c."tenant_id"
  UNION ALL
  SELECT 'warehouse_inventory.warehouse_id' FROM "warehouse_inventory" c JOIN "warehouses" p ON p."id" = c."warehouse_id" WHERE p."tenant_id" <> c."tenant_id"
  ) v(rel);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'cross-tenant rows already exist in: %', bad;
  END IF;
END $$;
