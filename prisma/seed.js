import { PrismaClient } from '@prisma/client';

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

async function seedTenant(tenantId) {
  // Upsert permissions
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

  // Upsert roles
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

  // Link roles to permissions
  // admin -> all permissions
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

  // manager -> most permissions (exclude delete for sensitive resources)
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

  // member -> read permissions only
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

async function main() {
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
  // Get all existing tenants
  const tenants = await prisma.tenant.findMany({
    where: { status: { not: 'CANCELLED' } },
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
