import { UserRepository } from './users.repository.js';
import { AppError } from '../../common/errors/app-error.js';

export class UserService {
  constructor() {
    this.repository = new UserRepository();
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

    // Validate that all roles exist and belong to the tenant
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
}