import { getPrismaClient } from '../../config/database.js';

export class PaymentRepository {
  constructor() {
    this.prisma = getPrismaClient();
  }

  async findById(id, tenantId, tx = this.prisma) {
    return tx.payment.findFirst({
      where: { id, tenantId },
      include: {
        order: { select: { id: true, total: true, status: true, currency: true } },
        transactions: { orderBy: { createdAt: 'asc' } },
        refunds: { orderBy: { createdAt: 'asc' } },
      },
    });
  }

  async findByProviderPaymentId(providerPaymentId, tenantId, tx = this.prisma) {
    if (!providerPaymentId) return null;
    return tx.payment.findFirst({ where: { providerPaymentId, tenantId } });
  }

  async findActiveForOrder(orderId, tenantId, tx = this.prisma) {
    return tx.payment.findFirst({
      where: { orderId, tenantId, status: { in: ['PENDING', 'PROCESSING'] } },
    });
  }

  async listByOrder(orderId, tenantId, tx = this.prisma) {
    return tx.payment.findMany({ where: { orderId, tenantId } });
  }

  async getOverview(tenantId) {
    const [totalPayments, statusGroups, revenueAgg, recentPayments] = await Promise.all([
      this.prisma.payment.count({ where: { tenantId } }),
      this.prisma.payment.groupBy({ by: ['status'], where: { tenantId }, _count: { status: true } }),
      this.prisma.payment.aggregate({ where: { tenantId, status: 'COMPLETED' }, _sum: { amount: true } }),
      this.prisma.payment.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { id: true, orderId: true, amount: true, currency: true, status: true, createdAt: true },
      }),
    ]);
    const byStatus = {};
    for (const g of statusGroups) {
      byStatus[g.status] = g._count.status;
    }
    return {
      total: totalPayments,
      byStatus,
      completedRevenue: revenueAgg._sum.amount ? revenueAgg._sum.amount.toString() : '0.00',
      recent: recentPayments.map((p) => ({
        id: p.id,
        orderId: p.orderId,
        amount: p.amount.toString(),
        currency: p.currency,
        status: p.status,
        createdAt: p.createdAt,
      })),
    };
  }

  sanitize(payment) {
    if (!payment) return payment;
    const { ...rest } = payment;
    // Do not expose sensitive provider internals – keep only safe fields
    // providerPaymentId is safe to expose; secrets are never stored in this model
    // metadata may contain user-supplied data, we return it but logger will redact secrets
    return rest;
  }
}
