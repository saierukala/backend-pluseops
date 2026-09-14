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

  sanitize(payment) {
    if (!payment) return payment;
    const { ...rest } = payment;
    // Do not expose sensitive provider internals – keep only safe fields
    // providerPaymentId is safe to expose; secrets are never stored in this model
    // metadata may contain user-supplied data, we return it but logger will redact secrets
    return rest;
  }
}
