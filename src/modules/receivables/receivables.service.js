import crypto from 'node:crypto';
import { getPrismaClient } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import { auditService } from '../audit/audit.service.js';
import { emitPaymentCompleted } from '../../realtime/realtime.service.js';
import { paymentGatewayService } from '../payments/payment-gateway.service.js';
import * as razorpay from '../../integrations/payment/razorpay.client.js';
import { cashRegisterService } from '../pos/cash-register.service.js';

/**
 * Phase 40: what customers owe.
 * For each invoice (order that isn't cancelled): due = total − credit notes − (payments taken − refunds given).
 * A customer's balance is the sum over their invoices; negative means the shop owes them (credit on account).
 * Payments received against the account settle the oldest unpaid invoices first.
 */
export const PAID_STATUSES = ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'];
export const RECEIPT_METHODS = ['CASH', 'UPI', 'CARD', 'BANK', 'CHEQUE'];
const AGING = [
  { key: 'current', label: '0–30 days', max: 30 },
  { key: 'days31to60', label: '31–60 days', max: 60 },
  { key: 'days61to90', label: '61–90 days', max: 90 },
  { key: 'over90', label: 'Over 90 days', max: Infinity },
];

const cents = (v) => Math.round(Number(v ?? 0) * 100);
const money = (c) => (c / 100).toFixed(2);
const daysSince = (date) => Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 86400000));

export class ReceivablesService {
  constructor() {
    this.prisma = getPrismaClient();
  }

  /** Per invoice: total, credited, paid (net of refunds) and due — for one customer or the whole workspace. */
  async invoiceDues(tenantId, { customerId = null, orderIds = null } = {}, tx = this.prisma) {
    const rows = await tx.$queryRaw`
      WITH paid AS (
        SELECT "order_id", SUM("amount") AS amt FROM "payments"
        WHERE "tenant_id" = ${tenantId} AND "deleted_at" IS NULL AND "status"::text = ANY(${PAID_STATUSES}) GROUP BY "order_id"
      ), refunded AS (
        SELECT p."order_id", SUM(r."amount") AS amt FROM "refunds" r JOIN "payments" p ON p."id" = r."payment_id"
        WHERE r."tenant_id" = ${tenantId} AND r."status" = 'COMPLETED' GROUP BY p."order_id"
      ), credited AS (
        SELECT "order_id", SUM("total") AS amt FROM "credit_notes" WHERE "tenant_id" = ${tenantId} GROUP BY "order_id"
      )
      SELECT o."id", o."customer_id" AS "customerId", o."invoice_number" AS "invoiceNumber", o."status"::text AS "status", o."channel",
             o."created_at" AS "createdAt", o."total"::text AS "total",
             COALESCE(credited.amt, 0)::text AS "credited",
             (COALESCE(paid.amt, 0) - COALESCE(refunded.amt, 0))::text AS "paid"
      FROM "orders" o
      LEFT JOIN paid ON paid."order_id" = o."id"
      LEFT JOIN refunded ON refunded."order_id" = o."id"
      LEFT JOIN credited ON credited."order_id" = o."id"
      WHERE o."tenant_id" = ${tenantId} AND o."deleted_at" IS NULL AND o."status"::text NOT IN ('CANCELLED', 'DRAFT')
        AND (${customerId}::text IS NULL OR o."customer_id" = ${customerId})
        AND (${orderIds}::text[] IS NULL OR o."id" = ANY(${orderIds}::text[]))
      ORDER BY o."created_at" ASC`;
    return rows.map((r) => {
      const due = cents(r.total) - cents(r.credited) - cents(r.paid);
      return { ...r, total: money(cents(r.total)), credited: money(cents(r.credited)), paid: money(cents(r.paid)), due: money(due), dueCents: due };
    });
  }

  async customerFor(tenantId, customerId) {
    const customer = await this.prisma.customer.findFirst({ where: { id: customerId, tenantId, deletedAt: null }, omit: { passwordHash: true } });
    if (!customer) throw new AppError('Customer not found', { statusCode: 404, code: 'CUSTOMER_NOT_FOUND' });
    return customer;
  }

