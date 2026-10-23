-- Phase 33 Platform Operations: subscription plans with limits, and a platform-level audit trail.

-- CreateTable
CREATE TABLE "plans" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "limits" JSONB NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_audit_logs" (
    "id" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT,
    "tenant_id" TEXT,
    "details" JSONB NOT NULL DEFAULT '{}',
    "ip_address" VARCHAR(64),
    "user_agent" VARCHAR(512),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plans_code_key" ON "plans"("code");

-- CreateIndex
CREATE INDEX "platform_audit_logs_created_at_idx" ON "platform_audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "platform_audit_logs_tenant_id_created_at_idx" ON "platform_audit_logs"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "platform_audit_logs_actor_user_id_created_at_idx" ON "platform_audit_logs"("actor_user_id", "created_at");

-- AddForeignKey
ALTER TABLE "platform_audit_logs" ADD CONSTRAINT "platform_audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_audit_logs" ADD CONSTRAINT "platform_audit_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Default plans, unlimited until a platform admin sets limits. Every plan code tenants already use gets a row
-- so existing tenants stay valid ('platform' is the internal __platform tenant's plan).
INSERT INTO "plans" ("id", "code", "name", "description", "limits", "updated_at") VALUES
  (gen_random_uuid(), 'free', 'Free', 'Starter plan', '{"users": null, "products": null, "warehouses": null, "ordersPerMonth": null}', NOW()),
  (gen_random_uuid(), 'pro', 'Pro', 'Growing businesses', '{"users": null, "products": null, "warehouses": null, "ordersPerMonth": null}', NOW()),
  (gen_random_uuid(), 'enterprise', 'Enterprise', 'Large businesses', '{"users": null, "products": null, "warehouses": null, "ordersPerMonth": null}', NOW())
ON CONFLICT ("code") DO NOTHING;
INSERT INTO "plans" ("id", "code", "name", "description", "limits", "updated_at")
  SELECT gen_random_uuid(), t."plan", initcap(t."plan"), 'Created from existing tenants', '{}', NOW()
  FROM (SELECT DISTINCT "plan" FROM "tenants") t
ON CONFLICT ("code") DO NOTHING;
