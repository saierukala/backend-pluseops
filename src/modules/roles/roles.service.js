import { RoleRepository } from './roles.repository.js';
import { AppError } from '../../common/errors/app-error.js';

export class RoleService {
  constructor() {
    this.repository = new RoleRepository();
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

  async assignPermissions(id, tenantId, permissionIds) {
    const role = await this.repository.findById(id, tenantId);
    if (!role) {
      throw new AppError('Role not found', {
        statusCode: 404,
        code: 'ROLE_NOT_FOUND',
      });
    }

    const isSystem = await this.repository.isSystemRole(id, tenantId);
    if (isSystem) {
      throw new AppError('Cannot modify system role permissions', {
        statusCode: 403,
        code: 'SYSTEM_ROLE_IMMUTABLE',
      });
    }

    const updated = await this.repository.assignPermissions(id, tenantId, permissionIds);
    return updated.map((rp) => ({
      id: rp.permission.id,
      name: rp.permission.name,
      resource: rp.permission.resource,
      action: rp.permission.action,
      description: rp.permission.description,
    }));
  }

  toRoleResponse(role) {
    return {
      id: role.id,
      tenantId: role.tenantId,
      name: role.name,
      description: role.description,
      isSystem: role.isSystem,
      permissions: role.rolePermissions?.map((rp) => ({
        id: rp.permission.id,
        name: rp.permission.name,
        resource: rp.permission.resource,
        action: rp.permission.action,
        description: rp.permission.description,
      })) ?? [],
      userCount: role._count?.userRoles ?? 0,
      createdAt: role.createdAt,
      updatedAt: role.updatedAt,
    };
  }
}