  /** Balance and the invoices that still have money owing (or overpaid). */
  async balance(tenantId, customerId) {
    await this.customerFor(tenantId, customerId);
    const dues = await this.invoiceDues(tenantId, { customerId });
    const sum = (k) => dues.reduce((n, d) => n + cents(d[k]), 0);
    const outstanding = dues.reduce((n, d) => n + d.dueCents, 0);
    return {
      customerId,
      billed: money(sum('total')),
      credited: money(sum('credited')),
      paid: money(sum('paid')),
      outstanding: money(outstanding),
      invoices: dues.filter((d) => d.dueCents !== 0).map(({ dueCents: _cents, customerId: _c, ...d }) => ({ ...d, ageDays: daysSince(d.createdAt) })),
    };
  }

  /** Every invoice, payment, refund and credit note for the customer with a running balance. */
  async statement(tenantId, customerId, { from, to } = {}) {
    const customer = await this.customerFor(tenantId, customerId);
    const orders = await this.prisma.order.findMany({
      where: { tenantId, customerId, deletedAt: null, status: { notIn: ['CANCELLED', 'DRAFT'] } },
      select: { id: true, invoiceNumber: true, total: true, createdAt: true },
    });
    const orderIds = orders.map((o) => o.id);
    const [payments, refunds, notes] = await Promise.all([
      this.prisma.payment.findMany({ where: { tenantId, orderId: { in: orderIds }, deletedAt: null, status: { in: PAID_STATUSES } }, select: { id: true, orderId: true, amount: true, provider: true, metadata: true, createdAt: true } }),
      this.prisma.refund.findMany({ where: { tenantId, status: 'COMPLETED', payment: { orderId: { in: orderIds } } }, select: { id: true, amount: true, createdAt: true, payment: { select: { orderId: true } } } }),
      this.prisma.creditNote.findMany({ where: { tenantId, orderId: { in: orderIds } }, select: { id: true, number: true, orderId: true, total: true, createdAt: true } }),
    ]);
    const invoiceNo = new Map(orders.map((o) => [o.id, o.invoiceNumber]));
    const entries = [
      ...orders.map((o) => ({ date: o.createdAt, type: 'INVOICE', reference: o.invoiceNumber, orderId: o.id, debit: cents(o.total), credit: 0 })),
      ...payments.map((p) => ({ date: p.createdAt, type: 'PAYMENT', reference: `${(p.metadata?.method ?? p.provider ?? '').toString().toUpperCase()} · ${invoiceNo.get(p.orderId) ?? ''}`.trim(), orderId: p.orderId, debit: 0, credit: cents(p.amount) })),
      ...refunds.map((r) => ({ date: r.createdAt, type: 'REFUND', reference: invoiceNo.get(r.payment.orderId) ?? null, orderId: r.payment.orderId, debit: cents(r.amount), credit: 0 })),
      ...notes.map((n) => ({ date: n.createdAt, type: 'CREDIT_NOTE', reference: n.number, orderId: n.orderId, debit: 0, credit: cents(n.total) })),
    ].sort((a, b) => new Date(a.date) - new Date(b.date) || (a.type === 'INVOICE' ? -1 : 1));

    const fromDate = from ? new Date(`${from}T00:00:00+05:30`) : null;
    const toDate = to ? new Date(`${to}T23:59:59.999+05:30`) : null;
    let running = 0;
    let opening = 0;
    const lines = [];
    for (const e of entries) {
      if (toDate && new Date(e.date) > toDate) break;
      running += e.debit - e.credit;
      if (fromDate && new Date(e.date) < fromDate) {
        opening = running;
        continue;
      }
      lines.push({ ...e, debit: money(e.debit), credit: money(e.credit), balance: money(running) });
    }
    return {
      customer: { id: customer.id, name: customer.companyName || `${customer.firstName} ${customer.lastName}`.trim(), email: customer.email, gstin: customer.gstin ?? null },
      from: from ?? null,
      to: to ?? null,
      openingBalance: money(opening),
      closingBalance: money(running),
      lines,
    };
  }

