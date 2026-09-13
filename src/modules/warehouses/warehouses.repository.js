import { getPrismaClient } from '../../config/database.js';

export class WarehouseRepository {
  constructor() {
    this.prisma = getPrismaClient();
  }

  async create(data, tenantId) {
    return this.prisma.warehouse.create({
      data: {
        tenantId,
        name: data.name,
        code: data.code,
        address: data.address,
        city: data.city,
        state: data.state,
        country: data.country,
        postalCode: data.postalCode,
        isActive: data.isActive ?? true,
        isDefault: data.isDefault ?? false,
      },
    });
  }

  async findById(id, tenantId) {
    return this.prisma.warehouse.findFirst({
      where: { id, tenantId },
    });
  }

  async findByCode(code, tenantId) {
    return this.prisma.warehouse.findFirst({
      where: { code, tenantId },
    });
  }

  async list(tenantId, options = {}) {
    const { page = 1, limit = 20, search, isActive } = options;
    const skip = (page - 1) * limit;
    const take = Math.min(limit, 100);
    const where = { tenantId };
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { code: { contains: search, mode: 'insensitive' } },
        { city: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (isActive !== undefined) where.isActive = isActive;
    const [warehouses, total] = await Promise.all([
      this.prisma.warehouse.findMany({ where, orderBy: { createdAt: 'asc' }, skip, take }),
      this.prisma.warehouse.count({ where }),
    ]);
    return { data: warehouses, meta: { page, limit: take, total, totalPages: Math.ceil(total / take) } };
  }

  async update(id, tenantId, data) {
    return this.prisma.warehouse.update({
      where: { id },
      data: {
        name: data.name,
        address: data.address,
        city: data.city,
        state: data.state,
        country: data.country,
        postalCode: data.postalCode,
        isActive: data.isActive,
        isDefault: data.isDefault,
      },
    });
  }

  async delete(id) {
    return this.prisma.warehouse.delete({ where: { id } });
  }
}
