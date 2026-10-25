import { getPrismaClient } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import { logger } from '../../config/logger.js';
import { auditService } from '../audit/audit.service.js';
import { OrderService } from '../orders/orders.service.js';
import { receivablesService } from '../receivables/receivables.service.js';
import { paymentGatewayService } from '../payments/payment-gateway.service.js';

/**
 * Phase 40: recurring invoices. Each schedule bills the same items to the same customer every week, month,
 * quarter or year. An hourly job raises the invoices that are due (dates are Indian dates), optionally sends a
 * Razorpay payment link for each, and moves the schedule to its next date; month ends are kept (31 Jan → 28 Feb
 * → 31 Mar). A failed run keeps its date and is retried next hour, with the reason shown on the schedule.
 */
export const FREQUENCIES = ['WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY'];
const MONTHS = { MONTHLY: 1, QUARTERLY: 3, YEARLY: 12 };

/** Today's date in India as YYYY-MM-DD. */
export const todayInIndia = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now);
const iso = (d) => d.toISOString().slice(0, 10);
const asDate = (s) => new Date(`${s}T00:00:00Z`);

/** The run after `from`, anchored to the start date's day of the month so month ends don't drift. */
export function nextRunDate(from, frequency, anchorDay) {
  const d = asDate(from);
  if (frequency === 'WEEKLY') return iso(new Date(d.getTime() + 7 * 86400000));
  const months = MONTHS[frequency];
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(anchorDay, lastDay));
  return iso(target);
}

const notFound = () => new AppError('Recurring invoice not found', { statusCode: 404, code: 'RECURRING_INVOICE_NOT_FOUND' });

export class RecurringInvoicesService {
  constructor() {
    this.prisma = getPrismaClient();
    this.orders = new OrderService();
  }

  async log(tx, ctx, { tenantId, action, resourceId, oldValue = null, newValue, activity, description }) {
    await auditService.logAudit({ tenantId, userId: ctx.userId ?? null, action, resource: 'recurring_invoice', resourceId, oldValue, newValue, ipAddress: ctx.ipAddress ?? null, userAgent: ctx.userAgent ?? null, tx });
    await auditService.logActivity({ tenantId, userId: ctx.userId ?? null, action: activity, description, metadata: { recurringInvoiceId: resourceId }, ipAddress: ctx.ipAddress ?? null, userAgent: ctx.userAgent ?? null, tx });
  }

  async checkRefs(tenantId, { customerId, items, warehouseId, sendPaymentLink }) {
    if (customerId && !(await this.prisma.customer.findFirst({ where: { id: customerId, tenantId, deletedAt: null } }))) {
      throw new AppError('Customer not found', { statusCode: 404, code: 'CUSTOMER_NOT_FOUND' });
    }
    if (items) {
      const ids = [...new Set(items.map((i) => i.variantId))];
      const found = await this.prisma.productVariant.count({ where: { id: { in: ids }, tenantId, deletedAt: null } });
      if (found !== ids.length) throw new AppError('One of the items no longer exists', { statusCode: 404, code: 'VARIANT_NOT_FOUND' });
    }
    if (warehouseId && !(await this.prisma.warehouse.findFirst({ where: { id: warehouseId, tenantId } }))) {
      throw new AppError('Warehouse not found', { statusCode: 404, code: 'WAREHOUSE_NOT_FOUND' });
    }
    if (sendPaymentLink && !(await paymentGatewayService.credentialsFor(tenantId))) {
      throw new AppError('Connect Razorpay in Settings to send payment links', { statusCode: 409, code: 'PAYMENT_GATEWAY_NOT_CONFIGURED' });
    }
  }

