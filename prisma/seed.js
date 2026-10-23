import { existsSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import {
  SYSTEM_PERMISSIONS,
  SYSTEM_ROLES,
  MANAGER_EXCLUDED_PERMISSIONS,
  PLATFORM_PERMISSIONS,
} from '../src/modules/permissions/system-permissions.js';
import { resolvePlatformAdminCredentials } from './platform-admin-credentials.js';

// Same precedence as src/config/env.js: deployment-provided variables win over .env
if (existsSync('.env') && typeof process.loadEnvFile === 'function') {
  const deploymentEnvironment = { ...process.env };
  process.loadEnvFile('.env');
  Object.assign(process.env, deploymentEnvironment);
}

const prisma = new PrismaClient();

const PLATFORM_TENANT_SLUG = '__platform';
const { email: PLATFORM_ADMIN_EMAIL, password: PLATFORM_ADMIN_PASSWORD, usingDefaults } = resolvePlatformAdminCredentials(process.env);
if (usingDefaults) {
  // eslint-disable-next-line no-console
  console.warn('Seed: PLATFORM_ADMIN_EMAIL/PLATFORM_ADMIN_PASSWORD not set — using the development default platform admin.');
}

async function hashPassword(password) {
  return argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
}

async function seedTenant(tenantId) {
  const permissions = {};
  for (const perm of SYSTEM_PERMISSIONS) {
    const p = await prisma.permission.upsert({
      where: {
        tenantId_resource_action: {
          tenantId,
          resource: perm.resource,
          action: perm.action,
        },
      },
      update: {},
      create: {
        tenantId,
        name: perm.name,
        resource: perm.resource,
        action: perm.action,
      },
    });
    permissions[`${perm.resource}:${perm.action}`] = p.id;
  }

  const roles = {};
  for (const role of SYSTEM_ROLES) {
    const r = await prisma.role.upsert({
      where: {
        tenantId_name: {
          tenantId,
          name: role.name,
        },
      },
      // System roles are immutable through the API (update backfills tenants created before Phase 27)
      update: { description: role.description, isSystem: true },
      create: {
        tenantId,
        name: role.name,
        description: role.description,
        isSystem: true,
      },
    });
    roles[role.name] = r.id;
  }

  const adminPerms = Object.values(permissions);
  for (const permId of adminPerms) {
    await prisma.rolePermission.upsert({
      where: {
        tenantId_roleId_permissionId: {
          tenantId,
          roleId: roles.admin,
          permissionId: permId,
        },
      },
      update: {},
      create: {
        tenantId,
        roleId: roles.admin,
        permissionId: permId,
      },
    });
  }

  const managerExclude = MANAGER_EXCLUDED_PERMISSIONS;
  const managerPerms = Object.entries(permissions)
    .filter(([key]) => !managerExclude.includes(key))
    .map(([, v]) => v);
  for (const permId of managerPerms) {
    await prisma.rolePermission.upsert({
      where: {
        tenantId_roleId_permissionId: {
          tenantId,
          roleId: roles.manager,
          permissionId: permId,
        },
      },
      update: {},
      create: {
        tenantId,
        roleId: roles.manager,
        permissionId: permId,
      },
    });
  }

  const memberPerms = Object.entries(permissions)
    .filter(([key]) => key.endsWith(':read'))
    .map(([, v]) => v);
  for (const permId of memberPerms) {
    await prisma.rolePermission.upsert({
      where: {
        tenantId_roleId_permissionId: {
          tenantId,
          roleId: roles.member,
          permissionId: permId,
        },
      },
      update: {},
      create: {
        tenantId,
        roleId: roles.member,
        permissionId: permId,
      },
    });
  }
}

async function seedPlatformAdmin() {
  // Ensure platform tenant exists
  const platformTenant = await prisma.tenant.upsert({
    where: { slug: PLATFORM_TENANT_SLUG },
    update: { name: 'Platform', status: 'ACTIVE', plan: 'platform' },
    create: { name: 'Platform', slug: PLATFORM_TENANT_SLUG, status: 'ACTIVE', plan: 'platform' },
  });

  const platformRole = await prisma.platformRole.upsert({
    where: { name: 'platform_admin' },
    update: { description: 'PulseOps platform administration', isSystem: true },
    create: { name: 'platform_admin', description: 'PulseOps platform administration', isSystem: true },
  });
  for (const permission of PLATFORM_PERMISSIONS) {
    const stored = await prisma.platformPermission.upsert({
      where: { resource_action: { resource: permission.resource, action: permission.action } },
      update: { name: permission.name },
      create: permission,
    });
    await prisma.platformRolePermission.upsert({
      where: { roleId_permissionId: { roleId: platformRole.id, permissionId: stored.id } },
      update: {},
      create: { roleId: platformRole.id, permissionId: stored.id },
    });
  }

  // Upsert platform admin user idempotently; never duplicate on repeated seed
  const passwordHash = await hashPassword(PLATFORM_ADMIN_PASSWORD);
  let platformUser = await prisma.user.findUnique({ where: { email: PLATFORM_ADMIN_EMAIL } });
  if (!platformUser) {
    platformUser = await prisma.user.create({
      data: {
        tenantId: platformTenant.id,
        email: PLATFORM_ADMIN_EMAIL,
        passwordHash,
        firstName: 'Platform',
        lastName: 'Admin',
        status: 'ACTIVE',
        emailVerified: true,
        memberships: {
          create: { tenantId: platformTenant.id, status: 'ACTIVE' },
        },
      },
    });
  } else {
    // Ensure existing user is corrected to platform tenant and active, update hash if needed
    // Only update passwordHash if verification fails (means password changed or hash outdated) - compare via argon2 verify
    let needsUpdate = false;
    try {
      const valid = await argon2.verify(platformUser.passwordHash, PLATFORM_ADMIN_PASSWORD);
      if (!valid) needsUpdate = true;
    } catch {
      needsUpdate = true;
    }
    const updateData = {};
    if (platformUser.tenantId !== platformTenant.id) updateData.tenantId = platformTenant.id;
    if (platformUser.status !== 'ACTIVE') updateData.status = 'ACTIVE';
    if (!platformUser.emailVerified) updateData.emailVerified = true;
    if (needsUpdate) updateData.passwordHash = passwordHash;
    if (Object.keys(updateData).length > 0) {
      platformUser = await prisma.user.update({ where: { id: platformUser.id }, data: updateData });
    }
    // Ensure membership exists
    const membership = await prisma.tenantMembership.findUnique({
      where: { tenantId_userId: { tenantId: platformTenant.id, userId: platformUser.id } },
    });
    if (!membership) {
      await prisma.tenantMembership.create({
        data: { tenantId: platformTenant.id, userId: platformUser.id, status: 'ACTIVE' },
      });
    }
  }

  // Ensure platform role assignment
  await prisma.platformUserRole.upsert({
    where: { userId_roleId: { userId: platformUser.id, roleId: platformRole.id } },
    update: {},
    create: { userId: platformUser.id, roleId: platformRole.id },
  });

  return { platformTenant, platformUser, platformRole };
}

async function main() {
  // Seed platform first (idempotent)
  await seedPlatformAdmin();

  // Get all existing business tenants (exclude platform)
  const tenants = await prisma.tenant.findMany({
    where: { status: { not: 'CANCELLED' }, slug: { not: PLATFORM_TENANT_SLUG } },
    select: { id: true, name: true, slug: true },
  });

  if (tenants.length === 0) {
    const tenant = await prisma.tenant.create({
      data: {
        name: 'Development',
        slug: 'development',
        status: 'ACTIVE',
        plan: 'free',
      },
    });
    await seedTenant(tenant.id);
  } else {
    for (const tenant of tenants) {
      await seedTenant(tenant.id);
    }
  }
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