  /** Customers who owe money, with ageing (by invoice date). */
  async receivables(tenantId) {
    const dues = (await this.invoiceDues(tenantId)).filter((d) => d.dueCents > 0);
    const byCustomer = new Map();
    for (const d of dues) {
      const row = byCustomer.get(d.customerId) ?? { customerId: d.customerId, outstanding: 0, invoices: 0, oldestInvoiceAt: d.createdAt, aging: Object.fromEntries(AGING.map((a) => [a.key, 0])) };
      row.outstanding += d.dueCents;
      row.invoices += 1;
      if (new Date(d.createdAt) < new Date(row.oldestInvoiceAt)) row.oldestInvoiceAt = d.createdAt;
      const bucket = AGING.find((a) => daysSince(d.createdAt) <= a.max);
      row.aging[bucket.key] += d.dueCents;
      byCustomer.set(d.customerId, row);
    }
    const customers = await this.prisma.customer.findMany({ where: { tenantId, id: { in: [...byCustomer.keys()] } }, select: { id: true, firstName: true, lastName: true, companyName: true, email: true, phone: true, gstin: true } });
    const names = new Map(customers.map((c) => [c.id, c]));
    const rows = [...byCustomer.values()]
      .sort((a, b) => b.outstanding - a.outstanding)
      .map((r) => {
        const c = names.get(r.customerId);
        return {
          ...r,
          name: c?.companyName || `${c?.firstName ?? ''} ${c?.lastName ?? ''}`.trim(),
          email: c?.email ?? null,
          phone: c?.phone ?? null,
          gstin: c?.gstin ?? null,
          outstanding: money(r.outstanding),
          aging: Object.fromEntries(Object.entries(r.aging).map(([k, v]) => [k, money(v)])),
        };
      });
    const totals = Object.fromEntries(AGING.map((a) => [a.key, money(rows.reduce((n, r) => n + cents(r.aging[a.key]), 0))]));
    return { total: money(rows.reduce((n, r) => n + cents(r.outstanding), 0)), totals, buckets: AGING.map(({ key, label }) => ({ key, label })), customers: rows };
  }

