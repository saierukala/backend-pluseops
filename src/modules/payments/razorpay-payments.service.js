import crypto from 'node:crypto';
import { getPrismaClient } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import { logger } from '../../config/logger.js';
import { emitPaymentCompleted } from '../../realtime/realtime.service.js';
import { paymentGatewayService } from './payment-gateway.service.js';
import * as razorpay from '../../integrations/payment/razorpay.client.js';

// Phase 35: online payment through the shop's own Razorpay account.
// 1. start:   the server prices the order and creates a Razorpay order for it (a PENDING payment, provider "razorpay",
//             providerPaymentId = the Razorpay order id).
// 2. verify:  the browser sends back what Razorpay's checkout gave it; the server checks the signature, then COMPLETED.
// 3. webhook: Razorpay tells the server directly (backup if the shopper closed the tab). Same "mark paid", once.

export const PROVIDER = 'razorpay';
const ELIGIBLE_ORDER_STATUSES = ['PENDING', 'CONFIRMED', 'PROCESSING', 'DRAFT'];
const PAID_EVENTS = ['payment.captured', 'order.paid'];
// The Razorpay call happens while the order/payment row is locked; give the transaction room for its timeout
const TX_OPTIONS = { timeout: 30000, maxWait: 10000 };

const paymentNotFound = () => new AppError('Payment not found', { statusCode: 404, code: 'PAYMENT_NOT_FOUND' });

function checkoutFor(payment, credentials, details = {}) {
  return {
    provider: PROVIDER,
    keyId: credentials.keyId,
    orderId: payment.providerPaymentId,
    amount: payment.metadata?.amountMinor ?? razorpay.toMinorUnits(payment.amount, payment.currency),
    currency: payment.currency,
    ...details,
  };
}

export class RazorpayPaymentsService {
  constructor() {
    this.prisma = getPrismaClient();
  }

  /** Whether the shop takes online payment through Razorpay right now. */
  async enabledFor(tenantId) {
    return Boolean(await paymentGatewayService.credentialsFor(tenantId));
  }

