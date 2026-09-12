import { PermissionRepository } from './permissions.repository.js';
import { AppError } from '../../common/errors/app-error.js';

export class PermissionService {
  constructor() {
    this.repository = new PermissionRepository();
  }

  async list(tenantId) {
    const permissions = await this.repository.findMany(tenantId);
    return permissions.map((p) => this.toPermissionResponse(p));
  }

  async getById(id, tenantId) {
    const permission = await this.repository.findById(id, tenantId);
    if (!permission) {
      throw new AppError('Permission not found', {
        statusCode: 404,
        code: 'PERMISSION_NOT_FOUND',
      });
    }
    return this.toPermissionResponse(permission);
  }

  toPermissionResponse(permission) {
    return {
      id: permission.id,
      tenantId: permission.tenantId,
      name: permission.name,
      resource: permission.resource,
      action: permission.action,
      description: permission.description,
      createdAt: permission.createdAt,
      updatedAt: permission.updatedAt,
    };
  }
}