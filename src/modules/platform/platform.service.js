import { getPrismaClient } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import { hashPassword } from '../auth/password.util.js';
import { PlatformRepository } from './platform.repository.js';

const PLATFORM_TENANT_SLUG = '__platform';

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

export class PlatformService {
  constructor({ repository } = {}) {
    this.repository = repository ?? new PlatformRepository();
    this.prisma = getPrismaClient();
  }

  async listTenants(query) {
    const result = await this.repository.listTenants(query);
    return {
      data: result.data,
      meta: { page: result.page, limit: result.limit, total: result.total, totalPages: Math.ceil(result.total / result.limit) },
    };
  }

  async getTenantById(id) {
    if (!id) throw new AppError('Tenant ID required', { statusCode: 400, code: 'TENANT_REQUIRED' });
    const tenant = await this.repository.findTenantById(id);
    if (!tenant) throw new AppError('Tenant not found', { statusCode: 404, code: 'TENANT_NOT_FOUND' });
    if (tenant.slug === PLATFORM_TENANT_SLUG) throw new AppError('Platform tenant not accessible', { statusCode: 404, code: 'TENANT_NOT_FOUND' });
    return tenant;
  }

  async createTenantWithAdmin(data) {
    const { name, slug, status, plan, admin } = data;
    if (slug === PLATFORM_TENANT_SLUG) {
      throw new AppError('Reserved slug', { statusCode: 400, code: 'SLUG_RESERVED' });
    }
    const exists = await this.repository.existsBySlug(slug);
    if (exists) throw new AppError('Tenant with this slug already exists', { statusCode: 409, code: 'TENANT_SLUG_EXISTS' });

    // Check admin email global uniqueness
    const existingEmail = await this.prisma.user.findUnique({ where: { email: admin.email } });
    if (existingEmail) throw new AppError('User with this email already exists', { statusCode: 409, code: 'USER_ALREADY_EXISTS' });

    const passwordHash = await hashPassword(admin.password);

    const created = await this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          name,
          slug,
          status: status || 'TRIAL',
          plan: plan || 'free',
        },
      });

      // Seed permissions and roles for new tenant
      const permissions = {};
      for (const perm of SYSTEM_PERMISSIONS) {
        const p = await tx.permission.create({
          data: {
            tenantId: tenant.id,
            name: perm.name,
            resource: perm.resource,
            action: perm.action,
          },
        });
        permissions[`${perm.resource}:${perm.action}`] = p.id;
      }
      const roles = {};
      for (const role of SYSTEM_ROLES) {
        const r = await tx.role.create({
          data: { tenantId: tenant.id, name: role.name, description: role.description },
        });
        roles[role.name] = r.id;
      }
      // Admin -> all permissions
      for (const permId of Object.values(permissions)) {
        await tx.rolePermission.create({
          data: { tenantId: tenant.id, roleId: roles.admin, permissionId: permId },
        });
      }
      const managerExclude = ['user:delete', 'role:delete', 'permission:read', 'tenant:update'];
      const managerPerms = Object.entries(permissions).filter(([k]) => !managerExclude.includes(k)).map(([, v]) => v);
      for (const permId of managerPerms) {
        await tx.rolePermission.create({ data: { tenantId: tenant.id, roleId: roles.manager, permissionId: permId } });
      }
      const memberPerms = Object.entries(permissions).filter(([k]) => k.endsWith(':read')).map(([, v]) => v);
      for (const permId of memberPerms) {
        await tx.rolePermission.create({ data: { tenantId: tenant.id, roleId: roles.member, permissionId: permId } });
      }

      // Create admin user with membership and admin role assignment
      const user = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: admin.email,
          passwordHash,
          firstName: admin.firstName,
          lastName: admin.lastName,
          status: 'ACTIVE',
          emailVerified: true,
          memberships: { create: { tenantId: tenant.id, roleId: roles.admin, status: 'ACTIVE' } },
        },
      });
      await tx.userRole.create({
        data: { tenantId: tenant.id, userId: user.id, roleId: roles.admin },
      });

      const tenantWithRelations = await tx.tenant.findUnique({
        where: { id: tenant.id },
        include: { settings: true, domains: true },
      });

      return { tenant: tenantWithRelations, adminUser: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, tenantId: tenant.id } };
    });

    return created;
  }

  async createTenantOnly(data) {
    const { name, slug, status, plan } = data;
    if (slug === PLATFORM_TENANT_SLUG) throw new AppError('Reserved slug', { statusCode: 400, code: 'SLUG_RESERVED' });
    const exists = await this.repository.existsBySlug(slug);
    if (exists) throw new AppError('Tenant with this slug already exists', { statusCode: 409, code: 'TENANT_SLUG_EXISTS' });
    // Create tenant without admin; still seed roles/permissions atomically
    const tenant = await this.prisma.$transaction(async (tx) => {
      const t = await tx.tenant.create({ data: { name, slug, status: status || 'TRIAL', plan: plan || 'free' } });
      const permissions = {};
      for (const perm of SYSTEM_PERMISSIONS) {
        const p = await tx.permission.create({ data: { tenantId: t.id, name: perm.name, resource: perm.resource, action: perm.action } });
        permissions[`${perm.resource}:${perm.action}`] = p.id;
      }
      const roles = {};
      for (const role of SYSTEM_ROLES) {
        const r = await tx.role.create({ data: { tenantId: t.id, name: role.name, description: role.description } });
        roles[role.name] = r.id;
      }
      for (const permId of Object.values(permissions)) {
        await tx.rolePermission.create({ data: { tenantId: t.id, roleId: roles.admin, permissionId: permId } });
      }
      const managerExclude = ['user:delete', 'role:delete', 'permission:read', 'tenant:update'];
      const managerPerms = Object.entries(permissions).filter(([k]) => !managerExclude.includes(k)).map(([, v]) => v);
      for (const permId of managerPerms) await tx.rolePermission.create({ data: { tenantId: t.id, roleId: roles.manager, permissionId: permId } });
      const memberPerms = Object.entries(permissions).filter(([k]) => k.endsWith(':read')).map(([, v]) => v);
      for (const permId of memberPerms) await tx.rolePermission.create({ data: { tenantId: t.id, roleId: roles.member, permissionId: permId } });
      return tx.tenant.findUnique({ where: { id: t.id }, include: { settings: true, domains: true } });
    });
    return tenant;
  }

  async updateTenant(id, data) {
    const tenant = await this.getTenantById(id);
    if (data.slug && data.slug !== tenant.slug) {
      if (data.slug === PLATFORM_TENANT_SLUG) throw new AppError('Reserved slug', { statusCode: 400, code: 'SLUG_RESERVED' });
      const exists = await this.repository.existsBySlug(data.slug);
      if (exists) throw new AppError('Tenant with this slug already exists', { statusCode: 409, code: 'TENANT_SLUG_EXISTS' });
    }
    const updated = await this.prisma.tenant.update({
      where: { id },
      data: { name: data.name, slug: data.slug, status: data.status, plan: data.plan },
      include: { settings: true, domains: true },
    });
    return updated;
  }

  async updateTenantStatus(id, status) {
    const tenant = await this.getTenantById(id);
    if (tenant.slug === PLATFORM_TENANT_SLUG) throw new AppError('Cannot modify platform tenant', { statusCode: 403, code: 'PLATFORM_TENANT_FORBIDDEN' });
    const updated = await this.prisma.tenant.update({ where: { id }, data: { status }, include: { settings: true, domains: true } });
    return updated;
  }

  async createTenantAdmin(tenantId, adminData) {
    const tenant = await this.getTenantById(tenantId);
    const existing = await this.prisma.user.findUnique({ where: { email: adminData.email } });
    if (existing) throw new AppError('User with this email already exists', { statusCode: 409, code: 'USER_ALREADY_EXISTS' });

    // Find admin role for this tenant
    const adminRole = await this.prisma.role.findUnique({ where: { tenantId_name: { tenantId: tenant.id, name: 'admin' } } });
    if (!adminRole) throw new AppError('Admin role not found for tenant', { statusCode: 500, code: 'ROLE_NOT_FOUND' });

    const passwordHash = await hashPassword(adminData.password);
    const user = await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: adminData.email,
          passwordHash,
          firstName: adminData.firstName,
          lastName: adminData.lastName,
          status: 'ACTIVE',
          emailVerified: true,
          memberships: { create: { tenantId: tenant.id, roleId: adminRole.id, status: 'ACTIVE' } },
        },
      });
      await tx.userRole.create({ data: { tenantId: tenant.id, userId: u.id, roleId: adminRole.id } });
      return u;
    });

    return { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, tenantId: tenant.id };
  }
}
