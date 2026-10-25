import { getPrismaClient } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import { logger } from '../../config/logger.js';
import { OrderService } from '../orders/orders.service.js';
import { PaymentService } from '../payments/payments.service.js';
import { razorpayPaymentsService } from '../payments/razorpay-payments.service.js';
import { sellableVariant, stockOf, attributesOf } from './storefront.catalog.js';
import { toProfile } from './storefront.auth.js';

const orderService = new OrderService();
const paymentService = new PaymentService();
const money = (d) => (d === null || d === undefined ? null : Number(d).toFixed(2));

// ── Account ────────────────────────────────────────────────────────────

export async function getProfile(store, customerId) {
  return toProfile(await getPrismaClient().customer.findFirst({ where: { id: customerId, tenantId: store.id } }));
}

export async function updateProfile(store, customerId, data) {
  return toProfile(await getPrismaClient().customer.update({ where: { id: customerId }, data: { firstName: data.firstName, lastName: data.lastName, phone: data.phone } }));
}

// ── Cart ───────────────────────────────────────────────────────────────

const cartInclude = {
  productVariant: {
    include: {
      product: { select: { id: true, name: true, status: true, deletedAt: true, images: { orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }], take: 1, select: { id: true } } } },
      inventory: { select: { quantity: true, warehouseId: true, warehouse: { select: { isActive: true, isDefault: true } } } },
      attributes: { include: { attributeDefinition: { select: { code: true } } } },
    },
  },
};

const isSellable = (v) => v.status === 'ACTIVE' && !v.deletedAt && v.product.status === 'ACTIVE' && !v.product.deletedAt;

/** Backend-priced cart: current prices, per-line availability and the subtotal of what can be bought. */
export async function getCart(store, customerId) {
  const items = await getPrismaClient().cartItem.findMany({ where: { tenantId: store.id, customerId }, include: cartInclude, orderBy: { createdAt: 'asc' } });
  let subtotalCents = 0;
  const lines = items.map((item) => {
    const v = item.productVariant;
    const issue = !isSellable(v) ? 'UNAVAILABLE' : stockOf(v) < item.quantity ? 'INSUFFICIENT_STOCK' : null;
    const unitCents = Math.round(Number(v.price) * 100);
    if (!issue) subtotalCents += unitCents * item.quantity;
    return {
      variantId: v.id, productId: v.product.id, productName: v.product.name, sku: v.sku, attributes: attributesOf(v),
      unitPrice: (unitCents / 100).toFixed(2), quantity: item.quantity, lineTotal: ((unitCents * item.quantity) / 100).toFixed(2),
      available: !issue, issue,
    };
  });
  return { items: lines, itemCount: lines.reduce((n, l) => n + l.quantity, 0), subtotal: (subtotalCents / 100).toFixed(2), currency: store.currency, readyForCheckout: lines.length > 0 && lines.every((l) => l.available) };
}

export async function setCartItem(store, customerId, variantId, quantity) {
  const prisma = getPrismaClient();
  if (quantity === 0) {
    await prisma.cartItem.deleteMany({ where: { tenantId: store.id, customerId, productVariantId: variantId } });
    return getCart(store, customerId);
  }
  const variant = await prisma.productVariant.findFirst({
    where: { id: variantId, ...sellableVariant(store.id), product: { status: 'ACTIVE', deletedAt: null } },
    include: { inventory: { select: { quantity: true } } },
  });
  if (!variant) throw new AppError('This product is not available', { statusCode: 404, code: 'PRODUCT_NOT_AVAILABLE' });
  if (stockOf(variant) < quantity) throw new AppError('Not enough stock for that quantity', { statusCode: 409, code: 'INSUFFICIENT_STOCK' });
  await prisma.cartItem.upsert({
    where: { customerId_productVariantId: { customerId, productVariantId: variantId } },
    update: { quantity },
    create: { tenantId: store.id, customerId, productVariantId: variantId, quantity },
  });
  return getCart(store, customerId);
}

export async function clearCart(store, customerId) {
  await getPrismaClient().cartItem.deleteMany({ where: { tenantId: store.id, customerId } });
  return getCart(store, customerId);
}

// ── Orders ─────────────────────────────────────────────────────────────

const orderInclude = {
  items: true,
  statusHistory: { orderBy: { createdAt: 'asc' }, select: { toStatus: true, createdAt: true } },
  payments: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true, status: true, amount: true, currency: true, createdAt: true } },
};

/** What a shopper sees of an order: no internal ids of staff, reasons, costs or warehouse data. */
export function toCustomerOrder(o) {
  return {
    id: o.id,
    number: o.id.slice(0, 8).toUpperCase(),
    status: o.status,
    createdAt: o.createdAt,
    currency: o.currency,
    subtotal: money(o.subtotal), discountTotal: money(o.discountTotal), taxTotal: money(o.taxTotal), shippingTotal: money(o.shippingTotal), total: money(o.total),
    // Phase 38: the tax invoice as the shopper sees it
    invoiceNumber: o.invoiceNumber ?? null,
    supplyType: o.supplyType ?? null,
    cgstTotal: money(o.cgstTotal), sgstTotal: money(o.sgstTotal), igstTotal: money(o.igstTotal),
    items: o.items.map((i) => ({
      productName: i.productNameSnapshot, variantName: i.variantNameSnapshot, sku: i.skuSnapshot, unitPrice: money(i.unitPrice), quantity: i.quantity, lineTotal: money(i.lineTotal),
      hsnCode: i.hsnCode ?? null, gstRatePercent: Number(i.gstRatePercent ?? 0),
    })),
    shippingAddress: o.shippingAddress ?? null,
    billingAddress: o.billingAddress ?? null,
    timeline: o.statusHistory.map((h) => ({ status: h.toStatus, at: h.createdAt })),
    payments: o.payments.map((p) => ({ id: p.id, status: p.status, amount: money(p.amount), currency: p.currency, createdAt: p.createdAt })),
  };
}