  /**
   * Money received from a customer against their account: settles the oldest invoices first (one payment record
   * per invoice). Cash lands in the open register shift.
   */
  async receivePayment(tenantId, userId, customerId, { amount, method, reference, registerId, note }, ctx = {}) {
    await this.customerFor(tenantId, customerId);
    let amountCents = cents(amount);
    let session = null;
    if (method === 'CASH') {
      const regId = registerId ?? (await cashRegisterService.ensureDefault(tenantId)).id;
      session = await cashRegisterService.openSessionFor(tenantId, regId);
      if (!session) throw new AppError('Open the cash register before taking cash', { statusCode: 409, code: 'REGISTER_CLOSED' });
    }
    const created = await this.prisma.$transaction(async (tx) => {
      // One receipt at a time per customer, so two clerks can't settle the same invoice twice
      await tx.$queryRaw`SELECT "id" FROM "customers" WHERE "id" = ${customerId} AND "tenant_id" = ${tenantId} FOR UPDATE`;
      const open = (await this.invoiceDues(tenantId, { customerId }, tx)).filter((d) => d.dueCents > 0);
      const outstanding = open.reduce((n, d) => n + d.dueCents, 0);
      if (outstanding === 0) throw new AppError('This customer owes nothing', { statusCode: 409, code: 'NOTHING_DUE' });
      if (amountCents > outstanding) {
        throw new AppError(`That's more than the ₹${money(outstanding)} owed`, { statusCode: 400, code: 'PAYMENT_EXCEEDS_DUE', details: { outstanding: money(outstanding) } });
      }
      const payments = [];
      for (const inv of open) {
        if (amountCents <= 0) break;
        const take = Math.min(inv.dueCents, amountCents);
        amountCents -= take;
        const payment = await tx.payment.create({
          data: {
            tenantId, orderId: inv.id, amount: money(take), currency: 'INR', status: 'COMPLETED', provider: method.toLowerCase(),
            providerPaymentId: `rcpt_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
            metadata: { channel: 'ACCOUNT', method, reference: reference ?? null, note: note ?? null },
          },
        });
        await tx.paymentTransaction.create({
          data: {
            tenantId, paymentId: payment.id, type: 'CHARGE', amount: payment.amount.toString(), currency: payment.currency, status: 'COMPLETED',
            providerTransactionId: `txn_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`, metadata: { receivedBy: userId, channel: 'ACCOUNT' },
          },
        });
        if (session) await cashRegisterService.recordSale(tx, { tenantId, sessionId: session.id, amount: payment.amount, orderId: inv.id, paymentId: payment.id, userId });
        payments.push({ ...payment, invoiceNumber: inv.invoiceNumber });
      }
      await auditService.logAudit({ tenantId, userId, action: 'CREATE', resource: 'payment', resourceId: customerId, oldValue: null, newValue: { amount, method, invoices: payments.map((p) => p.invoiceNumber) }, ipAddress: ctx.ipAddress ?? null, userAgent: ctx.userAgent ?? null, tx });
      await auditService.logActivity({ tenantId, userId, action: 'customer.payment', description: `₹${Number(amount).toFixed(2)} received (${method}) against ${payments.length} invoice${payments.length === 1 ? '' : 's'}`, metadata: { customerId }, ipAddress: ctx.ipAddress ?? null, userAgent: ctx.userAgent ?? null, tx });
      return payments;
    });
    for (const p of created) {
      try {
        emitPaymentCompleted(tenantId, { id: p.id, tenantId, orderId: p.orderId, amount: p.amount.toString(), currency: p.currency, status: p.status, providerPaymentId: p.providerPaymentId });
      } catch (_e) { void _e; }
    }
    return { payments: created.map((p) => ({ id: p.id, orderId: p.orderId, invoiceNumber: p.invoiceNumber, amount: p.amount })), balance: await this.balance(tenantId, customerId) };
  }

  /**
   * A Razorpay payment link for what is still due on an invoice, sent to the customer by email/SMS. Paid links are
   * confirmed by Razorpay's `payment_link.paid` webhook. Asking again for the same amount reuses the open link.
   */
  async paymentLink(tenantId, userId, orderId, { notify = true } = {}) {
    const credentials = await paymentGatewayService.credentialsFor(tenantId);
    if (!credentials) throw new AppError('Connect Razorpay in Settings to send payment links', { statusCode: 409, code: 'PAYMENT_GATEWAY_NOT_CONFIGURED' });
    const order = await this.prisma.order.findFirst({ where: { id: orderId, tenantId, deletedAt: null }, include: { customer: true } });
    if (!order) throw new AppError('Order not found', { statusCode: 404, code: 'ORDER_NOT_FOUND' });
    const [due] = await this.invoiceDues(tenantId, { orderIds: [orderId] });
    if (!due || due.dueCents <= 0) throw new AppError('Nothing is due on this invoice', { statusCode: 409, code: 'NOTHING_DUE' });

    const pending = await this.prisma.payment.findMany({ where: { tenantId, orderId, provider: 'razorpay', status: 'PENDING', deletedAt: null } });
    const open = pending.find((p) => p.metadata?.paymentLinkId);
    if (open && open.metadata?.amountMinor === due.dueCents) return { paymentId: open.id, url: open.metadata.shortUrl, amount: money(due.dueCents), reused: true };

    return this.prisma.$transaction(async (tx) => {
      if (open) await tx.payment.update({ where: { id: open.id }, data: { status: 'CANCELLED' } });
      const payment = await tx.payment.create({
        data: { tenantId, orderId, amount: money(due.dueCents), currency: order.currency || 'INR', status: 'PENDING', provider: 'razorpay', providerPaymentId: `plink_pending_${crypto.randomUUID()}`, metadata: { amountMinor: due.dueCents, channel: 'PAYMENT_LINK' } },
      });
      const c = order.customer;
      const link = await razorpay.createPaymentLink(credentials, {
        amountMinor: due.dueCents,
        currency: order.currency || 'INR',
        description: `Invoice ${order.invoiceNumber ?? order.id.slice(0, 8).toUpperCase()}`,
        referenceId: payment.id,
        customer: { name: c.companyName || `${c.firstName} ${c.lastName}`.trim(), email: c.metadata?.walkIn ? undefined : c.email, contact: c.phone || undefined },
        notify: { email: notify && !c.metadata?.walkIn, sms: notify && Boolean(c.phone) },
        notes: { tenantId, orderId },
      });
      const updated = await tx.payment.update({
        where: { id: payment.id },
        data: { providerPaymentId: link.id, metadata: { ...payment.metadata, paymentLinkId: link.id, shortUrl: link.short_url, keyId: credentials.keyId, createdBy: userId } },
      });
      return { paymentId: updated.id, url: link.short_url, amount: money(due.dueCents), reused: false };
    }, { timeout: 30000, maxWait: 10000 });
  }
}

export const receivablesService = new ReceivablesService();
