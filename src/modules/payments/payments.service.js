import crypto from 'node:crypto';
import { getPrismaClient } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import { PaymentRepository } from './payments.repository.js';
import { verifyWebhookSignature } from './webhook.util.js';
import { env } from '../../config/env.js';
import { emitPaymentCompleted } from '../../realtime/realtime.service.js';

const PAYMENT_TRANSITIONS = {
  PENDING: ['PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED'],
  PROCESSING: ['COMPLETED', 'FAILED', 'CANCELLED'],
  COMPLETED: ['REFUNDED', 'PARTIALLY_REFUNDED'],
  PARTIALLY_REFUNDED: ['REFUNDED', 'PARTIALLY_REFUNDED'],
  FAILED: [],
  CANCELLED: [],
  REFUNDED: [],
};

function isValidTransition(from, to) {
  if (!from || !to) return false;
  if (from === to) return false;
  const allowed = PAYMENT_TRANSITIONS[from] || [];
  return allowed.includes(to);
}

const ORDER_ELIGIBLE_STATUSES = ['PENDING', 'CONFIRMED', 'PROCESSING', 'DRAFT'];

function toCents(decimalStr) {
  return Math.round(parseFloat(decimalStr.toString()) * 100);
}
function fromCents(cents) {
  return (cents / 100).toFixed(2);
}

export class PaymentService {
  constructor() {
    this.prisma = getPrismaClient();
    this.repository = new PaymentRepository();
  }

  async create(tenantId, userId, body) {
    const orderId = body.orderId;
    const provider = body.provider || env.PAYMENT_PROVIDER || 'mock';
    const metadata = body.metadata || {};

    const order = await this.prisma.order.findFirst({ where: { id: orderId, tenantId } });
    if (!order) throw new AppError('Order not found', { statusCode: 404, code: 'ORDER_NOT_FOUND' });
    if (!ORDER_ELIGIBLE_STATUSES.includes(order.status)) {
      throw new AppError(`Order not eligible for payment (status ${order.status})`, { statusCode: 400, code: 'ORDER_NOT_ELIGIBLE' });
    }

    // Prevent duplicate active payment for same order
    const existing = await this.repository.findActiveForOrder(orderId, tenantId);
    if (existing) {
      throw new AppError('Order already has a pending payment', { statusCode: 400, code: 'PAYMENT_ALREADY_PENDING' });
    }

    const amountStr = order.total.toString();
    const currency = order.currency || body.currency || 'USD';

    // Ensure amount is valid decimal
    const amountCents = toCents(amountStr);
    if (amountCents <= 0) throw new AppError('Order total must be positive', { statusCode: 400, code: 'INVALID_AMOUNT' });

    const result = await this.prisma.$transaction(async (tx) => {
      const providerPaymentId = `pay_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

      const payment = await tx.payment.create({
        data: {
          tenantId,
          orderId,
          amount: amountStr,
          currency,
          status: 'PENDING',
          provider,
          providerPaymentId,
          metadata,
        },
      });

      await tx.paymentTransaction.create({
        data: {
          tenantId,
          paymentId: payment.id,
          type: 'CHARGE',
          amount: amountStr,
          currency,
          status: 'PENDING',
          providerTransactionId: `txn_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
          metadata: { initiatedBy: userId },
        },
      });

