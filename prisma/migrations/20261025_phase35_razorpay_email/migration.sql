-- Phase 35: each shop's own Razorpay account (key secret and webhook secret are AES-256-GCM encrypted by the API).
-- CreateTable
CREATE TABLE "tenant_payment_gateways" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'razorpay',
    "key_id" TEXT NOT NULL,
    "key_secret_encrypted" TEXT NOT NULL,
    "webhook_secret_encrypted" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenant_payment_gateways_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_payment_gateways_tenant_id_key" ON "tenant_payment_gateways"("tenant_id");

-- AddForeignKey
ALTER TABLE "tenant_payment_gateways" ADD CONSTRAINT "tenant_payment_gateways_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

