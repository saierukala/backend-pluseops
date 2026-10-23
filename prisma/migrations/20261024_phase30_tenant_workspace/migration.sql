-- Phase 30 Tenant Workspace
-- * users: drop the redundant (tenant_id, email) unique — email is already unique platform-wide
--   (decision: one person = one account = one business).
-- * tenant_domains: a domain belongs to one tenant platform-wide; at most one primary domain per tenant.
-- * support_sessions: read-only platform support access to a tenant (frontend F33).

-- Fail with a clear message instead of a bare unique-violation if two tenants already claim the same domain.
DO $$
BEGIN
  IF EXISTS (SELECT lower("domain") FROM "tenant_domains" GROUP BY lower("domain") HAVING COUNT(*) > 1) THEN
    RAISE EXCEPTION 'tenant_domains has the same domain on several rows; resolve duplicates before applying this migration';
  END IF;
END $$;
UPDATE "tenant_domains" SET "domain" = lower("domain") WHERE "domain" <> lower("domain");

-- DropIndex
DROP INDEX "tenant_domains_tenant_id_domain_key";

-- DropIndex
DROP INDEX "users_tenant_id_email_key";

-- CreateTable
CREATE TABLE "support_sessions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "platform_user_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "ended_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "support_sessions_tenant_id_created_at_idx" ON "support_sessions"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "support_sessions_platform_user_id_idx" ON "support_sessions"("platform_user_id");

-- CreateIndex
CREATE INDEX "tenant_domains_tenant_id_idx" ON "tenant_domains"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_domains_domain_key" ON "tenant_domains"("domain");

-- AddForeignKey
ALTER TABLE "support_sessions" ADD CONSTRAINT "support_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_sessions" ADD CONSTRAINT "support_sessions_platform_user_id_fkey" FOREIGN KEY ("platform_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- At most one primary domain per tenant (not expressible in the Prisma schema).
CREATE UNIQUE INDEX "tenant_domains_tenant_id_primary_key" ON "tenant_domains"("tenant_id") WHERE "primary";
