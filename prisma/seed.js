import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';

const prisma = new PrismaClient();

const SYSTEM_PERMISSIONS = [
  { resource: 'tenant', action: 'read', name: 'tenant:read' },
  { resource: 'tenant', action: 'update', name: 'tenant:update' },
  { resource: 'user', action: 'create', name: 'user:create' },
  { resource: 'user', action: 'read', name: 'user:read' },
  { resource: 'user', action: 'update', name: 'user:update' },
  { resource: 'user', action: 'delete', name: 'user:delete' },
  { resource: 'role', action: 'create', name: 'role:create' },
  { resource: 'role', action: 'read', name: 'role:read' },
  { resource: 'role', action: 'update', name: 'role:update' },
  { resource: 'role', action: 'delete', name: 'role:delete' },
  { resource: 'permission', action: 'read', name: 'permission:read' },
  { resource: 'product', action: 'create', name: 'product:create' },
  { resource: 'product', action: 'read', name: 'product:read' },
  { resource: 'product', action: 'update', name: 'product:update' },
  { resource: 'product', action: 'delete', name: 'product:delete' },
  { resource: 'category', action: 'create', name: 'category:create' },
  { resource: 'category', action: 'read', name: 'category:read' },
  { resource: 'category', action: 'update', name: 'category:update' },
  { resource: 'category', action: 'delete', name: 'category:delete' },
  { resource: 'order', action: 'create', name: 'order:create' },
  { resource: 'order', action: 'read', name: 'order:read' },
  { resource: 'order', action: 'update', name: 'order:update' },
  { resource: 'order', action: 'cancel', name: 'order:cancel' },
  { resource: 'customer', action: 'create', name: 'customer:create' },
  { resource: 'customer', action: 'read', name: 'customer:read' },
  { resource: 'customer', action: 'update', name: 'customer:update' },
  { resource: 'customer', action: 'delete', name: 'customer:delete' },
  { resource: 'warehouse', action: 'create', name: 'warehouse:create' },
  { resource: 'warehouse', action: 'read', name: 'warehouse:read' },
  { resource: 'warehouse', action: 'update', name: 'warehouse:update' },
  { resource: 'warehouse', action: 'delete', name: 'warehouse:delete' },
  { resource: 'inventory', action: 'read', name: 'inventory:read' },
  { resource: 'inventory', action: 'update', name: 'inventory:update' },
  { resource: 'payment', action: 'create', name: 'payment:create' },
  { resource: 'payment', action: 'read', name: 'payment:read' },
  { resource: 'payment', action: 'confirm', name: 'payment:confirm' },
  { resource: 'payment', action: 'refund', name: 'payment:refund' },
  { resource: 'audit', action: 'read', name: 'audit:read' },
  { resource: 'activity', action: 'read', name: 'activity:read' },
  { resource: 'notification', action: 'read', name: 'notification:read' },
  { resource: 'notification', action: 'update', name: 'notification:update' },
];

const SYSTEM_ROLES = [
  { name: 'admin', description: 'Full administrative access' },
  { name: 'manager', description: 'Management access to most resources' },
  { name: 'member', description: 'Standard member access' },
];

const PLATFORM_PERMISSIONS = [
  { resource: 'platform:tenant', action: 'create', name: 'platform:tenant:create' },
  { resource: 'platform:tenant', action: 'read', name: 'platform:tenant:read' },
  { resource: 'platform:tenant', action: 'update', name: 'platform:tenant:update' },
  { resource: 'platform:tenant', action: 'suspend', name: 'platform:tenant:suspend' },
  { resource: 'platform:billing', action: 'read', name: 'platform:billing:read' },
  { resource: 'platform:billing', action: 'update', name: 'platform:billing:update' },
];

const PLATFORM_TENANT_SLUG = '__platform';
const PLATFORM_ADMIN_EMAIL = process.env.PLATFORM_ADMIN_EMAIL || 'sairram@gmail.com';
const PLATFORM_ADMIN_PASSWORD = process.env.PLATFORM_ADMIN_PASSWORD || 'Sairram@123';

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
      update: { description: role.description },
      create: {
        tenantId,
        name: role.name,
        description: role.description,
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

  const managerExclude = ['user:delete', 'role:delete', 'permission:read', 'tenant:update'];
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
