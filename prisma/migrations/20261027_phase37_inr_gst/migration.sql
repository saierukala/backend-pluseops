-- Phase 37: rupees by default. Existing rows keep the currency they were recorded in.
ALTER TABLE "orders" ALTER COLUMN "currency" SET DEFAULT 'INR';
ALTER TABLE "payments" ALTER COLUMN "currency" SET DEFAULT 'INR';
ALTER TABLE "payment_transactions" ALTER COLUMN "currency" SET DEFAULT 'INR';
ALTER TABLE "refunds" ALTER COLUMN "currency" SET DEFAULT 'INR';
