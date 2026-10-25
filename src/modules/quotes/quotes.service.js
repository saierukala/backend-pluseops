import { getPrismaClient } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import { auditService } from '../audit/audit.service.js';
import { OrderService } from '../orders/orders.service.js';
import { CustomerService, toAddressSnapshot } from '../customers/customers.service.js';
import { isIntraState, placeOfSupply, priceItems, resolveOrderDefaults } from '../orders/gst.js';
import { nextDocumentNumber } from '../orders/numbering.js';

/**
 * Phase 40: quotes (estimates). Priced with exactly the same GST rules as invoices. A quote moves
 * DRAFT → SENT → ACCEPTED/DECLINED; converting it creates an order at today's catalog prices (the stock is
 * taken then, not when quoting) and marks the quote CONVERTED.
 */
const NO_GST = ['COMPOSITION', 'UNREGISTERED'];
const EDITABLE = ['DRAFT', 'SENT'];
const TRANSITIONS = { DRAFT: ['SENT', 'ACCEPTED', 'DECLINED'], SENT: ['ACCEPTED', 'DECLINED'], ACCEPTED: ['DECLINED'], DECLINED: [], CONVERTED: [] };
const money = (c) => (c / 100).toFixed(2);

const notFound = () => new AppError('Quote not found', { statusCode: 404, code: 'QUOTE_NOT_FOUND' });

export class QuotesService {
  constructor() {
    this.prisma = getPrismaClient();
    this.orders = new OrderService();
    this.customers = new CustomerService();
  }

  async log(tx, ctx, { tenantId, action, resourceId, oldValue = null, newValue, activity, description }) {
    await auditService.logAudit({ tenantId, userId: ctx.userId ?? null, action, resource: 'quote', resourceId, oldValue, newValue, ipAddress: ctx.ipAddress ?? null, userAgent: ctx.userAgent ?? null, tx });
    await auditService.logActivity({ tenantId, userId: ctx.userId ?? null, action: activity, description, metadata: { quoteId: resourceId }, ipAddress: ctx.ipAddress ?? null, userAgent: ctx.userAgent ?? null, tx });
  }

  /** Lines and totals for a customer, as the invoice would show them today. */
  async price(tenantId, customerId, items) {
    const customer = await this.prisma.customer.findFirst({ where: { id: customerId, tenantId, deletedAt: null } });
    if (!customer) throw new AppError('Customer not found', { statusCode: 404, code: 'CUSTOMER_NOT_FOUND' });
    const variantIds = [...new Set(items.map((i) => i.variantId))];
    const variants = await this.prisma.productVariant.findMany({
      where: { id: { in: variantIds }, tenantId, deletedAt: null },
      include: { product: { select: { id: true, name: true, hsnCode: true, gstRatePercent: true, gstTaxability: true } } },
    });
    const variantMap = new Map(variants.map((v) => [v.id, v]));
    for (const i of items) if (!variantMap.has(i.variantId)) throw new AppError(`Variant ${i.variantId} not found`, { statusCode: 404, code: 'VARIANT_NOT_FOUND' });

    const defaults = await resolveOrderDefaults(this.prisma, tenantId);
    const shipping = toAddressSnapshot(await this.customers.resolveOrderAddress(customerId, tenantId, 'SHIPPING', undefined).catch(() => null));
    const billing = toAddressSnapshot(await this.customers.resolveOrderAddress(customerId, tenantId, 'BILLING', undefined).catch(() => null));
    const sellerState = defaults.taxProfile.stateCode ?? null;
    const supplyState = placeOfSupply({ shippingAddress: shipping, billingAddress: billing, customer });
    const intraState = isIntraState(sellerState, supplyState);
    const chargesGst = !NO_GST.includes(defaults.taxProfile.registrationType);
    const priced = priceItems(
      items.map((i) => ({ productVariantId: i.variantId, quantity: i.quantity, discount: i.discount ?? '0' })),
      variantMap,
      { chargesGst, gstRatePercent: chargesGst ? defaults.gstRatePercent : 0, inclusive: Boolean(defaults.taxProfile.pricesIncludeTax), intraState },
    );
    const lines = priced.lines.map((l) => ({
      variantId: l.productVariantId,
      productName: l.variant.product.name,
      sku: l.variant.sku,
      hsnCode: l.variant.product.hsnCode ?? null,
      unitPrice: l.unitPriceStr,
      quantity: l.quantity,
      discount: l.discountStr,
      gstRatePercent: l.gst.rate,
      taxableValue: l.gst.taxable,
      tax: l.taxStr,
      cgst: l.gst.cgst,
      sgst: l.gst.sgst,
      igst: l.gst.igst,
      lineTotal: l.lineTotalStr,
    }));
    return {
      lines,
      subtotal: money(priced.subtotalCents),
      discountTotal: money(priced.discountTotalCents),
      taxTotal: money(priced.taxTotalCents),
      total: money(priced.subtotalCents - priced.discountTotalCents + priced.taxTotalCents),
      placeOfSupply: supplyState ?? sellerState,
      supplyType: intraState ? 'INTRA' : 'INTER',
      currency: defaults.currency,
    };
  }

