-- Phase 08 Inventory Management - concurrency & non-negative guards
-- Add CHECK constraints to prevent negative inventory quantities
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_quantity_non_negative') THEN
    ALTER TABLE "inventory" ADD CONSTRAINT "inventory_quantity_non_negative" CHECK ("quantity" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_reserved_quantity_non_negative') THEN
    ALTER TABLE "inventory" ADD CONSTRAINT "inventory_reserved_quantity_non_negative" CHECK ("reserved_quantity" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'warehouse_inventory_quantity_non_negative') THEN
    ALTER TABLE "warehouse_inventory" ADD CONSTRAINT "warehouse_inventory_quantity_non_negative" CHECK ("quantity" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'warehouse_inventory_reserved_quantity_non_negative') THEN
    ALTER TABLE "warehouse_inventory" ADD CONSTRAINT "warehouse_inventory_reserved_quantity_non_negative" CHECK ("reserved_quantity" >= 0);
  END IF;
END $$;

-- Ensure movement reflects transition: quantity_after = quantity_before + quantity_changed
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_movements_quantity_consistency') THEN
    ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_quantity_consistency" CHECK ("quantity_after" = "quantity_before" + "quantity_changed");
  END IF;
END $$;
