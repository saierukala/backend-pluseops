-- Phase 10 Payment & Transaction Processing - webhook idempotency and payment constraints
-- Create payment_webhook_events table for idempotent webhook handling
CREATE TABLE IF NOT EXISTS "payment_webhook_events" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "payment_id" TEXT,
    "event_id" TEXT NOT NULL,
    "provider_event_id" TEXT,
    "provider_payment_id" TEXT,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payment_webhook_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "payment_webhook_events_tenant_id_event_id_key" ON "payment_webhook_events"("tenant_id", "event_id");
CREATE UNIQUE INDEX IF NOT EXISTS "payment_webhook_events_event_id_key" ON "payment_webhook_events"("event_id");
CREATE INDEX IF NOT EXISTS "payment_webhook_events_tenant_id_payment_id_idx" ON "payment_webhook_events"("tenant_id", "payment_id");
CREATE INDEX IF NOT EXISTS "payment_webhook_events_tenant_id_provider_event_id_idx" ON "payment_webhook_events"("tenant_id", "provider_event_id");
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_webhook_events_tenant_id_fkey') THEN
    ALTER TABLE "payment_webhook_events" ADD CONSTRAINT "payment_webhook_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_webhook_events_payment_id_fkey') THEN
    ALTER TABLE "payment_webhook_events" ADD CONSTRAINT "payment_webhook_events_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
-- Enforce unique provider identifiers at DB level for idempotency (allow multiple NULLs)
CREATE UNIQUE INDEX IF NOT EXISTS "payments_tenant_provider_payment_id_unique" ON "payments"("tenant_id", "provider_payment_id") WHERE "provider_payment_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "payment_transactions_tenant_provider_txn_unique" ON "payment_transactions"("tenant_id", "provider_transaction_id") WHERE "provider_transaction_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "refunds_tenant_provider_refund_unique" ON "refunds"("tenant_id", "provider_refund_id") WHERE "provider_refund_id" IS NOT NULL;
-- Ensure monetary amounts are non-negative
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_amount_non_negative') THEN
    ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_non_negative" CHECK ("amount" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_transactions_amount_non_negative') THEN
    ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_amount_non_negative" CHECK ("amount" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'refunds_amount_non_negative') THEN
    ALTER TABLE "refunds" ADD CONSTRAINT "refunds_amount_non_negative" CHECK ("amount" >= 0);
  END IF;
END $$;
