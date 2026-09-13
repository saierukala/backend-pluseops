import { AttributeRepository } from './attributes.repository.js';
import { AppError } from '../../common/errors/app-error.js';

export class AttributeService {
  constructor() {
    this.repository = new AttributeRepository();
  }

  async create(tenantId, data) {
    const existingCode = await this.repository.existsByCode(data.code, tenantId);
    if (existingCode) {
      throw new AppError('Attribute with this code already exists', {
        statusCode: 409,
        code: 'ATTRIBUTE_CODE_EXISTS',
      });
    }

    return this.repository.create(data, tenantId);
  }

  async getById(id, tenantId) {
    const attr = await this.repository.findById(id, tenantId);
    if (!attr) {
      throw new AppError('Attribute not found', {
        statusCode: 404,
        code: 'ATTRIBUTE_NOT_FOUND',
      });
    }
    return attr;
  }

  async list(tenantId, options = {}) {
    return this.repository.list(tenantId, options);
  }

  async update(id, tenantId, data) {
    await this.getById(id, tenantId);

    if (data.code) {
      const existingCode = await this.repository.existsByCode(data.code, tenantId, id);
      if (existingCode) {
        throw new AppError('Attribute with this code already exists', {
          statusCode: 409,
          code: 'ATTRIBUTE_CODE_EXISTS',
        });
      }
    }

    if (data.dataType) {
      const current = await this.getById(id, tenantId);
      if (current.dataType !== data.dataType && current._count.variantAttributes > 0) {
        throw new AppError('Cannot change data type of attribute that is in use by variants', {
          statusCode: 400,
          code: 'ATTRIBUTE_IN_USE',
        });
      }
    }

    return this.repository.update(id, tenantId, data);
  }

  async delete(id, tenantId) {
    const attr = await this.getById(id, tenantId);

    if (attr._count.variantAttributes > 0) {
      throw new AppError('Cannot delete attribute that is in use by variants', {
        statusCode: 400,
        code: 'ATTRIBUTE_IN_USE',
      });
    }

    return this.repository.delete(id, tenantId);
  }

  async createValue(tenantId, attributeDefinitionId, data) {
    await this.getById(attributeDefinitionId, tenantId);

    const existingValue = await this.repository.existsValue(data.value, attributeDefinitionId, tenantId);
    if (existingValue) {
      throw new AppError('Attribute value already exists', {
        statusCode: 409,
        code: 'ATTRIBUTE_VALUE_EXISTS',
      });
    }

    return this.repository.createValue(data, tenantId, attributeDefinitionId);
  }

  async getValueById(id, tenantId) {
    const value = await this.repository.findValueById(id, tenantId);
    if (!value) {
      throw new AppError('Attribute value not found', {
        statusCode: 404,
        code: 'ATTRIBUTE_VALUE_NOT_FOUND',
      });
    }
    return value;
  }

  async listValues(attributeDefinitionId, tenantId, options = {}) {
    await this.getById(attributeDefinitionId, tenantId);
    return this.repository.listValues(attributeDefinitionId, tenantId, options);
  }

  async updateValue(id, tenantId, data) {
    const value = await this.getValueById(id, tenantId);

    if (data.value && data.value !== value.value) {
      const existingValue = await this.repository.existsValue(data.value, value.attributeDefinitionId, tenantId, id);
      if (existingValue) {
        throw new AppError('Attribute value already exists', {
          statusCode: 409,
          code: 'ATTRIBUTE_VALUE_EXISTS',
        });
      }
    }

    return this.repository.updateValue(id, tenantId, data);
  }

  async deleteValue(id, tenantId) {
    await this.getValueById(id, tenantId);
    return this.repository.deleteValue(id, tenantId);
  }
}