  /**
   * Starts (or resumes) online payment of an order. Pressing "Pay" again for the same amount reuses the Razorpay order
   * instead of creating one per click. Returns { payment, checkout } — checkout is what Razorpay's web checkout needs.
   */
  async start(tenantId, orderId, { userId = null, description, prefill } = {}) {
    const credentials = await paymentGatewayService.credentialsFor(tenantId);
    if (!credentials) throw new AppError('This shop does not take online payment yet', { statusCode: 409, code: 'PAYMENT_GATEWAY_NOT_CONFIGURED' });

    const payment = await this.prisma.$transaction(async (tx) => {
      // One payer at a time per order: two clicks can't create two Razorpay orders
      await tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${orderId} AND "tenant_id" = ${tenantId} FOR UPDATE`;
      const order = await tx.order.findFirst({ where: { id: orderId, tenantId } });
      if (!order) throw new AppError('Order not found', { statusCode: 404, code: 'ORDER_NOT_FOUND' });
      if (!ELIGIBLE_ORDER_STATUSES.includes(order.status)) {
        throw new AppError(`Order not eligible for payment (status ${order.status})`, { statusCode: 409, code: 'ORDER_NOT_ELIGIBLE' });
      }
      if (await tx.payment.findFirst({ where: { orderId, tenantId, status: 'COMPLETED', deletedAt: null } })) {
        throw new AppError('This order is already paid', { statusCode: 409, code: 'ORDER_ALREADY_PAID' });
      }
      const currency = order.currency || 'INR';
      const amountMinor = razorpay.toMinorUnits(order.total, currency);
      if (amountMinor <= 0) throw new AppError('Order total must be positive', { statusCode: 400, code: 'INVALID_AMOUNT' });

      const active = await tx.payment.findFirst({ where: { orderId, tenantId, status: { in: ['PENDING', 'PROCESSING'] }, deletedAt: null } });
      if (active) {
        if (active.provider === PROVIDER && active.metadata?.amountMinor === amountMinor && active.metadata?.keyId === credentials.keyId) return active;
        // A stale attempt (other provider, changed total, or keys since replaced) gives way to the new one
        await tx.payment.update({ where: { id: active.id }, data: { status: 'CANCELLED' } });
      }

      const rzpOrder = await razorpay.createOrder(credentials, {
        amountMinor, currency, receipt: order.id, notes: { tenantId, orderId },
      });
      const created = await tx.payment.create({
        data: {
          tenantId, orderId, amount: order.total.toString(), currency, status: 'PENDING', provider: PROVIDER, providerPaymentId: rzpOrder.id,
          metadata: { razorpayOrderId: rzpOrder.id, amountMinor, keyId: credentials.keyId, mode: razorpay.modeOf(credentials.keyId) },
        },
      });
      await tx.paymentTransaction.create({
        data: {
          tenantId, paymentId: created.id, type: 'CHARGE', amount: created.amount.toString(), currency, status: 'PENDING',
          providerTransactionId: rzpOrder.id, metadata: { initiatedBy: userId, razorpayOrderId: rzpOrder.id },
        },
      });
      return created;
    }, TX_OPTIONS);

    return { payment, checkout: checkoutFor(payment, credentials, { description, prefill }) };
  }

  /** Checkout handler result from the browser → COMPLETED, after checking Razorpay's signature. `where` scopes the lookup. */
  async verify(tenantId, paymentId, { razorpayOrderId, razorpayPaymentId, razorpaySignature }, { userId = null, where = {} } = {}) {
    const payment = await this.prisma.payment.findFirst({ where: { id: paymentId, tenantId, provider: PROVIDER, deletedAt: null, ...where } });
    if (!payment) throw paymentNotFound();
    const credentials = await paymentGatewayService.credentialsFor(tenantId, { includeDisabled: true });
    if (!credentials) throw new AppError('This shop does not take online payment yet', { statusCode: 409, code: 'PAYMENT_GATEWAY_NOT_CONFIGURED' });
    if (payment.providerPaymentId !== razorpayOrderId || !razorpay.checkoutSignatureValid(credentials.keySecret, razorpayOrderId, razorpayPaymentId, razorpaySignature)) {
      throw new AppError('We could not confirm this payment. If money was taken, it will be confirmed automatically or refunded.', { statusCode: 400, code: 'INVALID_PAYMENT_SIGNATURE' });
    }
    return this.markPaid(tenantId, payment.id, razorpayPaymentId, { via: 'checkout', userId });
  }

  /**
   * PENDING → COMPLETED, once. Safe when the browser and the webhook arrive together: the row is locked and only the
   * first one changes it; the other reads the result. `inTx` runs inside the same transaction (webhook event record).
   */
  async markPaid(tenantId, paymentId, razorpayPaymentId, { via, userId = null, inTx } = {}) {
    let changed = false;
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "payments" WHERE "id" = ${paymentId} AND "tenant_id" = ${tenantId} FOR UPDATE`;
      if (inTx) await inTx(tx);
      const fresh = await tx.payment.findFirst({ where: { id: paymentId, tenantId } });
      if (fresh.status === 'PENDING' || fresh.status === 'PROCESSING') {
        await tx.payment.update({ where: { id: paymentId }, data: { status: 'COMPLETED', metadata: { ...fresh.metadata, razorpayPaymentId, paidVia: via } } });
        await tx.paymentTransaction.create({
          data: {
            tenantId, paymentId, type: 'CHARGE', amount: fresh.amount.toString(), currency: fresh.currency, status: 'COMPLETED',
            providerTransactionId: razorpayPaymentId, metadata: { razorpayOrderId: fresh.providerPaymentId, via, confirmedBy: userId },
          },
        });
        changed = true;
      } else if (fresh.metadata?.razorpayPaymentId !== razorpayPaymentId) {
        // Money was taken for a payment that is no longer open (cancelled, or paid by another attempt): the shop must refund it
        logger.warn({ tenantId, paymentId, status: fresh.status, razorpayPaymentId }, 'Razorpay payment captured for a payment that is not open: refund it in the Razorpay dashboard');
        await tx.paymentTransaction.create({
          data: {
            tenantId, paymentId, type: 'CHARGE', amount: fresh.amount.toString(), currency: fresh.currency, status: 'COMPLETED',
            providerTransactionId: razorpayPaymentId, metadata: { razorpayOrderId: fresh.providerPaymentId, via, note: 'Captured after the payment was closed; refund needed' },
          },
        });
      }
      return tx.payment.findFirst({ where: { id: paymentId, tenantId }, include: { transactions: true, refunds: true } });
    });
    if (changed) {
      try {
        emitPaymentCompleted(tenantId, {
          id: result.id, tenantId, orderId: result.orderId, amount: result.amount.toString(), currency: result.currency, status: result.status, providerPaymentId: result.providerPaymentId,
        });
      } catch (_e) { void _e; }
    }
    return result;
  }