      return tx.payment.findFirst({
        where: { id: payment.id, tenantId },
        include: { transactions: true, refunds: true, order: true },
      });
    });

    return result;
  }

  async confirm(tenantId, userId, body) {
    const paymentId = body.paymentId;
    const providerPaymentId = body.providerPaymentId;
    const simulateFailure = body.simulateFailure === true;

    let payment;
    if (paymentId) {
      payment = await this.repository.findById(paymentId, tenantId);
    } else if (providerPaymentId) {
      payment = await this.repository.findByProviderPaymentId(providerPaymentId, tenantId);
    }
    if (!payment) throw new AppError('Payment not found', { statusCode: 404, code: 'PAYMENT_NOT_FOUND' });

    if (payment.status !== 'PENDING' && payment.status !== 'PROCESSING') {
      throw new AppError(`Invalid payment state for confirmation: ${payment.status}`, { statusCode: 400, code: 'INVALID_STATE_TRANSITION' });
    }

    const targetStatus = simulateFailure ? 'FAILED' : 'COMPLETED';
    if (!isValidTransition(payment.status, targetStatus)) {
      throw new AppError(`Invalid state transition from ${payment.status} to ${targetStatus}`, { statusCode: 400, code: 'INVALID_STATE_TRANSITION' });
    }

    const result = await this.prisma.$transaction(async (tx) => {
      // Lock payment row
      await tx.$queryRaw`SELECT "id" FROM "payments" WHERE "id" = ${payment.id} AND "tenant_id" = ${tenantId} FOR UPDATE`;
      const fresh = await tx.payment.findFirst({ where: { id: payment.id, tenantId } });
      if (!fresh || (fresh.status !== 'PENDING' && fresh.status !== 'PROCESSING')) {
        throw new AppError(`Invalid payment state for confirmation: ${fresh?.status}`, { statusCode: 400, code: 'INVALID_STATE_TRANSITION' });
      }

      await tx.payment.update({
        where: { id: payment.id },
        data: { status: targetStatus, providerPaymentId: providerPaymentId || fresh.providerPaymentId },
      });

      await tx.paymentTransaction.create({
        data: {
          tenantId,
          paymentId: payment.id,
          type: 'CHARGE',
          amount: fresh.amount.toString(),
          currency: fresh.currency,
          status: targetStatus,
          providerTransactionId: providerPaymentId ? `txn_${providerPaymentId.slice(0, 12)}_${Date.now()}` : `txn_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
          metadata: { confirmedBy: userId, simulateFailure },
        },
      });

      return tx.payment.findFirst({
        where: { id: payment.id, tenantId },
        include: { transactions: true, refunds: true, order: true },
      });
    });
    try {
      if (result.status === 'COMPLETED') {
        emitPaymentCompleted(tenantId, {
          id: result.id,
          tenantId,
          orderId: result.orderId,
          amount: result.amount?.toString?.() ?? String(result.amount),
          currency: result.currency,
          status: result.status,
          providerPaymentId: result.providerPaymentId,
        });
      }
    } catch (_e) { void _e; }
    return result;
  }

  async getById(id, tenantId) {
    const payment = await this.repository.findById(id, tenantId);
    if (!payment) throw new AppError('Payment not found', { statusCode: 404, code: 'PAYMENT_NOT_FOUND' });
    return payment;
  }

  async refund(tenantId, userId, paymentId, body) {
    const amountStr = body.amount;
    const reason = body.reason || null;
    const metadata = body.metadata || {};

    const payment = await this.repository.findById(paymentId, tenantId);
    if (!payment) throw new AppError('Payment not found', { statusCode: 404, code: 'PAYMENT_NOT_FOUND' });

    if (payment.status !== 'COMPLETED' && payment.status !== 'PARTIALLY_REFUNDED') {
      throw new AppError(`Refund not allowed in payment status ${payment.status}`, { statusCode: 400, code: 'INVALID_REFUND_STATE' });
    }

    const requestedCents = toCents(amountStr);
    if (requestedCents <= 0) throw new AppError('Refund amount must be positive', { statusCode: 400, code: 'INVALID_REFUND_AMOUNT' });

    // Compute already refunded amount (COMPLETED refunds)
    const completedRefunds = await this.prisma.refund.findMany({ where: { paymentId, tenantId, status: 'COMPLETED' } });
    let refundedCents = 0;
    for (const r of completedRefunds) refundedCents += toCents(r.amount.toString());
    const paymentCents = toCents(payment.amount.toString());
    const refundableCents = paymentCents - refundedCents;
    if (requestedCents > refundableCents) {
      throw new AppError(`Refund amount exceeds refundable amount: requested ${fromCents(requestedCents)}, refundable ${fromCents(refundableCents)}`, { statusCode: 400, code: 'EXCESSIVE_REFUND' });
    }

    // Prevent duplicate refund with same amount and reason within short window? Enforce idempotency via transaction uniqueness? For now check exact duplicate pending?
    // Use transaction to create refund and update payment status atomically

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "payments" WHERE "id" = ${paymentId} AND "tenant_id" = ${tenantId} FOR UPDATE`;
      const freshPayment = await tx.payment.findFirst({ where: { id: paymentId, tenantId } });
      // Recompute refundable inside transaction to prevent race
      const freshRefunds = await tx.refund.findMany({ where: { paymentId, tenantId, status: 'COMPLETED' } });
      let freshRefunded = 0;
      for (const r of freshRefunds) freshRefunded += toCents(r.amount.toString());
      const freshRefundable = toCents(freshPayment.amount.toString()) - freshRefunded;
      if (requestedCents > freshRefundable) {
        throw new AppError(`Refund amount exceeds refundable amount`, { statusCode: 400, code: 'EXCESSIVE_REFUND' });
      }
      if (freshPayment.status !== 'COMPLETED' && freshPayment.status !== 'PARTIALLY_REFUNDED') {
        throw new AppError(`Refund not allowed in payment status ${freshPayment.status}`, { statusCode: 400, code: 'INVALID_REFUND_STATE' });
      }

      const providerRefundId = `ref_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

      const refund = await tx.refund.create({
        data: {
          tenantId,
          paymentId,
          amount: fromCents(requestedCents),
          currency: freshPayment.currency,
          status: 'COMPLETED',
          reason,
          providerRefundId,
          metadata,
        },
      });

      await tx.paymentTransaction.create({
        data: {
          tenantId,
          paymentId,
          type: 'REFUND',
          amount: fromCents(requestedCents),
          currency: freshPayment.currency,
          status: 'COMPLETED',
          providerTransactionId: `txn_ref_${providerRefundId}`,
          metadata: { refundId: refund.id, refundedBy: userId },
        },
      });

      const totalAfter = freshRefunded + requestedCents;
      const newStatus = totalAfter >= paymentCents ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
      if (!isValidTransition(freshPayment.status, newStatus) && freshPayment.status !== newStatus) {
        // Allow COMPLETED -> PARTIALLY_REFUNDED and PARTIALLY_REFUNDED -> REFUNDED/PARTIALLY_REFUNDED
        // If invalid, still enforce
        throw new AppError(`Invalid refund state transition from ${freshPayment.status} to ${newStatus}`, { statusCode: 400, code: 'INVALID_STATE_TRANSITION' });
      }

      await tx.payment.update({ where: { id: paymentId }, data: { status: newStatus } });

      return tx.payment.findFirst({
        where: { id: paymentId, tenantId },
        include: { transactions: true, refunds: true, order: true },
      });
    });

    return result;
  }

  async handleWebhook(rawBody, headers, signature) {
    // rawBody is parsed JSON body object
    // headers may contain signature
    const payload = rawBody;
    const eventId = payload.eventId;
    const type = payload.type;
    const paymentId = payload.paymentId || null;
    const providerPaymentId = payload.providerPaymentId || null;
    const providerTransactionId = payload.providerTransactionId || null;
    const amountStr = payload.amount || null;
    const tenantIdFromPayload = payload.tenantId || null;

    if (!eventId) throw new AppError('eventId is required', { statusCode: 400, code: 'INVALID_WEBHOOK' });

    // Verify signature: header signature must be valid HMAC of JSON.stringify(payload)
    const headerSig = signature || headers?.['x-webhook-signature'] || headers?.['x-payment-signature'];
    const isValidSig = verifyWebhookSignature(payload, headerSig);
    if (!headerSig || !isValidSig) {
      throw new AppError('Invalid webhook signature', { statusCode: 401, code: 'INVALID_WEBHOOK_SIGNATURE' });
    }

    // Determine tenantId and payment
    let tenantId = tenantIdFromPayload;
    let payment = null;

    if (paymentId) {
      // Need tenantId to lookup; if not supplied try to find payment across tenants? Must be tenant scoped; we need to search with tenant if available else global lookup then derive tenant
      if (tenantId) {
        payment = await this.repository.findById(paymentId, tenantId);
      } else {
        // lookup without tenant then derive
        payment = await this.prisma.payment.findFirst({ where: { id: paymentId } });
        if (payment) tenantId = payment.tenantId;
      }
    } else if (providerPaymentId) {
      if (tenantId) {
        payment = await this.repository.findByProviderPaymentId(providerPaymentId, tenantId);
      } else {
        payment = await this.prisma.payment.findFirst({ where: { providerPaymentId } });
        if (payment) tenantId = payment.tenantId;
      }
    }

    if (!tenantId) {
      // If tenant still unknown, reject
      throw new AppError('Cannot resolve tenant for webhook', { statusCode: 400, code: 'INVALID_WEBHOOK' });
    }
    if (!payment) {
      throw new AppError('Payment not found for webhook', { statusCode: 404, code: 'PAYMENT_NOT_FOUND' });
    }

    // Idempotency: attempt to insert webhook event with ON CONFLICT handling
    // Use DB uniqueness constraint: (tenantId, eventId) and eventId globally
    // We must handle concurrent duplicate via uniqueness violation
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        // Try insert webhook event; if duplicate, this will violate unique constraint
        await tx.paymentWebhookEvent.create({
          data: {
            tenantId,
            paymentId: payment.id,
            eventId,
            providerEventId: eventId,
            providerPaymentId: providerPaymentId || payment.providerPaymentId,
            type,
            payload,
          },
        });

        // Determine target status from type
        let targetStatus;
        if (type === 'payment.succeeded' || type === 'charge.succeeded') targetStatus = 'COMPLETED';
        else if (type === 'payment.failed' || type === 'charge.failed') targetStatus = 'FAILED';
        else if (type === 'payment.refunded') targetStatus = 'REFUNDED';
        else targetStatus = null;

        if (targetStatus && isValidTransition(payment.status, targetStatus)) {
          // Lock payment
          await tx.$queryRaw`SELECT "id" FROM "payments" WHERE "id" = ${payment.id} AND "tenant_id" = ${tenantId} FOR UPDATE`;
          const fresh = await tx.payment.findFirst({ where: { id: payment.id, tenantId } });
          if (fresh && isValidTransition(fresh.status, targetStatus)) {
            await tx.payment.update({ where: { id: payment.id }, data: { status: targetStatus } });
            // Create transaction if not duplicate
            const existingTxn = await tx.paymentTransaction.findFirst({ where: { tenantId, providerTransactionId } });
            if (!existingTxn) {
              await tx.paymentTransaction.create({
                data: {
                  tenantId,
                  paymentId: payment.id,
                  type: type.includes('refund') ? 'REFUND' : 'CHARGE',
                  amount: amountStr || fresh.amount.toString(),
                  currency: fresh.currency,
                  status: targetStatus,
                  providerTransactionId: providerTransactionId || `wh_${eventId}`,
                  metadata: { webhookEventId: eventId, webhookType: type },
                },
              });
            }
          }
        } else if (targetStatus && payment.status === targetStatus) {
          // Already in target status, but ensure no duplicate transaction side effect beyond idempotency
          // Check if transaction with providerTransactionId already exists, if not create?
          // For idempotency we already inserted event; no further action
        }

        const updatedPayment = await tx.payment.findFirst({ where: { id: payment.id, tenantId }, include: { transactions: true, refunds: true } });
        return updatedPayment;
      });
      // Emit if webhook caused COMPLETED
      try {
        if (created && created.status === 'COMPLETED' && payment.status !== 'COMPLETED') {
          emitPaymentCompleted(tenantId, {
            id: created.id,
            tenantId,
            orderId: created.orderId,
            amount: created.amount?.toString?.() ?? String(created.amount),
            currency: created.currency,
            status: created.status,
          });
        }
      } catch (_e) { void _e; }
      return { payment: created, duplicate: false };
    } catch (err) {
      // Prisma unique violation P2002
      if (err.code === 'P2002' || err.message?.includes('Unique constraint') || err.message?.includes('duplicate key')) {
        // Duplicate webhook - safely ignore, fetch current payment
        const current = await this.repository.findById(payment.id, tenantId);
        return { payment: current, duplicate: true };
      }
      throw err;
    }
  }

  // For testing webhook signature generation
  getWebhookSecret() {
    return env.PAYMENT_WEBHOOK_SECRET;
  }
}
