import { PermissionRepository } from './permissions.repository.js';
import { AppError } from '../../common/errors/app-error.js';
import { getCacheService } from '../../common/cache/cache.service.js';
import { permissionsListKey } from '../../common/cache/cache.keys.js';
import { CACHE_TTL } from '../../common/cache/cache.config.js';
import { logger } from '../../config/logger.js';

export class PermissionService {
  constructor({ repository, cacheService } = {}) {
    this.repository = repository ?? new PermissionRepository();
    this.cache = cacheService ?? getCacheService();
  }

  async list(tenantId) {
    const cacheKey = permissionsListKey(tenantId);
    try {
      const cached = await this.cache.get(cacheKey);
      if (cached) return cached;
    } catch (error) {
      logger.warn({ err: error, key: cacheKey }, 'Permissions cache GET failed');
    }

    const permissions = await this.repository.findMany(tenantId);
    const result = permissions.map((p) => this.toPermissionResponse(p));

    try {
      await this.cache.set(cacheKey, result, CACHE_TTL.PERMISSIONS);
    } catch (error) {
      logger.warn({ err: error, key: cacheKey }, 'Permissions cache SET failed');
    }

    return result;
  }

  async invalidateTenantPermissions(tenantId) {
    try {
      await this.cache.del(permissionsListKey(tenantId));
    } catch (error) {
      logger.warn({ err: error, tenantId }, 'Permissions cache invalidation failed');
    }
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