  async create(tenantId, body, ctx = {}) {
    const priced = await this.price(tenantId, body.customerId, body.items);
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } });
    const { taxProfile } = await resolveOrderDefaults(this.prisma, tenantId);
    return this.prisma.$transaction(async (tx) => {
      const number = await nextDocumentNumber(tx, tenantId, 'QUOTE', { taxProfile, slug: tenant?.slug });
      const quote = await tx.quote.create({
        data: {
          tenantId, number, customerId: body.customerId, status: 'DRAFT', validUntil: body.validUntil ? new Date(body.validUntil) : null,
          items: priced.lines, subtotal: priced.subtotal, discountTotal: priced.discountTotal, taxTotal: priced.taxTotal, total: priced.total,
          currency: priced.currency, placeOfSupply: priced.placeOfSupply, supplyType: priced.supplyType, notes: body.notes ?? null, createdBy: ctx.userId ?? null,
        },
        include: { customer: { omit: { passwordHash: true } } },
      });
      await this.log(tx, ctx, { tenantId, action: 'CREATE', resourceId: quote.id, newValue: { number, total: priced.total }, activity: 'quote.create', description: `Quote ${number} for ₹${priced.total}` });
      return quote;
    });
  }

  async list(tenantId, { page = 1, limit = 20, status, customerId, search } = {}) {
    const where = {
      tenantId,
      ...(status ? { status } : {}),
      ...(customerId ? { customerId } : {}),
      ...(search ? { OR: [{ number: { contains: search, mode: 'insensitive' } }, { customer: { OR: [{ firstName: { contains: search, mode: 'insensitive' } }, { lastName: { contains: search, mode: 'insensitive' } }, { companyName: { contains: search, mode: 'insensitive' } }] } }] } : {}),
    };
    const [data, total] = await Promise.all([
      this.prisma.quote.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit, include: { customer: { select: { id: true, firstName: true, lastName: true, companyName: true, email: true } } } }),
      this.prisma.quote.count({ where }),
    ]);
    return { data, meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
  }

  async get(tenantId, id) {
    const quote = await this.prisma.quote.findFirst({ where: { id, tenantId }, include: { customer: { omit: { passwordHash: true } } } });
    if (!quote) throw notFound();
    return quote;
  }

  /** Change items/notes/validity while still a draft or sent; prices are worked out again. */
  async update(tenantId, id, body, ctx = {}) {
    const quote = await this.get(tenantId, id);
    if (!EDITABLE.includes(quote.status)) throw new AppError(`A ${quote.status.toLowerCase()} quote can't be changed`, { statusCode: 409, code: 'QUOTE_LOCKED' });
    const priced = body.items ? await this.price(tenantId, quote.customerId, body.items) : null;
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.quote.update({
        where: { id },
        data: {
          ...(priced ? { items: priced.lines, subtotal: priced.subtotal, discountTotal: priced.discountTotal, taxTotal: priced.taxTotal, total: priced.total, placeOfSupply: priced.placeOfSupply, supplyType: priced.supplyType } : {}),
          ...(body.notes !== undefined ? { notes: body.notes } : {}),
          ...(body.validUntil !== undefined ? { validUntil: body.validUntil ? new Date(body.validUntil) : null } : {}),
        },
        include: { customer: { omit: { passwordHash: true } } },
      });
      await this.log(tx, ctx, { tenantId, action: 'UPDATE', resourceId: id, oldValue: { total: quote.total.toString() }, newValue: { total: updated.total.toString() }, activity: 'quote.update', description: `Quote ${quote.number} updated` });
      return updated;
    });
  }

  async setStatus(tenantId, id, status, ctx = {}) {
    const quote = await this.get(tenantId, id);
    if (!(TRANSITIONS[quote.status] ?? []).includes(status)) {
      throw new AppError(`A ${quote.status.toLowerCase()} quote can't become ${status.toLowerCase()}`, { statusCode: 409, code: 'INVALID_STATE_TRANSITION' });
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.quote.update({ where: { id }, data: { status }, include: { customer: { omit: { passwordHash: true } } } });
      await this.log(tx, ctx, { tenantId, action: 'UPDATE', resourceId: id, oldValue: { status: quote.status }, newValue: { status }, activity: 'quote.status', description: `Quote ${quote.number} ${status.toLowerCase()}` });
      return updated;
    });
  }

  /** Accepted (or still open) quote → order at today's prices; the stock is taken now. */
  async convert(tenantId, userId, id, { warehouseId, shippingAddressId, billingAddressId } = {}, ctx = {}) {
    const quote = await this.get(tenantId, id);
    if (!['DRAFT', 'SENT', 'ACCEPTED'].includes(quote.status)) throw new AppError(`A ${quote.status.toLowerCase()} quote can't be converted`, { statusCode: 409, code: 'QUOTE_LOCKED' });
    const warehouse = warehouseId
      ? await this.prisma.warehouse.findFirst({ where: { id: warehouseId, tenantId } })
      : await this.prisma.warehouse.findFirst({ where: { tenantId, isActive: true }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] });
    if (!warehouse) throw new AppError('Add a warehouse before converting', { statusCode: 409, code: 'NO_WAREHOUSE' });
    let order;
    await this.orders.create(tenantId, userId, {
      customerId: quote.customerId,
      shippingAddressId,
      billingAddressId,
      items: quote.items.map((i) => ({ productVariantId: i.variantId, warehouseId: warehouse.id, quantity: i.quantity, discount: i.discount })),
      metadata: { quoteId: quote.id, quoteNumber: quote.number },
    }, ctx, {
      inTx: async (tx, o) => {
        // Only one conversion wins if two people click at once
        const { count } = await tx.quote.updateMany({ where: { id, tenantId, status: { in: ['DRAFT', 'SENT', 'ACCEPTED'] } }, data: { status: 'CONVERTED', convertedOrderId: o.id } });
        if (!count) throw new AppError('This quote was already converted', { statusCode: 409, code: 'QUOTE_LOCKED' });
        await this.log(tx, { ...ctx, userId }, { tenantId, action: 'UPDATE', resourceId: id, oldValue: { status: quote.status }, newValue: { status: 'CONVERTED', orderId: o.id }, activity: 'quote.convert', description: `Quote ${quote.number} became an order` });
        order = o;
      },
    }).then((full) => { order = full; });
    return { quote: await this.get(tenantId, id), order };
  }

  async remove(tenantId, id, ctx = {}) {
    const quote = await this.get(tenantId, id);
    if (quote.status === 'CONVERTED') throw new AppError('A converted quote is kept with its order', { statusCode: 409, code: 'QUOTE_LOCKED' });
    await this.prisma.$transaction(async (tx) => {
      await tx.quote.delete({ where: { id } });
      await this.log(tx, ctx, { tenantId, action: 'DELETE', resourceId: id, oldValue: { number: quote.number }, newValue: null, activity: 'quote.delete', description: `Quote ${quote.number} deleted` });
    });
  }
}

export const quotesService = new QuotesService();
