import { TenantRepository } from './tenants.repository.js';
import { AppError } from '../../common/errors/app-error.js';

export class TenantService {
  constructor() {
    this.repository = new TenantRepository();
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
    const tenant = await this.repository.findById(id);
    if (!tenant) {
      throw new AppError('Tenant not found', {
        statusCode: 404,
        code: 'TENANT_NOT_FOUND',
      });
    }
    return tenant;
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

    return this.repository.update(id, data);
  }

  async delete(id) {
    await this.getById(id);
    return this.repository.delete(id);
  }

  canPerformOperations(tenant) {
    return tenant.status === 'ACTIVE' || tenant.status === 'TRIAL';
  }
}