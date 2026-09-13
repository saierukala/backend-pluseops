import { UserRepository } from './users.repository.js';
import { AppError } from '../../common/errors/app-error.js';

const ALLOWED_UPDATE_FIELDS = ['firstName', 'lastName', 'status'];

export class UserService {
  constructor() {
    this.repository = new UserRepository();
  }

  async list(tenantId, options = {}) {
    const result = await this.repository.list(tenantId, options);
    return {
      data: result.data.map((user) => this.toUserResponse(user)),
      meta: result.meta,
    };
  }

  async getById(id, tenantId) {
    const user = await this.repository.findById(id, tenantId);
    if (!user) {
      throw new AppError('User not found', {
        statusCode: 404,
        code: 'USER_NOT_FOUND',
      });
    }
    return this.toUserResponse(user);
  }

  async update(id, tenantId, data) {
    const user = await this.repository.findByIdAndTenant(id, tenantId);
    if (!user) {
      throw new AppError('User not found', {
        statusCode: 404,
        code: 'USER_NOT_FOUND',
      });
    }

    // Filter only allowed fields
    const updateData = {};
    for (const field of ALLOWED_UPDATE_FIELDS) {
      if (data[field] !== undefined) {
        updateData[field] = data[field];
      }
    }

    // Validate status if provided
    if (updateData.status !== undefined) {
      const validStatuses = ['ACTIVE', 'INACTIVE', 'SUSPENDED'];
      if (!validStatuses.includes(updateData.status)) {
        throw new AppError('Invalid status value', {
          statusCode: 400,
          code: 'INVALID_STATUS',
        });
      }
    }

    // Prevent email change through this endpoint
    if (data.email !== undefined) {
      throw new AppError('Email cannot be modified through this endpoint', {
        statusCode: 400,
        code: 'EMAIL_MODIFICATION_FORBIDDEN',
      });
    }

    // Prevent password hash change
    if (data.passwordHash !== undefined) {
      throw new AppError('Password cannot be modified through this endpoint', {
        statusCode: 400,
        code: 'PASSWORD_MODIFICATION_FORBIDDEN',
      });
    }

    // Prevent tenant change
    if (data.tenantId !== undefined) {
      throw new AppError('Tenant cannot be modified', {
        statusCode: 400,
        code: 'TENANT_MODIFICATION_FORBIDDEN',
      });
    }

    const updatedUser = await this.repository.update(id, tenantId, updateData);
    return this.toUserResponse(updatedUser);
  }

  async delete(id, tenantId) {
    const user = await this.repository.findByIdAndTenant(id, tenantId);
    if (!user) {
      throw new AppError('User not found', {
        statusCode: 404,
        code: 'USER_NOT_FOUND',
      });
    }

    // Prevent self-deletion (optional, but good practice)
    // This check would need the current user ID from context
    // We'll handle this in the controller if needed

    await this.repository.delete(id, tenantId);
    return { success: true, message: 'User deleted successfully' };
  }

  async getUserRoles(userId, tenantId) {
    const user = await this.repository.findByIdAndTenant(userId, tenantId);
    if (!user) {
      throw new AppError('User not found', {
        statusCode: 404,
        code: 'USER_NOT_FOUND',
      });
    }

    const userRoles = await this.repository.findUserRoles(userId, tenantId);
    return userRoles.map((ur) => ({
      id: ur.role.id,
      name: ur.role.name,
      description: ur.role.description,
      isSystem: ur.role.isSystem,
      permissions: ur.role.rolePermissions.map((rp) => ({
        id: rp.permission.id,
        name: rp.permission.name,
        resource: rp.permission.resource,
        action: rp.permission.action,
        description: rp.permission.description,
      })),
      assignedAt: ur.createdAt,
    }));
  }

  async assignRoles(userId, tenantId, roleIds) {
    const user = await this.repository.findByIdAndTenant(userId, tenantId);
    if (!user) {
      throw new AppError('User not found', {
        statusCode: 404,
        code: 'USER_NOT_FOUND',
      });
    }

    const roles = await this.repository.findRolesByIds(roleIds, tenantId);
    const validRoleIds = new Set(roles.map((r) => r.id));
    const validRoleIdsList = roleIds.filter((id) => validRoleIds.has(id));

    const userRoles = await this.repository.assignRoles(userId, tenantId, validRoleIdsList);
    return userRoles.map((ur) => ({
      id: ur.role.id,
      name: ur.role.name,
      description: ur.role.description,
      isSystem: ur.role.isSystem,
      permissions: ur.role.rolePermissions.map((rp) => ({
        id: rp.permission.id,
        name: rp.permission.name,
        resource: rp.permission.resource,
        action: rp.permission.action,
        description: rp.permission.description,
      })),
      assignedAt: ur.createdAt,
    }));
  }

  toUserResponse(user) {
    return {
      id: user.id,
      tenantId: user.tenantId,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      status: user.status,
      emailVerified: user.emailVerified,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      roles: user.userRoles?.map((ur) => ({
        id: ur.role.id,
        name: ur.role.name,
        isSystem: ur.role.isSystem,
      })) ?? [],
    };
  }
}