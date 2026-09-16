import { TenantRepository } from './tenants.repository.js';
import { AppError } from '../../common/errors/app-error.js';
import { getCacheService } from '../../common/cache/cache.service.js';
import { tenantKey, tenantSettingsKey } from '../../common/cache/cache.keys.js';
import { CACHE_TTL } from '../../common/cache/cache.config.js';
import { logger } from '../../config/logger.js';

export class TenantService {
  constructor({ repository, cacheService } = {}) {
    this.repository = repository ?? new TenantRepository();
    this.cache = cacheService ?? getCacheService();
  }

  async create(data) {
    const existingSlug = await this.repository.existsBySlug(data.slug);
    if (existingSlug) {
      throw new AppError('Tenant with this slug already exists', {
        statusCode: 409,
        code: 'TENANT_SLUG_EXISTS',
      });
    }

    return this.repository.create(data);
  }

  async getById(id) {
    const cacheKey = tenantKey(id);
    try {
      const cached = await this.cache.get(cacheKey);
      if (cached) return cached;
    } catch (error) {
      logger.warn({ err: error, key: cacheKey }, 'Tenant cache GET failed');
    }

    const tenant = await this.repository.findById(id);
    if (!tenant) {
      throw new AppError('Tenant not found', {
        statusCode: 404,
        code: 'TENANT_NOT_FOUND',
      });
    }

    try {
      await this.cache.set(cacheKey, tenant, CACHE_TTL.TENANT);
      if (tenant.settings) {
        await this.cache.set(tenantSettingsKey(id), tenant.settings, CACHE_TTL.TENANT_SETTINGS);
      }
    } catch (error) {
      logger.warn({ err: error, key: cacheKey }, 'Tenant cache SET failed');
    }

    return tenant;
  }

  async getSettings(tenantId) {
    const cacheKey = tenantSettingsKey(tenantId);
    try {
      const cached = await this.cache.get(cacheKey);
      if (cached) return cached;
    } catch (error) {
      logger.warn({ err: error, key: cacheKey }, 'Tenant settings cache GET failed');
    }

    const tenant = await this.repository.findById(tenantId);
    if (!tenant) {
      throw new AppError('Tenant not found', {
        statusCode: 404,
        code: 'TENANT_NOT_FOUND',
      });
    }
    const settings = tenant.settings ?? null;
    try {
      if (settings) await this.cache.set(cacheKey, settings, CACHE_TTL.TENANT_SETTINGS);
    } catch (error) {
      logger.warn({ err: error, key: cacheKey }, 'Tenant settings cache SET failed');
    }
    return settings;
  }

  async update(id, data) {
    await this.getById(id);

    if (data.slug) {
      const existingSlug = await this.repository.existsBySlug(data.slug);
      if (existingSlug) {
        throw new AppError('Tenant with this slug already exists', {
          statusCode: 409,
          code: 'TENANT_SLUG_EXISTS',
        });
      }
    }

    const updated = await this.repository.update(id, data);
    try {
      await this.cache.del(tenantKey(id));
      await this.cache.del(tenantSettingsKey(id));
    } catch (error) {
      logger.warn({ err: error, tenantId: id }, 'Tenant cache invalidation failed');
    }
    return updated;
  }

  async delete(id) {
    await this.getById(id);
    const result = await this.repository.delete(id);
    try {
      await this.cache.del(tenantKey(id));
      await this.cache.del(tenantSettingsKey(id));
    } catch (error) {
      logger.warn({ err: error, tenantId: id }, 'Tenant cache invalidation failed');
    }
    return result;
  }

  canPerformOperations(tenant) {
    return tenant.status === 'ACTIVE' || tenant.status === 'TRIAL';
  }
}