export async function listOrders(store, customerId, { page = 1, limit = 20, status } = {}) {
  const prisma = getPrismaClient();
  const where = { tenantId: store.id, customerId, ...(status ? { status } : {}) };
  const [rows, total] = await Promise.all([
    prisma.order.findMany({ where, include: orderInclude, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * limit, take: limit }),
    prisma.order.count({ where }),
  ]);
  return { data: rows.map(toCustomerOrder), meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

async function findOwnOrder(store, customerId, orderId) {
  const order = await getPrismaClient().order.findFirst({ where: { id: orderId, tenantId: store.id, customerId }, include: orderInclude });
  if (!order) throw new AppError('Order not found', { statusCode: 404, code: 'ORDER_NOT_FOUND' });
  return order;
}

export async function getOrder(store, customerId, orderId) {
  return toCustomerOrder(await findOwnOrder(store, customerId, orderId));
}

function toPayment(p, checkout = null) {
  return { id: p.id, status: p.status, amount: money(p.amount), currency: p.currency, provider: p.provider, providerPaymentId: p.providerPaymentId, checkout };
}

// Phase 35: with the shop's Razorpay connected, a Razorpay order is created and `checkout` carries what Razorpay's web
// checkout needs (key id, order id, amount in minor units). Without it, a pending payment the shop settles by hand.
async function startPayment(store, customerId, orderId) {
  if (!(await razorpayPaymentsService.enabledFor(store.id))) {
    return toPayment(await paymentService.create(store.id, null, { orderId }));
  }
  const customer = await getPrismaClient().customer.findFirst({ where: { id: customerId, tenantId: store.id }, select: { firstName: true, lastName: true, email: true, phone: true } });
  const { payment, checkout } = await razorpayPaymentsService.start(store.id, orderId, {
    description: `${store.name} order`,
    prefill: { name: [customer?.firstName, customer?.lastName].filter(Boolean).join(' ') || undefined, email: customer?.email || undefined, contact: customer?.phone || undefined },
  });
  return toPayment(payment, { ...checkout, name: store.name });
}

export async function payOrder(store, customerId, orderId) {
  await findOwnOrder(store, customerId, orderId);
  return startPayment(store, customerId, orderId);
}

/** What Razorpay's checkout handed the browser; the signature decides, never the browser's word. */
export async function verifyPayment(store, customerId, paymentId, body) {
  return toPayment(await razorpayPaymentsService.verify(store.id, paymentId, body, { where: { order: { customerId } } }));
}

export async function onlinePaymentInfo(store) {
  return { provider: 'razorpay', enabled: await razorpayPaymentsService.enabledFor(store.id) };
}

// Single-warehouse fulfilment per line: the default warehouse when it can cover the quantity, else the
// active warehouse with the most stock that can. No split shipments.
function pickWarehouse(variant, quantity) {
  const candidates = variant.inventory.filter((i) => i.warehouse.isActive && i.quantity >= quantity);
  candidates.sort((a, b) => Number(b.warehouse.isDefault) - Number(a.warehouse.isDefault) || b.quantity - a.quantity);
  return candidates[0]?.warehouseId ?? null;
}

/** Turns the cart into an order (server-priced, stock reserved) and starts a payment for it. */
export async function checkout(store, customerId, { shippingAddressId, billingAddressId }, client = {}) {
  const prisma = getPrismaClient();
  const items = await prisma.cartItem.findMany({ where: { tenantId: store.id, customerId }, include: cartInclude });
  if (items.length === 0) throw new AppError('Your cart is empty', { statusCode: 409, code: 'CART_EMPTY' });
  const lines = [];
  for (const item of items) {
    const v = item.productVariant;
    const warehouseId = isSellable(v) ? pickWarehouse(v, item.quantity) : null;
    if (!warehouseId) {
      throw new AppError('Some items in your cart are no longer available in that quantity', { statusCode: 409, code: 'CART_NOT_READY', details: { variantId: v.id } });
    }
    lines.push({ productVariantId: v.id, warehouseId, quantity: item.quantity });
  }

  const created = await orderService.create(store.id, null, {
    customerId, items: lines, shippingAddressId, billingAddressId, currency: store.currency, metadata: { source: 'storefront' }, channel: 'STOREFRONT',
  }, client);
  await prisma.cartItem.deleteMany({ where: { tenantId: store.id, customerId } });

  let payment = null;
  try {
    payment = await startPayment(store, customerId, created.id);
  } catch (err) {
    // The order stands; the shopper can retry with POST /account/orders/:id/pay
    logger.warn({ err, tenantId: store.id, orderId: created.id }, 'Storefront payment could not be started');
  }
  return { order: await getOrder(store, customerId, created.id), payment };
}
