import { getPrismaClient } from '../../config/database.js';

const BATCH = 1000;
export const MAX_ROWS = 100000;

function dateRange(filters) {
  if (!filters.from && !filters.to) return undefined;
  const range = {};
  if (filters.from) range.gte = new Date(`${filters.from}T00:00:00.000Z`);
  if (filters.to) range.lte = new Date(`${filters.to}T23:59:59.999Z`);
  return range;
}

// Reads a tenant-scoped table in id-cursor batches so large exports don't load everything at once.
async function* batches(model, args) {
  let cursor;
  for (;;) {
    const rows = await model.findMany({ ...args, take: BATCH, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    if (rows.length === 0) return;
    yield rows;
    if (rows.length < BATCH) return;
    cursor = rows[rows.length - 1].id;
  }
}

const money = (d) => (d === null || d === undefined ? '' : d.toString());

/** Each report type: the permission needed to read its data, its CSV header, and its rows. */
export const REPORT_DEFINITIONS = {
  ORDERS: {
    permission: 'order:read',
    filters: ['from', 'to', 'status'],
    header: ['orderId', 'createdAt', 'status', 'customerEmail', 'customerName', 'itemCount', 'subtotal', 'discountTotal', 'taxTotal', 'shippingTotal', 'total', 'currency'],
    async *rows(tenantId, filters) {
      const prisma = getPrismaClient();
      const where = { tenantId, ...(filters.status ? { status: filters.status } : {}), ...(dateRange(filters) ? { createdAt: dateRange(filters) } : {}) };
      for await (const rows of batches(prisma.order, {
        where,
        orderBy: { id: 'asc' },
        include: { customer: { select: { email: true, firstName: true, lastName: true } }, _count: { select: { items: true } } },
      })) {
        for (const o of rows) {
          yield [o.id, o.createdAt, o.status, o.customer.email, `${o.customer.firstName} ${o.customer.lastName}`, o._count.items,
            money(o.subtotal), money(o.discountTotal), money(o.taxTotal), money(o.shippingTotal), money(o.total), o.currency];
        }
      }
    },
  },
  INVENTORY: {
    permission: 'inventory:read',
    filters: ['warehouseId'],
    header: ['sku', 'productName', 'variantStatus', 'warehouseCode', 'warehouseName', 'quantity', 'updatedAt'],
    async *rows(tenantId, filters) {
      const prisma = getPrismaClient();
      for await (const rows of batches(prisma.inventory, {
        where: { tenantId, ...(filters.warehouseId ? { warehouseId: filters.warehouseId } : {}) },
        orderBy: { id: 'asc' },
        include: { productVariant: { select: { sku: true, status: true, product: { select: { name: true } } } }, warehouse: { select: { code: true, name: true } } },
      })) {
        for (const i of rows) {
          yield [i.productVariant.sku, i.productVariant.product.name, i.productVariant.status, i.warehouse.code, i.warehouse.name, i.quantity, i.updatedAt];
        }
      }
    },
  },
  CUSTOMERS: {
    permission: 'customer:read',
    filters: ['from', 'to'],
    header: ['customerId', 'email', 'firstName', 'lastName', 'phone', 'createdAt', 'orderCount', 'totalSpent'],
    async *rows(tenantId, filters) {
      const prisma = getPrismaClient();
      const where = { tenantId, deletedAt: null, ...(dateRange(filters) ? { createdAt: dateRange(filters) } : {}) };
      for await (const rows of batches(prisma.customer, { where, orderBy: { id: 'asc' } })) {
        const totals = await prisma.order.groupBy({
          by: ['customerId'],
          where: { tenantId, customerId: { in: rows.map((c) => c.id) }, status: { notIn: ['CANCELLED', 'REFUNDED'] } },
          _count: { _all: true },
          _sum: { total: true },
        });
        const byCustomer = new Map(totals.map((t) => [t.customerId, t]));
        for (const c of rows) {
          const t = byCustomer.get(c.id);
          yield [c.id, c.email, c.firstName, c.lastName, c.phone, c.createdAt, t?._count._all ?? 0, money(t?._sum.total ?? '0.00')];
        }
      }
    },
  },
};