  async create(tenantId, body, ctx = {}) {
    await this.checkRefs(tenantId, body);
    const startOn = body.startOn ?? todayInIndia();
    if (body.endOn && body.endOn < startOn) throw new AppError('The end date is before the start date', { statusCode: 400, code: 'INVALID_DATE_RANGE' });
    return this.prisma.$transaction(async (tx) => {
      const r = await tx.recurringInvoice.create({
        data: {
          tenantId, customerId: body.customerId, name: body.name, items: body.items, warehouseId: body.warehouseId ?? null,
          frequency: body.frequency, startOn: asDate(startOn), nextRunOn: asDate(startOn), endOn: body.endOn ? asDate(body.endOn) : null,
          sendPaymentLink: Boolean(body.sendPaymentLink), createdBy: ctx.userId ?? null,
        },
        include: { customer: { select: { id: true, firstName: true, lastName: true, companyName: true, email: true } } },
      });
      await this.log(tx, ctx, { tenantId, action: 'CREATE', resourceId: r.id, newValue: { name: r.name, frequency: r.frequency, startOn }, activity: 'recurring_invoice.create', description: `Recurring invoice "${r.name}" (${r.frequency.toLowerCase()}) from ${startOn}` });
      return r;
    });
  }

  async list(tenantId, { page = 1, limit = 20, status, customerId } = {}) {
    const where = { tenantId, ...(status ? { status } : {}), ...(customerId ? { customerId } : {}) };
    const [data, total] = await Promise.all([
      this.prisma.recurringInvoice.findMany({ where, orderBy: [{ status: 'asc' }, { nextRunOn: 'asc' }], skip: (page - 1) * limit, take: limit, include: { customer: { select: { id: true, firstName: true, lastName: true, companyName: true, email: true } } } }),
      this.prisma.recurringInvoice.count({ where }),
    ]);
    return { data, meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
  }

  async get(tenantId, id) {
    const r = await this.prisma.recurringInvoice.findFirst({ where: { id, tenantId }, include: { customer: { select: { id: true, firstName: true, lastName: true, companyName: true, email: true } } } });
    if (!r) throw notFound();
    const runs = await this.prisma.order.findMany({ where: { tenantId, metadata: { path: ['recurringInvoiceId'], equals: id } }, orderBy: { createdAt: 'desc' }, take: 24, select: { id: true, invoiceNumber: true, total: true, status: true, createdAt: true } });
    return { ...r, runs };
  }

  /** Pause, resume, or change items/frequency/end date/payment links. */
  async update(tenantId, id, body, ctx = {}) {
    const r = await this.get(tenantId, id);
    if (r.status === 'ENDED') throw new AppError('This schedule has ended', { statusCode: 409, code: 'RECURRING_INVOICE_ENDED' });
    await this.checkRefs(tenantId, body);
    const data = {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.items !== undefined ? { items: body.items } : {}),
      ...(body.warehouseId !== undefined ? { warehouseId: body.warehouseId } : {}),
      ...(body.frequency !== undefined ? { frequency: body.frequency } : {}),
      ...(body.endOn !== undefined ? { endOn: body.endOn ? asDate(body.endOn) : null } : {}),
      ...(body.sendPaymentLink !== undefined ? { sendPaymentLink: body.sendPaymentLink } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
    };
    // Resuming after a pause doesn't bill the missed periods: the next run is today or later
    if (body.status === 'ACTIVE' && r.status === 'PAUSED' && iso(r.nextRunOn) < todayInIndia()) data.nextRunOn = asDate(todayInIndia());
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.recurringInvoice.update({ where: { id }, data, include: { customer: { select: { id: true, firstName: true, lastName: true, companyName: true, email: true } } } });
      await this.log(tx, ctx, { tenantId, action: 'UPDATE', resourceId: id, oldValue: { status: r.status }, newValue: body, activity: 'recurring_invoice.update', description: `Recurring invoice "${r.name}" ${body.status === 'PAUSED' ? 'paused' : body.status === 'ACTIVE' ? 'resumed' : 'updated'}` });
      return updated;
    });
  }

  async remove(tenantId, id, ctx = {}) {
    const r = await this.get(tenantId, id);
    await this.prisma.$transaction(async (tx) => {
      await tx.recurringInvoice.delete({ where: { id } });
      await this.log(tx, ctx, { tenantId, action: 'DELETE', resourceId: id, oldValue: { name: r.name }, newValue: null, activity: 'recurring_invoice.delete', description: `Recurring invoice "${r.name}" deleted (invoices already raised are kept)` });
    });
  }

  /** Raise one invoice for a schedule now and move it to its next date. */
  async runOne(r, { userId = null, manual = false } = {}) {
    const warehouse = r.warehouseId
      ? { id: r.warehouseId }
      : await this.prisma.warehouse.findFirst({ where: { tenantId: r.tenantId, isActive: true }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] });
    try {
      if (!warehouse) throw new AppError('Add a warehouse first', { statusCode: 409, code: 'NO_WAREHOUSE' });
      const order = await this.orders.create(r.tenantId, userId, {
        customerId: r.customerId,
        items: r.items.map((i) => ({ productVariantId: i.variantId, warehouseId: warehouse.id, quantity: i.quantity, discount: i.discount })),
        metadata: { recurringInvoiceId: r.id, recurringName: r.name },
      }, { userId });
      let paymentLink = null;
      if (r.sendPaymentLink) {
        try {
          paymentLink = await receivablesService.paymentLink(r.tenantId, userId, order.id, { notify: true });
        } catch (err) {
          logger.warn({ err: err?.message, recurringInvoiceId: r.id, orderId: order.id }, 'Recurring invoice raised but the payment link could not be sent');
        }
      }
      const runDate = iso(r.nextRunOn);
      const next = nextRunDate(runDate, r.frequency, asDate(iso(r.startOn)).getUTCDate());
      // "Bill now" for a period that is already due counts as that period; billing ahead of time keeps the date
      const advance = !manual || runDate <= todayInIndia();
      const ended = advance && r.endOn && next > iso(r.endOn);
      await this.prisma.recurringInvoice.update({
        where: { id: r.id },
        data: { nextRunOn: advance ? asDate(next) : r.nextRunOn, runsCount: { increment: 1 }, lastRunAt: new Date(), lastOrderId: order.id, lastError: null, ...(ended ? { status: 'ENDED' } : {}) },
      });
      return { ok: true, orderId: order.id, invoiceNumber: order.invoiceNumber, paymentLink: paymentLink?.url ?? null };
    } catch (err) {
      await this.prisma.recurringInvoice.update({ where: { id: r.id }, data: { lastError: err.message?.slice(0, 500) ?? 'Failed', lastRunAt: new Date() } });
      logger.warn({ err: err?.message, recurringInvoiceId: r.id }, 'Recurring invoice run failed');
      if (manual) throw err;
      return { ok: false, error: err.message };
    }
  }

  /** "Bill now": raise the invoice immediately; if this period was due, the schedule moves on to the next one. */
  async runNow(tenantId, userId, id) {
    const r = await this.prisma.recurringInvoice.findFirst({ where: { id, tenantId } });
    if (!r) throw notFound();
    if (r.status !== 'ACTIVE') throw new AppError('Resume the schedule first', { statusCode: 409, code: 'RECURRING_INVOICE_NOT_ACTIVE' });
    return this.runOne(r, { userId, manual: true });
  }

  /** The hourly job: every active schedule whose date has come (India time). */
  async runDue(now = new Date()) {
    const today = asDate(todayInIndia(now));
    const due = await this.prisma.recurringInvoice.findMany({ where: { status: 'ACTIVE', nextRunOn: { lte: today } }, take: 500, orderBy: { nextRunOn: 'asc' } });
    let raised = 0;
    for (const r of due) {
      if (r.endOn && r.nextRunOn > r.endOn) {
        await this.prisma.recurringInvoice.update({ where: { id: r.id }, data: { status: 'ENDED' } });
        continue;
      }
      const result = await this.runOne(r);
      if (result.ok) raised += 1;
    }
    return { checked: due.length, raised };
  }
}

export const recurringInvoicesService = new RecurringInvoicesService();
