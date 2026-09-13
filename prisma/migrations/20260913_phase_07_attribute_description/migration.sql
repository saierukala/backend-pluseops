-- Add description column to attribute_definitions (Phase 7)
ALTER TABLE "attribute_definitions" ADD COLUMN IF NOT EXISTS "description" TEXT;
