import crypto from 'node:crypto';
import { getPrismaClient } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import { OrderService } from '../orders/orders.service.js';
import { resolveOrderDefaults, lineRate } from '../orders/gst.js';
import { paymentGatewayService } from '../payments/payment-gateway.service.js';
import { emitPaymentCompleted } from '../../realtime/realtime.service.js';
import * as razorpay from '../../integrations/payment/razorpay.client.js';
import { cashRegisterService } from './cash-register.service.js';

/**
 * Phase 39: selling at the shop counter.
 * A counter sale is a normal GST invoice (channel POS) that is paid and handed over on the spot: the order,
 * its stock movements, its payments (cash, UPI, card, bank transfer, cheque — or several) and the cash drawer
 * entry are written in one transaction, then the order is marked delivered.
 */
export const PAYMENT_METHODS = ['CASH', 'UPI', 'CARD', 'BANK', 'CHEQUE'];
const WALK_IN = { firstName: 'Walk-in', lastName: 'Customer' };
const QR_MINUTES = 15;

const cents = (v) => Math.round(Number(v ?? 0) * 100);
const money = (c) => (c / 100).toFixed(2);
const walkInEmail = (tenantId) => `walk-in.${tenantId.slice(0, 8)}@counter.pulseops.invalid`;

export class PosService {
  constructor() {
    this.prisma = getPrismaClient();
    this.orders = new OrderService();
  }

  /** The anonymous customer for quick counter sales, one per business, created on first use. */
  async walkInCustomer(tenantId) {
    const email = walkInEmail(tenantId);
    const existing = await this.prisma.customer.findFirst({ where: { tenantId, email, deletedAt: null } });
    if (existing) return existing;
    try {
      return await this.prisma.customer.create({ data: { tenantId, email, ...WALK_IN, metadata: { walkIn: true } } });
    } catch (err) {
      if (err?.code === 'P2002') return this.prisma.customer.findFirst({ where: { tenantId, email, deletedAt: null } });
      throw err;
    }
  }

