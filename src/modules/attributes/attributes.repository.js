import { getPrismaClient } from '../../config/database.js';

export class AttributeRepository {
  constructor() {
    this.prisma = getPrismaClient();
  }

  async create(data, tenantId) {
    return this.prisma.attributeDefinition.create({
      data: {
        tenantId,
        name: data.name,
        code: data.code,
        dataType: data.dataType,
        isRequired: data.isRequired ?? false,
        description: data.description,
      },
    });
  }

  async findById(id, tenantId) {
    return this.prisma.attributeDefinition.findFirst({
      where: { id, tenantId },
      include: {
        values: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } },
        _count: { select: { variantAttributes: true } },
      },
    });
  }

  async findByCode(code, tenantId) {
    return this.prisma.attributeDefinition.findFirst({
      where: { code, tenantId },
    });
  }

  async list(tenantId, options = {}) {
    const {
      page = 1,
      limit = 20,
      search,
      dataType,
      sortBy = 'name',
      sortOrder = 'asc',
    } = options;

    const skip = (page - 1) * limit;
    const take = Math.min(limit, 100);

    const where = { tenantId };

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { code: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (dataType) {
      where.dataType = dataType;
    }

    const allowedSortFields = ['name', 'code', 'dataType', 'isRequired', 'createdAt', 'updatedAt'];
    const allowedSortOrders = ['asc', 'desc'];
    const safeSortBy = allowedSortFields.includes(sortBy) ? sortBy : 'name';
    const safeSortOrder = allowedSortOrders.includes(sortOrder.toLowerCase()) ? sortOrder.toLowerCase() : 'asc';

    const [definitions, total] = await Promise.all([
      this.prisma.attributeDefinition.findMany({
        where,
        include: {
          values: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } },
          _count: { select: { variantAttributes: true } },
        },
        orderBy: { [safeSortBy]: safeSortOrder },
        skip,
        take,
      }),
      this.prisma.attributeDefinition.count({ where }),
    ]);

    return {
      data: definitions,
      meta: {
        page,
        limit: take,
        total,
        totalPages: Math.ceil(total / take),
      },
    };
  }

  async update(id, tenantId, data) {
    return this.prisma.attributeDefinition.update({
      where: { id },
      data: {
        name: data.name,
        code: data.code,
        dataType: data.dataType,
        isRequired: data.isRequired,
        description: data.description,
      },
    });
  }

  async delete(id, _tenantId) {
    return this.prisma.attributeDefinition.delete({
      where: { id },
    });
  }

  async existsByCode(code, tenantId, excludeId = null) {
    const where = { code, tenantId };
    if (excludeId) {
      where.id = { not: excludeId };
    }
    const attr = await this.prisma.attributeDefinition.findFirst({ where, select: { id: true } });
    return !!attr;
  }

  async createValue(data, tenantId, attributeDefinitionId) {
    return this.prisma.attributeValue.create({
      data: {
        tenantId,
        attributeDefinitionId,
        value: data.value,
        displayName: data.displayName,
        sortOrder: data.sortOrder ?? 0,
        isActive: data.isActive ?? true,
      },
    });
  }

  async findValueById(id, tenantId) {
    return this.prisma.attributeValue.findFirst({
      where: { id, tenantId },
    });
  }

  async listValues(attributeDefinitionId, tenantId, options = {}) {
    const { page = 1, limit = 50 } = options;
    const skip = (page - 1) * limit;
    const take = Math.min(limit, 100);

    const where = { attributeDefinitionId, tenantId };

    const [values, total] = await Promise.all([
      this.prisma.attributeValue.findMany({
        where,
        orderBy: { sortOrder: 'asc' },
        skip,
        take,
      }),
      this.prisma.attributeValue.count({ where }),
    ]);

    return {
      data: values,
      meta: { page, limit: take, total, totalPages: Math.ceil(total / take) },
    };
  }

  async updateValue(id, _tenantId, data) {
    return this.prisma.attributeValue.update({
      where: { id },
      data: {
        value: data.value,
        displayName: data.displayName,
        sortOrder: data.sortOrder,
        isActive: data.isActive,
      },
    });
  }

  async deleteValue(id, _tenantId) {
    return this.prisma.attributeValue.delete({
      where: { id },
    });
  }

  async existsValue(value, attributeDefinitionId, tenantId, excludeId = null) {
    const where = { value, attributeDefinitionId, tenantId };
    if (excludeId) {
      where.id = { not: excludeId };
    }
    const attr = await this.prisma.attributeValue.findFirst({ where, select: { id: true } });
    return !!attr;
  }
}