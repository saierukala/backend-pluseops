import { WarehouseRepository } from './warehouses.repository.js';
import { AppError } from '../../common/errors/app-error.js';

export class WarehouseService {
  constructor() {
    this.repository = new WarehouseRepository();
  }

  async create(tenantId, data) {
    const existing = await this.repository.findByCode(data.code, tenantId);
    if (existing) {
      throw new AppError('Warehouse code already exists', { statusCode: 409, code: 'WAREHOUSE_CODE_EXISTS' });
    }
    return this.repository.create(data, tenantId);
  }

  async getById(id, tenantId) {
    const warehouse = await this.repository.findById(id, tenantId);
    if (!warehouse) throw new AppError('Warehouse not found', { statusCode: 404, code: 'WAREHOUSE_NOT_FOUND' });
    return warehouse;
  }

  async list(tenantId, options) {
    return this.repository.list(tenantId, options);
  }

  async update(id, tenantId, data) {
    await this.getById(id, tenantId);
    return this.repository.update(id, tenantId, data);
  }

  async delete(id, tenantId) {
    await this.getById(id, tenantId);
    return this.repository.delete(id);
  }
}
