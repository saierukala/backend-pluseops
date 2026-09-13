import { getPrismaClient } from '../../config/database.js';

export class OrderRepository {
  constructor() {
    this.prisma = getPrismaClient();
  }

  async findById(id, tenantId, tx = this.prisma) {
    return tx.order.findFirst({
      where: { id, tenantId },
      include: {
        customer: true,
        items: {
          include: {
            productVariant: {
              select: { id: true, sku: true, price: true, product: { select: { id: true, name: true } } },
            },
          },
        },
        statusHistory: { orderBy: { createdAt: 'asc' } },
      },
    });
  }

  async list(tenantId, options = {}) {
    const { page = 1, limit = 20, status, customerId, sortBy = 'createdAt', sortOrder = 'desc' } = options;
    const skip = (page - 1) * limit;
    const take = Math.min(limit, 100);
    const where = { tenantId };
    if (status) where.status = status;
    if (customerId) where.customerId = customerId;
    const allowedSort = ['createdAt', 'updatedAt', 'total', 'status'];
    const safeSort = allowedSort.includes(sortBy) ? sortBy : 'createdAt';
    const safeOrder = ['asc', 'desc'].includes(sortOrder) ? sortOrder : 'desc';
    const [data, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: {
          customer: { select: { id: true, email: true, firstName: true, lastName: true } },
          items: true,
          statusHistory: { orderBy: { createdAt: 'asc' }, take: 1 },
        },
        orderBy: { [safeSort]: safeOrder },
        skip,
        take,
      }),
      this.prisma.order.count({ where }),
    ]);
    return { data, meta: { page, limit: take, total, totalPages: Math.ceil(total / take) } };
  }

  async getHistory(orderId, tenantId, options = {}) {
    const { page = 1, limit = 20 } = options;
    const skip = (page - 1) * limit;
    const take = Math.min(limit, 100);
    const where = { orderId, tenantId };
    const [data, total] = await Promise.all([
      this.prisma.orderStatusHistory.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip,
        take,
      }),
      this.prisma.orderStatusHistory.count({ where }),
    ]);
    return { data, meta: { page, limit: take, total, totalPages: Math.ceil(total / take) } };
  }
}
