import { UserRepository } from './users.repository.js';
import { AppError } from '../../common/errors/app-error.js';
import { getPrismaClient } from '../../config/database.js';
import { auditService } from '../audit/audit.service.js';
import { getCacheService } from '../../common/cache/cache.service.js';
import { userPermissionsKey } from '../../common/cache/cache.keys.js';

const ALLOWED_UPDATE_FIELDS = ['firstName', 'lastName', 'status'];
const TENANT_ADMIN_ROLE = 'admin';

export class UserService {
  constructor() {
    this.repository = new UserRepository();
    this.prisma = getPrismaClient();
    this.cache = getCacheService();
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

  async update(id, tenantId, data, auditContext = {}) {
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

    if (Object.keys(updateData).length === 0) {
      // still return current user without audit
      const current = await this.repository.findById(id, tenantId);
      return this.toUserResponse(current);
    }

    const oldValue = {};
    for (const k of Object.keys(updateData)) oldValue[k] = user[k];

    const actorUserId = auditContext.actorUserId || null;
    const ipAddress = auditContext.ipAddress || null;
    const userAgent = auditContext.userAgent || null;

    const updatedUser = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id },
        data: updateData,
        select: {
          id: true, tenantId: true, email: true, firstName: true, lastName: true, status: true, emailVerified: true, lastLoginAt: true, createdAt: true, updatedAt: true,
        },
      });
      await auditService.logAudit({
        tenantId, userId: actorUserId, action: 'UPDATE', resource: 'user', resourceId: id,
        oldValue, newValue: updateData, ipAddress, userAgent, tx,
      });
      await auditService.logActivity({
        tenantId, userId: actorUserId, action: 'user.update',
        description: `User ${id} updated`,
        metadata: { resourceId: id, changes: Object.keys(updateData) },
        ipAddress, userAgent, tx,
      });
      return updated;
    });

    // fetch with roles for response
    const withRoles = await this.repository.findById(id, tenantId);
    return this.toUserResponse(withRoles || updatedUser);
  }

  async delete(id, tenantId, auditContext = {}) {
    const user = await this.repository.findByIdAndTenant(id, tenantId);
    if (!user) {
      throw new AppError('User not found', {
        statusCode: 404,
        code: 'USER_NOT_FOUND',
      });
    }

    const actorUserId = auditContext.actorUserId || null;
    const ipAddress = auditContext.ipAddress || null;
    const userAgent = auditContext.userAgent || null;
    const oldValue = { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, status: user.status };

    await this.prisma.$transaction(async (tx) => {
      await auditService.logAudit({
        tenantId, userId: actorUserId, action: 'DELETE', resource: 'user', resourceId: id,
        oldValue, newValue: null, ipAddress, userAgent, tx,
      });
      await auditService.logActivity({
        tenantId, userId: actorUserId, action: 'user.delete',
        description: `User ${id} deleted`,
        metadata: { resourceId: id, email: user.email },
        ipAddress, userAgent, tx,
      });
      await tx.user.delete({ where: { id } });
    });
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
    return userRoles.map((ur) => this.toUserRoleResponse(ur));
  }

  async assignRoles(userId, tenantId, roleIds) {
    const user = await this.repository.findByIdAndTenant(userId, tenantId);
    if (!user) {
      throw new AppError('User not found', {
        statusCode: 404,
        code: 'USER_NOT_FOUND',
      });
    }

    // IDs from another tenant look exactly like unknown IDs: reject the whole request rather than drop them
    const uniqueRoleIds = [...new Set(roleIds)];
    const roles = await this.repository.findRolesByIds(uniqueRoleIds, tenantId);
    if (roles.length !== uniqueRoleIds.length) {
      throw new AppError('One or more roles do not exist in this tenant', {
        statusCode: 400,
        code: 'INVALID_ROLE_IDS',
      });
    }

    const userRoles = await this.repository.assignRoles(userId, tenantId, uniqueRoleIds);
    await this.cache.del(userPermissionsKey(tenantId, userId));
    return userRoles.map((ur) => this.toUserRoleResponse(ur));
  }

  async removeRole(userId, tenantId, roleId) {
    const user = await this.repository.findByIdAndTenant(userId, tenantId);
    if (!user) {
      throw new AppError('User not found', {
        statusCode: 404,
        code: 'USER_NOT_FOUND',
      });
    }
    const role = await this.repository.findRoleById(roleId, tenantId);
    if (!role) {
      throw new AppError('Role not found', {
        statusCode: 404,
        code: 'ROLE_NOT_FOUND',
      });
    }

    // Never leave a tenant without anyone holding the admin role — nobody could manage roles again
    const { removed, lastHolder } = await this.repository.removeRole(userId, tenantId, roleId, {
      guardRoleName: TENANT_ADMIN_ROLE,
      roleName: role.name,
    });
    if (lastHolder) {
      throw new AppError('Cannot remove the admin role from the last admin of this tenant', {
        statusCode: 409,
        code: 'LAST_ADMIN_ROLE',
      });
    }
    if (removed === 0) {
      throw new AppError('Role is not assigned to this user', {
        statusCode: 404,
        code: 'ROLE_NOT_ASSIGNED',
      });
    }

    await this.cache.del(userPermissionsKey(tenantId, userId));
    const remaining = await this.repository.findUserRoles(userId, tenantId);
    return remaining.map((ur) => this.toUserRoleResponse(ur));
  }

  toUserRoleResponse(userRole) {
    return {
      id: userRole.role.id,
      name: userRole.role.name,
      description: userRole.role.description,
      isSystem: userRole.role.isSystem,
      permissions: userRole.role.rolePermissions.map((rp) => ({
        id: rp.permission.id,
        name: rp.permission.name,
        resource: rp.permission.resource,
        action: rp.permission.action,
        description: rp.permission.description,
      })),
      assignedAt: userRole.createdAt,
    };
  }

  async getOverview(tenantId) {
    return this.repository.getOverview(tenantId);
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