  /** Razorpay → us, signed with the shop's webhook secret. Repeats of an event change nothing. */
  async handleWebhook(tenantId, rawBody, signature, eventIdHeader) {
    const credentials = await paymentGatewayService.credentialsFor(tenantId, { includeDisabled: true }).catch(() => null);
    if (!credentials?.webhookSecret || !rawBody || !razorpay.webhookSignatureValid(credentials.webhookSecret, rawBody, signature)) {
      throw new AppError('Invalid webhook signature', { statusCode: 401, code: 'INVALID_WEBHOOK_SIGNATURE' });
    }
    let event;
    try {
      event = JSON.parse(rawBody);
    } catch {
      throw new AppError('Webhook body is not JSON', { statusCode: 400, code: 'INVALID_WEBHOOK' });
    }
    const entity = event?.payload?.payment?.entity;
    // Razorpay sends x-razorpay-event-id; it repeats on retries, which is what makes this idempotent
    const eventId = `razorpay:${eventIdHeader || crypto.createHash('sha256').update(rawBody).digest('hex')}`;
    const record = (tx, paymentId) => tx.paymentWebhookEvent.create({
      data: { tenantId, paymentId, eventId, providerEventId: eventIdHeader || null, providerPaymentId: entity?.order_id || null, type: String(event?.event || 'unknown'), payload: event },
    });
    const isDuplicate = (err) => err?.code === 'P2002';

    const payment = entity?.order_id
      ? await this.prisma.payment.findFirst({ where: { tenantId, provider: PROVIDER, providerPaymentId: entity.order_id } })
      : null;
    const paid = PAID_EVENTS.includes(event?.event) && payment;
    if (paid && Number(entity.amount) !== Number(payment.metadata?.amountMinor ?? razorpay.toMinorUnits(payment.amount, payment.currency))) {
      logger.error({ tenantId, paymentId: payment.id, expected: payment.metadata?.amountMinor, got: entity.amount }, 'Razorpay webhook amount mismatch: not marked paid');
    } else if (paid) {
      try {
        const updated = await this.markPaid(tenantId, payment.id, entity.id, { via: 'webhook', inTx: (tx) => record(tx, payment.id) });
        return { handled: true, duplicate: false, paymentId: updated.id, status: updated.status };
      } catch (err) {
        if (isDuplicate(err)) return { handled: true, duplicate: true, paymentId: payment.id };
        throw err;
      }
    }
    // Other events (payment.failed: the shopper can retry on the same order) are kept for the record only
    try {
      await record(this.prisma, payment?.id ?? null);
    } catch (err) {
      if (isDuplicate(err)) return { handled: false, duplicate: true };
      throw err;
    }
    if (!payment && entity?.order_id) logger.warn({ tenantId, orderId: entity.order_id }, 'Razorpay webhook for an unknown order');
    return { handled: false, duplicate: false };
  }

  /** Sends a refund to Razorpay for a payment taken through it; returns Razorpay's refund id. Called with the payment row locked. */
  async refundAtProvider(payment, amountStr, { reason } = {}) {
    const razorpayPaymentId = payment.metadata?.razorpayPaymentId;
    if (!razorpayPaymentId) throw new AppError('This Razorpay payment has no captured payment to refund', { statusCode: 409, code: 'INVALID_REFUND_STATE' });
    const credentials = await paymentGatewayService.credentialsFor(payment.tenantId, { includeDisabled: true });
    if (!credentials) throw new AppError('Reconnect Razorpay to refund this payment', { statusCode: 409, code: 'PAYMENT_GATEWAY_NOT_CONFIGURED' });
    const refund = await razorpay.refundPayment(credentials, razorpayPaymentId, {
      amountMinor: razorpay.toMinorUnits(amountStr, payment.currency), notes: { paymentId: payment.id, ...(reason ? { reason: String(reason).slice(0, 200) } : {}) },
    });
    return { providerRefundId: refund.id, providerStatus: refund.status };
  }
}

export const razorpayPaymentsService = new RazorpayPaymentsService();
export { TX_OPTIONS as RAZORPAY_TX_OPTIONS };
