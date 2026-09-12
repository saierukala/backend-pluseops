-- Phase 05: Separate platform authorization from tenant authorization.
CREATE TYPE "TenantMembershipStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'SUSPENDED');

-- A user is globally unique. tenant_id remains the original/default tenant for
-- backwards compatibility; access is granted exclusively by memberships.
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_tenant_id_email_key";
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

CREATE TABLE "tenant_memberships" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role_id" TEXT,
    "status" "TenantMembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "tenant_memberships_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tenant_memberships_tenant_id_user_id_key" ON "tenant_memberships"("tenant_id", "user_id");

-- Preserve all existing Phase 1-4 users as active members of their current tenant.
INSERT INTO "tenant_memberships" ("id", "tenant_id", "user_id", "status", "created_at", "updated_at")
SELECT gen_random_uuid()::text, "tenant_id", "id", 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "users"
ON CONFLICT ("tenant_id", "user_id") DO NOTHING;

CREATE INDEX "tenant_memberships_user_id_status_idx" ON "tenant_memberships"("user_id", "status");
CREATE INDEX "tenant_memberships_tenant_id_status_idx" ON "tenant_memberships"("tenant_id", "status");
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "platform_roles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "platform_roles_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "platform_permissions" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "platform_permissions_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "platform_user_roles" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "platform_user_roles_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "platform_role_permissions" (
    "id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "permission_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "platform_role_permissions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "platform_roles_name_key" ON "platform_roles"("name");
CREATE UNIQUE INDEX "platform_permissions_name_key" ON "platform_permissions"("name");
CREATE UNIQUE INDEX "platform_permissions_resource_action_key" ON "platform_permissions"("resource", "action");
CREATE UNIQUE INDEX "platform_user_roles_user_id_role_id_key" ON "platform_user_roles"("user_id", "role_id");
CREATE INDEX "platform_user_roles_user_id_idx" ON "platform_user_roles"("user_id");
CREATE UNIQUE INDEX "platform_role_permissions_role_id_permission_id_key" ON "platform_role_permissions"("role_id", "permission_id");
CREATE INDEX "platform_role_permissions_permission_id_idx" ON "platform_role_permissions"("permission_id");
ALTER TABLE "platform_user_roles" ADD CONSTRAINT "platform_user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "platform_user_roles" ADD CONSTRAINT "platform_user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "platform_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "platform_role_permissions" ADD CONSTRAINT "platform_role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "platform_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "platform_role_permissions" ADD CONSTRAINT "platform_role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "platform_permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
