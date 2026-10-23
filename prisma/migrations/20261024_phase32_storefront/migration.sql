-- Phase 32 Storefront
-- * customers: storefront account fields (per tenant)
-- * customer_sessions / customer_tokens: shopper login sessions and emailed set-password tokens
-- * cart_items: server-side cart
-- * tenant_domains: DNS verification; a domain is reserved platform-wide only once verified

-- CreateEnum
CREATE TYPE "CustomerTokenType" AS ENUM ('SET_PASSWORD');

-- DropIndex
DROP INDEX "tenant_domains_domain_key";

-- DropIndex
DROP INDEX "tenant_domains_tenant_id_idx";

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "email_verified_at" TIMESTAMPTZ(6),
ADD COLUMN     "last_login_at" TIMESTAMPTZ(6),
ADD COLUMN     "password_hash" TEXT;

-- AlterTable
ALTER TABLE "tenant_domains" ADD COLUMN     "verification_token" TEXT,
ADD COLUMN     "verified_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "customer_sessions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "last_used_at" TIMESTAMPTZ(6),
    "user_agent" VARCHAR(512),
    "ip_address" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_tokens" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "type" "CustomerTokenType" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cart_items" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "product_variant_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "cart_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_sessions_customer_id_idx" ON "customer_sessions"("customer_id");

-- CreateIndex
CREATE INDEX "customer_sessions_tenant_id_idx" ON "customer_sessions"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_tokens_token_hash_key" ON "customer_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "customer_tokens_customer_id_idx" ON "customer_tokens"("customer_id");

-- CreateIndex
CREATE INDEX "cart_items_tenant_id_idx" ON "cart_items"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "cart_items_customer_id_product_variant_id_key" ON "cart_items"("customer_id", "product_variant_id");

-- CreateIndex
CREATE INDEX "tenant_domains_domain_idx" ON "tenant_domains"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_domains_tenant_id_domain_key" ON "tenant_domains"("tenant_id", "domain");

-- AddForeignKey
ALTER TABLE "customer_sessions" ADD CONSTRAINT "customer_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_sessions" ADD CONSTRAINT "customer_sessions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_tokens" ADD CONSTRAINT "customer_tokens_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_tokens" ADD CONSTRAINT "customer_tokens_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_product_variant_id_fkey" FOREIGN KEY ("product_variant_id") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Existing domains get a verification token so they can be verified.
UPDATE "tenant_domains" SET "verification_token" = md5(random()::text || clock_timestamp()::text) || md5(random()::text) WHERE "verification_token" IS NULL;

-- Only one tenant may hold a domain verified (not expressible in the Prisma schema).
CREATE UNIQUE INDEX "tenant_domains_domain_verified_key" ON "tenant_domains"("domain") WHERE "verified";
