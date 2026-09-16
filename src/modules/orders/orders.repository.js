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
          items: {
            select: {
              id: true,
              productVariantId: true,
              productNameSnapshot: true,
              variantNameSnapshot: true,
              skuSnapshot: true,
              unitPrice: true,
              quantity: true,
              discount: true,
              tax: true,
              lineTotal: true,
            },
          },
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

  async getOverview(tenantId) {
    const [totalOrders, statusGroups, recentOrders, revenueAgg] = await Promise.all([
      this.prisma.order.count({ where: { tenantId } }),
      this.prisma.order.groupBy({ by: ['status'], where: { tenantId }, _count: { status: true } }),
      this.prisma.order.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { id: true, status: true, total: true, currency: true, customerId: true, createdAt: true },
      }),
      this.prisma.order.aggregate({ where: { tenantId }, _sum: { total: true } }),
    ]);
    const byStatus = {};
    for (const g of statusGroups) {
      byStatus[g.status] = g._count.status;
    }
    return {
      total: totalOrders,
      byStatus,
      revenueSum: revenueAgg._sum.total ? revenueAgg._sum.total.toString() : '0.00',
      recent: recentOrders.map((o) => ({
        id: o.id,
        status: o.status,
        total: o.total.toString(),
        currency: o.currency,
        customerId: o.customerId,
        createdAt: o.createdAt,
      })),
    };
  }
}
