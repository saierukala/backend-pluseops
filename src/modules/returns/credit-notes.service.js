import crypto from 'node:crypto';
import { getPrismaClient } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import { auditService } from '../audit/audit.service.js';
import { resolveOrderDefaults } from '../orders/gst.js';
import { nextDocumentNumber } from '../orders/numbering.js';
import { cashRegisterService } from '../pos/cash-register.service.js';
import { receivablesService } from '../receivables/receivables.service.js';

/**
 * Phase 40: sales returns. A credit note takes back some or all of an invoice's lines:
 *  - amounts are the invoice's own (taxable value and CGST/SGST/IGST per unit), so the GST reverses exactly;
 *    the last units returned take whatever is left, so rounding never leaves a paisa behind
 *  - returned goods can go back into the warehouse they left from
 *  - the money: CREDIT keeps it on the customer's account (what they owe goes down), CASH pays it out of the open
 *    register, ORIGINAL sends it back the way it came (Razorpay refunds go through Razorpay)
 *  - the order becomes PARTIALLY_REFUNDED, or REFUNDED once everything is returned
 */
export const REFUND_METHODS = ['CREDIT', 'CASH', 'ORIGINAL'];
const RETURNABLE = ['CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'PARTIALLY_REFUNDED'];

const cents = (v) => Math.round(Number(v ?? 0) * 100);
const money = (c) => (c / 100).toFixed(2);

export class CreditNotesService {
  constructor() {
    this.prisma = getPrismaClient();
  }

  /** How many of each line were already returned, and the amounts returned so far. */
  returnedSoFar(notes) {
    const byItem = new Map();
    for (const n of notes) {
      for (const i of n.items) {
        const r = byItem.get(i.orderItemId) ?? { quantity: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
        r.quantity += i.quantity;
        r.taxable += cents(i.taxableValue);
        r.cgst += cents(i.cgst);
        r.sgst += cents(i.sgst);
        r.igst += cents(i.igst);
        byItem.set(i.orderItemId, r);
      }
    }
    return byItem;
  }

  async listForOrder(tenantId, orderId) {
    return this.prisma.creditNote.findMany({ where: { tenantId, orderId }, orderBy: { createdAt: 'asc' } });
  }

  async list(tenantId, { page = 1, limit = 20, customerId } = {}) {
    const where = { tenantId, ...(customerId ? { customerId } : {}) };
    const [data, total] = await Promise.all([
      this.prisma.creditNote.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit, include: { order: { select: { invoiceNumber: true, buyerSnapshot: true } } } }),
      this.prisma.creditNote.count({ where }),
    ]);
    return { data, meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
  }

  async get(tenantId, id) {
    const note = await this.prisma.creditNote.findFirst({
      where: { id, tenantId },
      include: { order: { select: { id: true, invoiceNumber: true, invoiceDate: true, createdAt: true, currency: true, placeOfSupply: true, supplyType: true, buyerSnapshot: true, sellerSnapshot: true, billingAddress: true, shippingAddress: true } } },
    });
    if (!note) throw new AppError('Credit note not found', { statusCode: 404, code: 'CREDIT_NOTE_NOT_FOUND' });
    return note;
  }

  async create(tenantId, userId, orderId, { items, reason, refundMethod = 'CREDIT', registerId }, ctx = {}) {
    const preview = await this.prisma.order.findFirst({ where: { id: orderId, tenantId, deletedAt: null }, select: { id: true } });
    if (!preview) throw new AppError('Order not found', { statusCode: 404, code: 'ORDER_NOT_FOUND' });

    let session = null;
    if (refundMethod === 'CASH') {
      const regId = registerId ?? (await cashRegisterService.ensureDefault(tenantId)).id;
      session = await cashRegisterService.openSessionFor(tenantId, regId);
      if (!session) throw new AppError('Open the cash register before paying cash back', { statusCode: 409, code: 'REGISTER_CLOSED' });
    }
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } });
    const { taxProfile } = await resolveOrderDefaults(this.prisma, tenantId);

    const result = await this.prisma.$transaction(async (tx) => {
      // One return at a time per order
      await tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${orderId} AND "tenant_id" = ${tenantId} FOR UPDATE`;
      const order = await tx.order.findFirst({ where: { id: orderId, tenantId }, include: { items: true } });
      if (!RETURNABLE.includes(order.status)) {
        throw new AppError(order.status === 'PENDING' ? 'Cancel the order instead: it has not been confirmed yet' : `Nothing can be returned on a ${order.status.toLowerCase()} order`, { statusCode: 409, code: 'ORDER_NOT_RETURNABLE' });
      }
      const already = this.returnedSoFar(await tx.creditNote.findMany({ where: { tenantId, orderId } }));
      const lines = [];
      for (const req of items) {
        const item = order.items.find((i) => i.id === req.orderItemId);
        if (!item) throw new AppError('That line is not on this invoice', { statusCode: 404, code: 'ORDER_ITEM_NOT_FOUND' });
        const done = already.get(item.id) ?? { quantity: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
        const remaining = item.quantity - done.quantity;
        if (req.quantity > remaining) {
          throw new AppError(`Only ${remaining} of ${item.productNameSnapshot} can still be returned`, { statusCode: 409, code: 'RETURN_EXCEEDS_SOLD', details: { orderItemId: item.id, remaining } });
        }
        // Per-unit share of what the invoice charged; the last units take the remainder
        const part = (total, sofar) => (req.quantity === remaining ? total - sofar : Math.round(((total - sofar) * req.quantity) / remaining));
        const taxable = part(cents(item.taxableValue), done.taxable);
        const cgst = part(cents(item.cgst), done.cgst);
        const sgst = part(cents(item.sgst), done.sgst);
        const igst = part(cents(item.igst), done.igst);
        lines.push({ item, quantity: req.quantity, restock: req.restock !== false, taxable, cgst, sgst, igst, tax: cgst + sgst + igst });
      }

      // Goods back on the shelf they left from
      for (const l of lines.filter((x) => x.restock)) {
        const left = await tx.inventoryMovement.findFirst({ where: { tenantId, productVariantId: l.item.productVariantId, referenceType: 'ORDER', referenceId: orderId, type: 'ORDER_RESERVATION' } });
        const warehouseId = left?.warehouseId ?? (await tx.warehouse.findFirst({ where: { tenantId, isActive: true }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] }))?.id;
        if (!warehouseId) continue;
        await tx.$queryRaw`SELECT "quantity" FROM "inventory" WHERE "tenant_id" = ${tenantId} AND "product_variant_id" = ${l.item.productVariantId} AND "warehouse_id" = ${warehouseId} FOR UPDATE`;
        const inv = await tx.inventory.findFirst({ where: { tenantId, productVariantId: l.item.productVariantId, warehouseId } });
        const before = inv?.quantity ?? 0;
        const after = before + l.quantity;
        if (inv) await tx.inventory.update({ where: { id: inv.id }, data: { quantity: after } });
        else await tx.inventory.create({ data: { tenantId, productVariantId: l.item.productVariantId, warehouseId, quantity: after } });
        await tx.$executeRaw`INSERT INTO "warehouse_inventory" ("id", "tenant_id", "warehouse_id", "product_variant_id", "quantity", "reserved_quantity", "created_at", "updated_at") VALUES (gen_random_uuid(), ${tenantId}, ${warehouseId}, ${l.item.productVariantId}, ${after}, 0, NOW(), NOW()) ON CONFLICT ("tenant_id", "warehouse_id", "product_variant_id") DO UPDATE SET "quantity" = ${after}, "updated_at" = NOW()`;
        l.warehouseId = warehouseId;
        l.movement = { before, after };
      }

      const totals = lines.reduce((t, l) => ({ taxable: t.taxable + l.taxable, cgst: t.cgst + l.cgst, sgst: t.sgst + l.sgst, igst: t.igst + l.igst }), { taxable: 0, cgst: 0, sgst: 0, igst: 0 });
      const taxTotal = totals.cgst + totals.sgst + totals.igst;
      const totalCents = totals.taxable + taxTotal;
      const number = await nextDocumentNumber(tx, tenantId, 'CREDIT_NOTE', { taxProfile, slug: tenant?.slug });

      // Money back can't exceed what was actually paid on this invoice
      const [due] = await receivablesService.invoiceDues(tenantId, { orderIds: [orderId] }, tx);
      const netPaid = cents(due?.paid);
      const refundCents = refundMethod === 'CREDIT' ? 0 : Math.min(totalCents, Math.max(0, netPaid));
      if (refundMethod !== 'CREDIT' && refundCents === 0) {
        throw new AppError('Nothing was paid on this invoice; keep the return as credit instead', { statusCode: 409, code: 'NOTHING_TO_REFUND' });
      }

      const note = await tx.creditNote.create({
        data: {
          tenantId, number, orderId, customerId: order.customerId, reason: reason ?? null, refundMethod,
          items: lines.map((l) => ({
            orderItemId: l.item.id, productVariantId: l.item.productVariantId, productName: l.item.productNameSnapshot, sku: l.item.skuSnapshot, hsnCode: l.item.hsnCode,
            quantity: l.quantity, unitPrice: l.item.unitPrice.toString(), gstRatePercent: Number(l.item.gstRatePercent), restocked: Boolean(l.warehouseId), warehouseId: l.warehouseId ?? null,
            taxableValue: money(l.taxable), cgst: money(l.cgst), sgst: money(l.sgst), igst: money(l.igst), tax: money(l.tax), total: money(l.taxable + l.tax),
          })),
          taxableTotal: money(totals.taxable), taxTotal: money(taxTotal), cgstTotal: money(totals.cgst), sgstTotal: money(totals.sgst), igstTotal: money(totals.igst),
          total: money(totalCents), refundedAmount: money(refundCents), createdBy: userId,
        },
      });
      for (const l of lines.filter((x) => x.movement)) {
        await tx.inventoryMovement.create({
          data: {
            tenantId, productVariantId: l.item.productVariantId, warehouseId: l.warehouseId, type: 'RETURN',
            quantityBefore: l.movement.before, quantityChanged: l.quantity, quantityAfter: l.movement.after,
            reason: `Returned (${number})`, referenceType: 'CREDIT_NOTE', referenceId: note.id, createdBy: userId,
          },
        });
      }

      // CASH and local ORIGINAL refunds are recorded here; Razorpay ones are sent after the commit
      const razorpayRefunds = [];
      if (refundCents > 0) {
        let left = refundCents;
        const payments = await tx.payment.findMany({ where: { tenantId, orderId, deletedAt: null, status: { in: ['COMPLETED', 'PARTIALLY_REFUNDED'] } }, include: { refunds: { where: { status: 'COMPLETED' } } }, orderBy: { createdAt: 'desc' } });
        for (const p of payments) {
          if (left <= 0) break;
          const refundable = cents(p.amount) - p.refunds.reduce((n, r) => n + cents(r.amount), 0);
          const take = Math.min(refundable, left);
          if (take <= 0) continue;
          left -= take;
          if (refundMethod === 'ORIGINAL' && p.provider === 'razorpay') {
            razorpayRefunds.push({ paymentId: p.id, amount: money(take) });
            continue;
          }
          await this.recordRefund(tx, { tenantId, payment: p, amountCents: take, refundedBefore: cents(p.amount) - refundable, method: refundMethod, creditNoteId: note.id, userId });
        }
        if (refundMethod === 'CASH') {
          await tx.cashMovement.create({ data: { tenantId, sessionId: session.id, type: 'REFUND', amount: money(refundCents), reason: `Return ${number}`, orderId, createdBy: userId } });
        }
      }

      // Order status: everything returned → REFUNDED, otherwise PARTIALLY_REFUNDED (only after delivery)
      const allBack = order.items.every((i) => (already.get(i.id)?.quantity ?? 0) + (lines.find((l) => l.item.id === i.id)?.quantity ?? 0) >= i.quantity);
      const nextStatus = allBack ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
      if (['DELIVERED', 'PARTIALLY_REFUNDED'].includes(order.status) && order.status !== nextStatus) {
        await tx.order.update({ where: { id: orderId }, data: { status: nextStatus } });
        await tx.orderStatusHistory.create({ data: { tenantId, orderId, fromStatus: order.status, toStatus: nextStatus, reason: `Return ${number}`, createdBy: userId } });
      }

      await auditService.logAudit({ tenantId, userId, action: 'CREATE', resource: 'credit_note', resourceId: note.id, oldValue: null, newValue: { number, orderId, total: money(totalCents), refundMethod, refunded: money(refundCents) }, ipAddress: ctx.ipAddress ?? null, userAgent: ctx.userAgent ?? null, tx });
      await auditService.logActivity({ tenantId, userId, action: 'order.return', description: `Return ${number} on ${order.invoiceNumber ?? orderId}: ₹${note.total}${refundCents ? `, ₹${money(refundCents)} refunded (${refundMethod.toLowerCase()})` : ', kept as credit'}`, metadata: { orderId, creditNoteId: note.id }, ipAddress: ctx.ipAddress ?? null, userAgent: ctx.userAgent ?? null, tx });
      return { note, razorpayRefunds };
    });

    // Razorpay refunds talk to Razorpay, so they run after the return is saved; a failure is reported, not lost
    const refundErrors = [];
    for (const r of result.razorpayRefunds) {
      try {
        const { PaymentService } = await import('../payments/payments.service.js');
        await new PaymentService().refund(tenantId, userId, r.paymentId, { amount: r.amount, reason: `Return ${result.note.number}`, metadata: { creditNoteId: result.note.id } });
      } catch (err) {
        refundErrors.push({ paymentId: r.paymentId, amount: r.amount, message: err.message });
      }
    }
    return { creditNote: await this.get(tenantId, result.note.id), refundErrors };
  }

  /** A refund recorded on a payment taken at the counter or by hand (no provider call). */
  async recordRefund(tx, { tenantId, payment, amountCents, refundedBefore, method, creditNoteId, userId }) {
    await tx.$queryRaw`SELECT "id" FROM "payments" WHERE "id" = ${payment.id} AND "tenant_id" = ${tenantId} FOR UPDATE`;
    const providerRefundId = `ref_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const refund = await tx.refund.create({
      data: { tenantId, paymentId: payment.id, amount: money(amountCents), currency: payment.currency, status: 'COMPLETED', reason: 'Sales return', providerRefundId, metadata: { creditNoteId, method } },
    });
    await tx.paymentTransaction.create({
      data: { tenantId, paymentId: payment.id, type: 'REFUND', amount: money(amountCents), currency: payment.currency, status: 'COMPLETED', providerTransactionId: `txn_ref_${providerRefundId}`, metadata: { refundId: refund.id, refundedBy: userId, creditNoteId } },
    });
    const status = refundedBefore + amountCents >= cents(payment.amount) ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    await tx.payment.update({ where: { id: payment.id }, data: { status } });
  }
}

export const creditNotesService = new CreditNotesService();