  async defaultWarehouse(tenantId) {
    return this.prisma.warehouse.findFirst({ where: { tenantId, isActive: true }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] });
  }

  /** What the counter screen needs to start: walk-in customer, warehouse, counters, UPI options. */
  async context(tenantId) {
    const [walkIn, warehouse, registers, defaults, gateway] = await Promise.all([
      this.walkInCustomer(tenantId),
      this.defaultWarehouse(tenantId),
      cashRegisterService.list(tenantId),
      resolveOrderDefaults(this.prisma, tenantId),
      paymentGatewayService.credentialsFor(tenantId),
    ]);
    return {
      walkInCustomerId: walkIn.id,
      warehouse: warehouse ? { id: warehouse.id, name: warehouse.name } : null,
      registers,
      gstRatePercent: defaults.gstRatePercent,
      pricesIncludeTax: Boolean(defaults.taxProfile.pricesIncludeTax),
      upi: gateway ? 'razorpay' : defaults.taxProfile.upiId ? 'upi-id' : null,
      paymentMethods: PAYMENT_METHODS,
    };
  }

  /**
   * Find items for the counter: an exact barcode or SKU match comes first (a scanner types the code and Enter),
   * then name/SKU/barcode contains. Only sellable variants, with stock in the chosen warehouse.
   */
  async lookup(tenantId, { q, warehouseId, limit = 20 }) {
    const term = q.trim();
    const sellable = { tenantId, status: 'ACTIVE', deletedAt: null, product: { status: 'ACTIVE', deletedAt: null } };
    const include = {
      product: { select: { id: true, name: true, brand: true, hsnCode: true, gstRatePercent: true, gstTaxability: true, unit: true } },
      inventory: warehouseId ? { where: { warehouseId }, select: { quantity: true } } : { select: { quantity: true } },
    };
    const exact = await this.prisma.productVariant.findMany({
      where: { ...sellable, OR: [{ barcode: term }, { sku: { equals: term, mode: 'insensitive' } }] },
      include,
      take: limit,
    });
    const rest = exact.length >= limit ? [] : await this.prisma.productVariant.findMany({
      where: {
        ...sellable,
        id: { notIn: exact.map((v) => v.id) },
        OR: [
          { sku: { contains: term, mode: 'insensitive' } },
          { barcode: { contains: term } },
          { product: { name: { contains: term, mode: 'insensitive' } } },
        ],
      },
      include,
      orderBy: { updatedAt: 'desc' },
      take: limit - exact.length,
    });
    const defaults = await resolveOrderDefaults(this.prisma, tenantId);
    return [...exact.map((v) => ({ v, exact: true })), ...rest.map((v) => ({ v, exact: false }))].map(({ v, exact: isExact }) => ({
      variantId: v.id,
      productId: v.product.id,
      name: v.product.name,
      brand: v.product.brand,
      sku: v.sku,
      barcode: v.barcode,
      price: v.price,
      mrp: v.mrp,
      unit: v.product.unit,
      hsnCode: v.product.hsnCode,
      gstRatePercent: lineRate(v.product, defaults.gstRatePercent),
      stock: v.inventory.reduce((n, i) => n + i.quantity, 0),
      exactMatch: isExact,
    }));
  }

  /** Check a Razorpay UPI QR really received this amount and that the money isn't already used by another sale. */
  async verifyRazorpayUpi(tenantId, qrId, amountCents) {
    const credentials = await paymentGatewayService.credentialsFor(tenantId);
    if (!credentials) throw new AppError('Razorpay is not connected', { statusCode: 409, code: 'PAYMENT_GATEWAY_NOT_CONFIGURED' });
    const received = await razorpay.qrPayments(credentials, qrId);
    const paid = (received?.items ?? []).find((p) => p.status === 'captured' && p.amount === amountCents);
    if (!paid) throw new AppError('The UPI payment for this amount has not been received yet', { statusCode: 409, code: 'UPI_PAYMENT_NOT_RECEIVED' });
    const used = await this.prisma.payment.findFirst({ where: { tenantId, provider: 'razorpay', providerPaymentId: paid.id } });
    if (used) throw new AppError('This UPI payment was already used for another sale', { statusCode: 409, code: 'UPI_PAYMENT_ALREADY_USED' });
    return { razorpayPaymentId: paid.id, vpa: paid.vpa ?? null };
  }

  /** Sell at the counter. Everything (order, stock, payments, cash drawer, delivered status) commits together. */
  async sale(tenantId, userId, body, auditContext = {}) {
    const customerId = body.customerId ?? (await this.walkInCustomer(tenantId)).id;
    const warehouseId = body.warehouseId ?? (await this.defaultWarehouse(tenantId))?.id;
    if (!warehouseId) throw new AppError('Add a warehouse before selling', { statusCode: 409, code: 'NO_WAREHOUSE' });

    const payments = body.payments.map((p) => ({ ...p, amountCents: cents(p.amount) }));
    const cashCents = payments.filter((p) => p.method === 'CASH').reduce((n, p) => n + p.amountCents, 0);

    // Cash needs an open shift on the counter
    let session = null;
    if (cashCents > 0) {
      const registerId = body.registerId ?? (await cashRegisterService.ensureDefault(tenantId)).id;
      session = await cashRegisterService.openSessionFor(tenantId, registerId);
      if (!session) throw new AppError('Open the cash register before taking cash', { statusCode: 409, code: 'REGISTER_CLOSED' });
    }

    // Razorpay UPI: confirm with Razorpay before anything is written
    for (const p of payments) {
      if (p.method === 'UPI' && p.razorpayQrId) Object.assign(p, await this.verifyRazorpayUpi(tenantId, p.razorpayQrId, p.amountCents));
    }

    const created = [];
    const order = await this.orders.create(tenantId, userId, {
      customerId,
      items: body.items.map((i) => ({ productVariantId: i.variantId, warehouseId, quantity: i.quantity, discount: i.discount })),
      channel: 'POS',
      metadata: { pos: { registerId: session?.registerId ?? null, sessionId: session?.id ?? null }, ...(body.note ? { note: body.note } : {}) },
    }, auditContext, {
      inTx: async (tx, o) => {
        const totalCents = cents(o.total);
        const paidCents = payments.reduce((n, p) => n + p.amountCents, 0);
        if (paidCents !== totalCents) {
          throw new AppError(`Payments add up to ₹${money(paidCents)} but the bill is ₹${money(totalCents)}`, {
            statusCode: 400, code: 'PAYMENT_TOTAL_MISMATCH', details: { total: money(totalCents), paid: money(paidCents) },
          });
        }
        for (const p of payments) {
          const razorpayPaid = p.method === 'UPI' && p.razorpayPaymentId;
          const tendered = p.method === 'CASH' && p.tendered ? cents(p.tendered) : null;
          if (tendered !== null && tendered < p.amountCents) throw new AppError('Cash given is less than the cash amount', { statusCode: 400, code: 'CASH_SHORT' });
          const payment = await tx.payment.create({
            data: {
              tenantId, orderId: o.id, amount: money(p.amountCents), currency: o.currency, status: 'COMPLETED',
              provider: razorpayPaid ? 'razorpay' : p.method.toLowerCase(),
              providerPaymentId: razorpayPaid ? p.razorpayPaymentId : `pos_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
              metadata: {
                channel: 'POS', method: p.method, reference: p.reference ?? null,
                ...(tendered !== null ? { tendered: money(tendered), change: money(tendered - p.amountCents) } : {}),
                ...(razorpayPaid ? { razorpayQrId: p.razorpayQrId, vpa: p.vpa } : {}),
              },
            },
          });
          await tx.paymentTransaction.create({
            data: {
              tenantId, paymentId: payment.id, type: 'CHARGE', amount: payment.amount.toString(), currency: payment.currency, status: 'COMPLETED',
              providerTransactionId: `txn_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`, metadata: { initiatedBy: userId, channel: 'POS' },
            },
          });
          if (p.method === 'CASH') await cashRegisterService.recordSale(tx, { tenantId, sessionId: session.id, amount: payment.amount, orderId: o.id, paymentId: payment.id, userId });
          created.push(payment);
        }
        // Paid and handed over at the counter
        await tx.order.update({ where: { id: o.id }, data: { status: 'DELIVERED' } });
        await tx.orderStatusHistory.create({ data: { tenantId, orderId: o.id, fromStatus: 'PENDING', toStatus: 'DELIVERED', reason: 'Counter sale', createdBy: userId } });
      },
    });

    for (const payment of created) {
      try {
        emitPaymentCompleted(tenantId, { id: payment.id, tenantId, orderId: payment.orderId, amount: payment.amount.toString(), currency: payment.currency, status: payment.status, providerPaymentId: payment.providerPaymentId });
      } catch (_e) { void _e; }
    }
    const change = created.reduce((n, p) => n + cents(p.metadata?.change), 0);
    return { order, payments: created, change: money(change) };
  }

  // ── UPI QR at the counter ─────────────────────────────────────────────

  /** Razorpay single-use QR for this amount when Razorpay is connected; otherwise a QR from the shop's own UPI ID. */
  async upiQr(tenantId, { amount }) {
    const amountMinor = cents(amount);
    const credentials = await paymentGatewayService.credentialsFor(tenantId);
    const defaults = await resolveOrderDefaults(this.prisma, tenantId);
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
    if (credentials) {
      const qr = await razorpay.createUpiQr(credentials, {
        amountMinor, name: defaults.taxProfile.tradeName || tenant?.name, description: `Counter sale ₹${money(amountMinor)}`,
        closeBy: Math.floor(Date.now() / 1000) + QR_MINUTES * 60, notes: { tenantId, channel: 'POS' },
      });
      return { provider: 'razorpay', qrId: qr.id, imageUrl: qr.image_url, amount: money(amountMinor), expiresInMinutes: QR_MINUTES };
    }
    const upiId = defaults.taxProfile.upiId;
    if (!upiId) throw new AppError('Connect Razorpay or add the shop UPI ID in Settings to take UPI', { statusCode: 409, code: 'UPI_NOT_CONFIGURED' });
    const params = new URLSearchParams({ pa: upiId, pn: defaults.taxProfile.tradeName || tenant?.name || '', am: money(amountMinor), cu: 'INR', tn: 'Counter sale' });
    return { provider: 'upi-id', upiUri: `upi://pay?${params.toString()}`, amount: money(amountMinor) };
  }

  /** Has the Razorpay QR been paid? (the counter screen asks every few seconds) */
  async upiQrStatus(tenantId, qrId) {
    const credentials = await paymentGatewayService.credentialsFor(tenantId);
    if (!credentials) throw new AppError('Razorpay is not connected', { statusCode: 409, code: 'PAYMENT_GATEWAY_NOT_CONFIGURED' });
    const received = await razorpay.qrPayments(credentials, qrId);
    const paid = (received?.items ?? []).find((p) => p.status === 'captured');
    return paid ? { paid: true, amount: money(paid.amount), razorpayPaymentId: paid.id } : { paid: false };
  }

  // ── Held sales ────────────────────────────────────────────────────────

  async listHeld(tenantId) {
    return this.prisma.posHeldSale.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, take: 50 });
  }

  async hold(tenantId, userId, { label, cart }) {
    return this.prisma.posHeldSale.create({ data: { tenantId, userId, label: label ?? null, cart } });
  }

  async removeHeld(tenantId, id) {
    const { count } = await this.prisma.posHeldSale.deleteMany({ where: { id, tenantId } });
    if (!count) throw new AppError('Held sale not found', { statusCode: 404, code: 'HELD_SALE_NOT_FOUND' });
  }
}

export const posService = new PosService();
