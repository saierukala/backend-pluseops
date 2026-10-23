import { RoleRepository } from './roles.repository.js';
import { AppError } from '../../common/errors/app-error.js';
import { invalidateTenantPermissionsCache } from '../auth/authorization.middleware.js';

export class RoleService {
  constructor() {
    this.repository = new RoleRepository();
  }

  // A role change affects every holder of the role, so drop all cached user permissions for the tenant
  async invalidateUserPermissions(tenantId) {
    await invalidateTenantPermissionsCache(tenantId);
  }

  async list(tenantId, { page = 1, limit = 50 } = {}) {
    const skip = (page - 1) * limit;
    const take = Math.min(limit, 100);

    const [roles, total] = await Promise.all([
      this.repository.findMany(tenantId, { skip, take }),
      this.repository.count(tenantId),
    ]);

    return {
      data: roles.map((role) => this.toRoleResponse(role)),
      meta: {
        page,
        limit: take,
        total,
        totalPages: Math.ceil(total / take),
      },
    };
  }

  async getById(id, tenantId) {
    const role = await this.repository.findById(id, tenantId);
    if (!role) {
      throw new AppError('Role not found', {
        statusCode: 404,
        code: 'ROLE_NOT_FOUND',
      });
    }
    return this.toRoleResponse(role);
  }

  async create(tenantId, data) {
    const existing = await this.repository.findByName(data.name, tenantId);
    if (existing) {
      throw new AppError('Role with this name already exists', {
        statusCode: 409,
        code: 'ROLE_NAME_EXISTS',
      });
    }

    const role = await this.repository.create({ tenantId, ...data });
    return this.toRoleResponse(role);
  }

  async update(id, tenantId, data) {
    const isSystem = await this.repository.isSystemRole(id, tenantId);
    if (isSystem) {
      throw new AppError('Cannot modify system role', {
        statusCode: 403,
        code: 'SYSTEM_ROLE_IMMUTABLE',
      });
    }

    if (data.name) {
      const existing = await this.repository.findByName(data.name, tenantId);
      if (existing && existing.id !== id) {
        throw new AppError('Role with this name already exists', {
          statusCode: 409,
          code: 'ROLE_NAME_EXISTS',
        });
      }
    }

    try {
      const role = await this.repository.update(id, tenantId, data);
      if (!role) {
        throw new AppError('Role not found', {
          statusCode: 404,
          code: 'ROLE_NOT_FOUND',
        });
      }
      return this.toRoleResponse(role);
    } catch (error) {
      if (error.code === 'P2025') {
        throw new AppError('Role not found', {
          statusCode: 404,
          code: 'ROLE_NOT_FOUND',
        });
      }
      throw error;
    }
  }

  async delete(id, tenantId) {
    const isSystem = await this.repository.isSystemRole(id, tenantId);
    if (isSystem) {
      throw new AppError('Cannot delete system role', {
        statusCode: 403,
        code: 'SYSTEM_ROLE_IMMUTABLE',
      });
    }

    const role = await this.repository.findById(id, tenantId);
    if (!role) {
      throw new AppError('Role not found', {
        statusCode: 404,
        code: 'ROLE_NOT_FOUND',
      });
    }

    try {
      await this.repository.delete(id, tenantId);
      await this.invalidateUserPermissions(tenantId);
      return { success: true, message: 'Role deleted successfully' };
    } catch (error) {
      if (error.code === 'P2025') {
        throw new AppError('Role not found', {
          statusCode: 404,
          code: 'ROLE_NOT_FOUND',
        });
      }
      throw error;
    }
  }

  // Role whose permission set may change: must exist in the tenant and not be a system role
  async getMutableRole(id, tenantId) {
    const role = await this.repository.findById(id, tenantId);
    if (!role) {
      throw new AppError('Role not found', {
        statusCode: 404,
        code: 'ROLE_NOT_FOUND',
      });
    }
    if (role.isSystem) {
      throw new AppError('Cannot modify system role permissions', {
        statusCode: 403,
        code: 'SYSTEM_ROLE_IMMUTABLE',
      });
    }
    return role;
  }

  // IDs from another tenant look exactly like unknown IDs: reject the whole request rather than drop them
  async assertTenantPermissions(permissionIds, tenantId) {
    const found = await this.repository.findPermissionsByIds(permissionIds, tenantId);
    if (found.length !== new Set(permissionIds).size) {
      throw new AppError('One or more permissions do not exist in this tenant', {
        statusCode: 400,
        code: 'INVALID_PERMISSION_IDS',
      });
    }
  }

  async assignPermissions(id, tenantId, permissionIds) {
    await this.getMutableRole(id, tenantId);
    await this.assertTenantPermissions(permissionIds, tenantId);

    const updated = await this.repository.assignPermissions(id, tenantId, permissionIds);
    await this.invalidateUserPermissions(tenantId);
    return updated.map((rp) => this.toPermissionResponse(rp.permission));
  }

  async replacePermissions(id, tenantId, permissionIds) {
    await this.getMutableRole(id, tenantId);
    const uniqueIds = [...new Set(permissionIds)];
    await this.assertTenantPermissions(uniqueIds, tenantId);

    const updated = await this.repository.replacePermissions(id, tenantId, uniqueIds);
    await this.invalidateUserPermissions(tenantId);
    return updated.map((rp) => this.toPermissionResponse(rp.permission));
  }

  async removePermission(id, tenantId, permissionId) {
    const role = await this.getMutableRole(id, tenantId);
    if (!role.rolePermissions.some((rp) => rp.permissionId === permissionId)) {
      throw new AppError('Permission is not assigned to this role', {
        statusCode: 404,
        code: 'PERMISSION_NOT_ASSIGNED',
      });
    }

    await this.repository.removePermission(id, tenantId, permissionId);
    await this.invalidateUserPermissions(tenantId);
    return role.rolePermissions
      .filter((rp) => rp.permissionId !== permissionId)
      .map((rp) => this.toPermissionResponse(rp.permission));
  }

  toPermissionResponse(permission) {
    return {
      id: permission.id,
      name: permission.name,
      resource: permission.resource,
      action: permission.action,
      description: permission.description,
    };
  }

  toRoleResponse(role) {
    return {
      id: role.id,
      tenantId: role.tenantId,
      name: role.name,
      description: role.description,
      isSystem: role.isSystem,
      permissions: role.rolePermissions?.map((rp) => this.toPermissionResponse(rp.permission)) ?? [],
      userCount: role._count?.userRoles ?? 0,
      createdAt: role.createdAt,
      updatedAt: role.updatedAt,
    };
  }
}