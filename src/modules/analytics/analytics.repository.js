import { getPrismaClient } from '../../config/database.js';

const GROUP_BY_MAP = {
  day: 'day',
  week: 'week',
  month: 'month',
};

function parseDateBound(str, isEnd) {
  if (!str) return null;
  const d = new Date(str);
  if (Number.isNaN(d.getTime())) return null;
  if (isEnd && /^\d{4}-\d{2}-\d{2}$/.test(str)) {
    d.setUTCHours(23, 59, 59, 999);
  } else if (!isEnd && /^\d{4}-\d{2}-\d{2}$/.test(str)) {
    d.setUTCHours(0, 0, 0, 0);
  }
  return d;
}

function formatDecimal(val) {
  if (val === null || val === undefined) return '0.00';
  const s = val.toString();
  const num = Number.parseFloat(s);
  if (Number.isNaN(num)) return s;
  return num.toFixed(2);
}

export class AnalyticsRepository {
  constructor() {
    this.prisma = getPrismaClient();
  }

  // Helpers to build where for orders/sales
  _ordersWhere(tenantId, filters) {
    const where = { tenantId };
    if (filters.from || filters.to) {
      where.createdAt = {};
      if (filters.from) where.createdAt.gte = parseDateBound(filters.from, false);
      if (filters.to) where.createdAt.lte = parseDateBound(filters.to, true);
    }
    if (filters.status) where.status = filters.status;
    return where;
  }

  async getOverview(tenantId, filters = {}) {
    const where = {};
    if (filters.from || filters.to) {
      where.createdAt = {};
      if (filters.from) where.createdAt.gte = parseDateBound(filters.from, false);
      if (filters.to) where.createdAt.lte = parseDateBound(filters.to, true);
    }

    const ordersWhere = { tenantId, ...where };
    const customersWhere = { tenantId, ...where };
    const paymentsWhereCompleted = { tenantId, status: 'COMPLETED' };
    if (filters.from || filters.to) {
      paymentsWhereCompleted.createdAt = {};
      if (filters.from) paymentsWhereCompleted.createdAt.gte = parseDateBound(filters.from, false);
      if (filters.to) paymentsWhereCompleted.createdAt.lte = parseDateBound(filters.to, true);
    }
    const paymentsWhereAll = { tenantId };
    if (filters.from || filters.to) {
      paymentsWhereAll.createdAt = {};
      if (filters.from) paymentsWhereAll.createdAt.gte = parseDateBound(filters.from, false);
      if (filters.to) paymentsWhereAll.createdAt.lte = parseDateBound(filters.to, true);
    }

    const [
      totalOrders,
      statusGroups,
      revenueAgg,
      totalCustomers,
      totalProducts,
      totalVariants,
      totalWarehouses,
      inventoryAgg,
      lowStockCount,
      totalPayments,
      completedRevenueAgg,
      refundAgg,
    ] = await Promise.all([
      this.prisma.order.count({ where: ordersWhere }),
      this.prisma.order.groupBy({ by: ['status'], where: ordersWhere, _count: { status: true } }),
      this.prisma.order.aggregate({ where: ordersWhere, _sum: { total: true }, _avg: { total: true } }),
      this.prisma.customer.count({ where: customersWhere }),
      this.prisma.product.count({ where: { tenantId } }),
      this.prisma.productVariant.count({ where: { tenantId } }),
      this.prisma.warehouse.count({ where: { tenantId } }),
      this.prisma.inventory.aggregate({ where: { tenantId }, _sum: { quantity: true, reservedQuantity: true } }),
      this.prisma.inventory.count({ where: { tenantId, quantity: { lte: 10 } } }),
      this.prisma.payment.count({ where: paymentsWhereAll }),
      this.prisma.payment.aggregate({ where: paymentsWhereCompleted, _sum: { amount: true } }),
      this.prisma.refund.aggregate({ where: { tenantId, status: 'COMPLETED', ...(where.createdAt ? { createdAt: where.createdAt } : {}) }, _sum: { amount: true } }),
    ]);

    const byStatus = {};
    for (const g of statusGroups) byStatus[g.status] = g._count.status;

    const totalSales = formatDecimal(revenueAgg._sum.total);
    const avgOrderValue = formatDecimal(revenueAgg._avg.total);
    const completedRevenue = formatDecimal(completedRevenueAgg._sum.amount);
    const totalRefunded = formatDecimal(refundAgg._sum.amount);

    return {
      orders: {
        total: totalOrders,
        byStatus,
        totalSales,
        avgOrderValue,
      },
      sales: {
        totalOrders,
        totalSales,
        avgOrderValue,
      },
      customers: {
        total: totalCustomers,
      },
      inventory: {
        totalQuantity: inventoryAgg._sum.quantity ?? 0,
        totalReserved: inventoryAgg._sum.reservedQuantity ?? 0,
        lowStockItems: lowStockCount,
        warehouses: totalWarehouses,
        variants: totalVariants,
      },
      products: {
        total: totalProducts,
        variants: totalVariants,
      },
      revenue: {
        totalPayments,
        completedRevenue,
        totalRefunded,
        netRevenue: (parseFloat(completedRevenue) - parseFloat(totalRefunded)).toFixed(2),
      },
      generatedAt: new Date().toISOString(),
    };
  }

  async getSales(tenantId, filters = {}) {
    const page = filters.page ?? 1;
    const limit = Math.min(filters.limit ?? 20, 100);
    const skip = (page - 1) * limit;
    const groupBy = filters.groupBy;
    const categoryId = filters.category || filters.categoryId || null;
    const productId = filters.product || filters.productId || null;
    const status = filters.status || null;
    const fromDate = parseDateBound(filters.from, false);
    const toDate = parseDateBound(filters.to, true);

    // Build where for total count/sum without groupBy
    const hasGroup = !!groupBy && GROUP_BY_MAP[groupBy];
    const trunc = hasGroup ? GROUP_BY_MAP[groupBy] : null;

    if (!hasGroup) {
      // Non-grouped: single aggregated summary filtered
      // For category/product filter we need to filter orders via exists
      if (categoryId || productId) {
        // Use raw SQL for filtered aggregation
        const conditions = [`o."tenant_id" = $1`];
        const params = [tenantId];
        let idx = 2;
        if (fromDate) { conditions.push(`o."created_at" >= $${idx}`); params.push(fromDate); idx++; }
        if (toDate) { conditions.push(`o."created_at" <= $${idx}`); params.push(toDate); idx++; }
        if (status) { conditions.push(`o."status" = $${idx}::"OrderStatus"`); params.push(status); idx++; }
        if (productId) {
          conditions.push(`EXISTS (SELECT 1 FROM "order_items" oi JOIN "product_variants" pv ON oi."product_variant_id" = pv."id" WHERE oi."order_id" = o."id" AND pv."product_id" = $${idx})`);
          params.push(productId); idx++;
        }
        if (categoryId) {
          conditions.push(`EXISTS (SELECT 1 FROM "order_items" oi JOIN "product_variants" pv ON oi."product_variant_id" = pv."id" JOIN "product_categories" pc ON pc."product_id" = pv."product_id" WHERE oi."order_id" = o."id" AND pc."category_id" = $${idx})`);
          params.push(categoryId);
          idx += 1;
        }
        void idx;
        const whereClause = conditions.join(' AND ');
        const rows = await this.prisma.$queryRawUnsafe(
          `SELECT COUNT(*)::int as "orderCount", COALESCE(SUM(o."total"),0)::text as "totalSales", COALESCE(AVG(o."total"),0)::text as "avgValue" FROM "orders" o WHERE ${whereClause}`,
          ...params
        );
        const totalRows = 1;
        const data = rows.map((r) => ({
          bucket: null,
          orderCount: Number(r.orderCount),
          totalSales: formatDecimal(r.totalSales),
          avgValue: formatDecimal(r.avgValue),
        }));
        return { data, meta: { page, limit, total: totalRows, totalPages: 1 }, summary: data[0] };
      }
      const where = this._ordersWhere(tenantId, { from: filters.from, to: filters.to, status });
      const [count, agg] = await Promise.all([
        this.prisma.order.count({ where }),
        this.prisma.order.aggregate({ where, _sum: { total: true }, _avg: { total: true } }),
      ]);
      const summary = {
        bucket: null,
        orderCount: count,
        totalSales: formatDecimal(agg._sum.total),
        avgValue: formatDecimal(agg._avg.total),
      };
      return { data: [summary], meta: { page: 1, limit: 1, total: 1, totalPages: 1 }, summary };
    }

    // Grouped by trunc -> use raw SQL for efficient bucketing
    const conditions = [`o."tenant_id" = $1`];
    const params = [tenantId];
    let idx = 2;
    if (fromDate) { conditions.push(`o."created_at" >= $${idx}`); params.push(fromDate); idx++; }
    if (toDate) { conditions.push(`o."created_at" <= $${idx}`); params.push(toDate); idx++; }
    if (status) { conditions.push(`o."status" = $${idx}::"OrderStatus"`); params.push(status); idx++; }
    if (productId) {
      conditions.push(`EXISTS (SELECT 1 FROM "order_items" oi JOIN "product_variants" pv ON oi."product_variant_id" = pv."id" WHERE oi."order_id" = o."id" AND pv."product_id" = $${idx})`);
      params.push(productId); idx++;
    }
    if (categoryId) {
      conditions.push(`EXISTS (SELECT 1 FROM "order_items" oi JOIN "product_variants" pv ON oi."product_variant_id" = pv."id" JOIN "product_categories" pc ON pc."product_id" = pv."product_id" WHERE oi."order_id" = o."id" AND pc."category_id" = $${idx})`);
      params.push(categoryId); idx++;
    }
    const whereClause = conditions.join(' AND ');

    // Need total buckets count for pagination - UTC deterministic
    const countRows = await this.prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int as cnt FROM (SELECT date_trunc('${trunc}', o."created_at" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' as bucket FROM "orders" o WHERE ${whereClause} GROUP BY bucket) s`,
      ...params
    );
    const totalBuckets = Number(countRows[0]?.cnt ?? 0);
    const totalPages = Math.max(1, Math.ceil(totalBuckets / limit));

    const dataRows = await this.prisma.$queryRawUnsafe(
      `SELECT date_trunc('${trunc}', o."created_at" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' as bucket, COUNT(*)::int as "orderCount", COALESCE(SUM(o."total"),0)::text as "totalSales", COALESCE(AVG(o."total"),0)::text as "avgValue" FROM "orders" o WHERE ${whereClause} GROUP BY bucket ORDER BY bucket ASC LIMIT $${idx} OFFSET $${idx + 1}`,
      ...params, limit, skip
    );

    const data = dataRows.map((r) => ({
      bucket: r.bucket ? new Date(r.bucket).toISOString() : null,
      orderCount: Number(r.orderCount),
      totalSales: formatDecimal(r.totalSales),
      avgValue: formatDecimal(r.avgValue),
    }));
    const overallRows = await this.prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int as "orderCount", COALESCE(SUM(o."total"),0)::text as "totalSales" FROM "orders" o WHERE ${whereClause}`,
      ...params
    );
    const summary = {
      orderCount: Number(overallRows[0].orderCount),
      totalSales: formatDecimal(overallRows[0].totalSales),
    };
    return { data, meta: { page, limit, total: totalBuckets, totalPages }, summary };
  }

  async getOrders(tenantId, filters = {}) {
    const page = filters.page ?? 1;
    const limit = Math.min(filters.limit ?? 20, 100);
    const skip = (page - 1) * limit;
    const groupBy = filters.groupBy;
    const status = filters.status || null;
    const fromDate = parseDateBound(filters.from, false);
    const toDate = parseDateBound(filters.to, true);
    const trunc = groupBy ? GROUP_BY_MAP[groupBy] : null;

    if (!trunc) {
      const where = this._ordersWhere(tenantId, { from: filters.from, to: filters.to, status });
      const [total, statusGroups, agg] = await Promise.all([
        this.prisma.order.count({ where }),
        this.prisma.order.groupBy({ by: ['status'], where, _count: { status: true } }),
        this.prisma.order.aggregate({ where, _sum: { total: true } }),
      ]);
      const byStatus = {};
      for (const g of statusGroups) byStatus[g.status] = g._count.status;
      // Paginated buckets not needed; return single summary with pagination meta for list
      // But for consistency provide data array with byStatus breakdown paginated? Instead provide buckets as empty
      // We'll provide paginated list of status breakdown? No bucket. So return data as status breakdown entries paginated
      const statusEntries = Object.entries(byStatus).map(([s, cnt]) => ({ status: s, count: cnt }));
      const paged = statusEntries.slice(skip, skip + limit);
      return {
        data: paged,
        meta: { page, limit, total: statusEntries.length, totalPages: Math.max(1, Math.ceil(statusEntries.length / limit)) },
        summary: { total, byStatus, totalSales: formatDecimal(agg._sum.total) },
      };
    }

    const conditions = [`o."tenant_id" = $1`];
    const params = [tenantId];
    let idx = 2;
    if (fromDate) { conditions.push(`o."created_at" >= $${idx}`); params.push(fromDate); idx++; }
    if (toDate) { conditions.push(`o."created_at" <= $${idx}`); params.push(toDate); idx++; }
    if (status) { conditions.push(`o."status" = $${idx}::"OrderStatus"`); params.push(status); idx++; }
    const whereClause = conditions.join(' AND ');
    const countRows = await this.prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int as cnt FROM (SELECT date_trunc('${trunc}', o."created_at" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' as bucket FROM "orders" o WHERE ${whereClause} GROUP BY bucket) s`,
      ...params
    );
    const totalBuckets = Number(countRows[0]?.cnt ?? 0);
    const totalPages = Math.max(1, Math.ceil(totalBuckets / limit));
    const dataRows = await this.prisma.$queryRawUnsafe(
      `SELECT date_trunc('${trunc}', o."created_at" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' as bucket, COUNT(*)::int as "orderCount", COALESCE(SUM(o."total"),0)::text as "totalSales" FROM "orders" o WHERE ${whereClause} GROUP BY bucket ORDER BY bucket ASC LIMIT $${idx} OFFSET $${idx + 1}`,
      ...params, limit, skip
    );
    const data = dataRows.map((r) => ({
      bucket: r.bucket ? new Date(r.bucket).toISOString() : null,
      orderCount: Number(r.orderCount),
      totalSales: formatDecimal(r.totalSales),
    }));
    // Also fetch summary + byStatus
    const where = this._ordersWhere(tenantId, { from: filters.from, to: filters.to, status });
    const [total, statusGroups] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.groupBy({ by: ['status'], where, _count: { status: true } }),
    ]);
    const byStatus = {};
    for (const g of statusGroups) byStatus[g.status] = g._count.status;
    return {
      data,
      meta: { page, limit, total: totalBuckets, totalPages },
      summary: { total, byStatus },
    };
  }

  async getInventory(tenantId, filters = {}) {
    const page = filters.page ?? 1;
    const limit = Math.min(filters.limit ?? 20, 100);
    const skip = (page - 1) * limit;
    const categoryId = filters.category || filters.categoryId || null;
    const productId = filters.product || filters.productId || null;
    const warehouseId = filters.warehouseId || filters.warehouse || null;
    const variantStatus = filters.status || null;

    // Build where for inventory aggregation
    const inventoryWhere = { tenantId };
    if (warehouseId) inventoryWhere.warehouseId = warehouseId;

    // For product/category/status we need variant join filter
    // Use raw SQL for aggregated summary to handle joins efficiently (keep DB-side)
    // Summary: totalQuantity, warehouseCount, variantCount, lowStock

    let summary;
    if (categoryId || productId || variantStatus) {
      // filtered summary via raw
      const conditions = [`i."tenant_id" = $1`];
      const params = [tenantId];
      let idx = 2;
      if (warehouseId) { conditions.push(`i."warehouse_id" = $${idx}`); params.push(warehouseId); idx++; }
      if (productId) { conditions.push(`pv."product_id" = $${idx}`); params.push(productId); idx++; }
      if (categoryId) {
        conditions.push(`EXISTS (SELECT 1 FROM "product_categories" pc WHERE pc."product_id" = pv."product_id" AND pc."category_id" = $${idx})`);
        params.push(categoryId); idx++;
      }
      if (variantStatus) { conditions.push(`pv."status" = $${idx}::"VariantStatus"`); params.push(variantStatus); idx += 1; }
      void idx;
      const joinClause = `JOIN "product_variants" pv ON pv."id" = i."product_variant_id"`;
      const whereClause = conditions.join(' AND ');
      const rows = await this.prisma.$queryRawUnsafe(
        `SELECT COALESCE(SUM(i."quantity"),0)::int as "totalQuantity", COALESCE(SUM(i."reserved_quantity"),0)::int as "totalReserved", COUNT(*)::int as "itemCount", COUNT(DISTINCT i."warehouse_id")::int as "warehouseCount", COUNT(DISTINCT i."product_variant_id")::int as "variantCount" FROM "inventory" i ${joinClause} WHERE ${whereClause}`,
        ...params
      );
      const lowRows = await this.prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int as "lowStock" FROM "inventory" i ${joinClause} WHERE ${whereClause} AND i."quantity" <= 10`,
        ...params
      );
      summary = {
        totalQuantity: Number(rows[0].totalQuantity ?? 0),
        totalReserved: Number(rows[0].totalReserved ?? 0),
        warehouses: Number(rows[0].warehouseCount ?? 0),
        variants: Number(rows[0].variantCount ?? 0),
        itemCount: Number(rows[0].itemCount ?? 0),
        lowStockItems: Number(lowRows[0].lowStock ?? 0),
      };
    } else {
      const [agg, warehouseCount, variantCount, lowStock, itemCount] = await Promise.all([
        this.prisma.inventory.aggregate({ where: inventoryWhere, _sum: { quantity: true, reservedQuantity: true } }),
        this.prisma.inventory.groupBy({ by: ['warehouseId'], where: inventoryWhere }).then((r) => r.length),
        this.prisma.inventory.groupBy({ by: ['productVariantId'], where: inventoryWhere }).then((r) => r.length),
        this.prisma.inventory.count({ where: { ...inventoryWhere, quantity: { lte: 10 } } }),
        this.prisma.inventory.count({ where: inventoryWhere }),
      ]);
      summary = {
        totalQuantity: agg._sum.quantity ?? 0,
        totalReserved: agg._sum.reservedQuantity ?? 0,
        warehouses: warehouseCount,
        variants: variantCount,
        itemCount,
        lowStockItems: lowStock,
      };
    }

    // Paginated data: inventory rows
    const prismaWhere = { tenantId };
    if (warehouseId) prismaWhere.warehouseId = warehouseId;
    // For category/product/status need variant filter
    if (productId || categoryId || variantStatus) {
      // Build variant filter
      const variantFilter = { tenantId };
      if (productId) variantFilter.productId = productId;
      if (variantStatus) variantFilter.status = variantStatus;
      if (categoryId) {
        variantFilter.product = { categories: { some: { categoryId, tenantId } } };
      }
      prismaWhere.productVariant = variantFilter;
    }

    const [data, total] = await Promise.all([
      this.prisma.inventory.findMany({
        where: prismaWhere,
        include: {
          productVariant: { select: { id: true, sku: true, price: true, status: true, productId: true } },
          warehouse: { select: { id: true, name: true, code: true } },
        },
        orderBy: { updatedAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.inventory.count({ where: prismaWhere }),
    ]);

    // By warehouse aggregation (if not too many)
    const byWarehouse = await this.prisma.inventory.groupBy({
      by: ['warehouseId'],
      where: prismaWhere,
      _sum: { quantity: true, reservedQuantity: true },
      _count: { warehouseId: true },
    });
    // Enrich warehouse names
    const warehouseIds = byWarehouse.map((b) => b.warehouseId);
    const warehouses = warehouseIds.length > 0 ? await this.prisma.warehouse.findMany({ where: { id: { in: warehouseIds }, tenantId }, select: { id: true, name: true, code: true } }) : [];
    const wMap = new Map(warehouses.map((w) => [w.id, w]));
    const byWarehouseEnriched = byWarehouse.map((b) => ({
      warehouseId: b.warehouseId,
      warehouse: wMap.get(b.warehouseId) || null,
      totalQuantity: b._sum.quantity ?? 0,
      totalReserved: b._sum.reservedQuantity ?? 0,
      itemCount: b._count.warehouseId,
    }));

    return {
      summary,
      byWarehouse: byWarehouseEnriched,
      data: data.map((r) => ({
        id: r.id,
        productVariantId: r.productVariantId,
        warehouseId: r.warehouseId,
        quantity: r.quantity,
        reservedQuantity: r.reservedQuantity,
        productVariant: r.productVariant,
        warehouse: r.warehouse,
        updatedAt: r.updatedAt,
      })),
      meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };
  }

  async getCustomers(tenantId, filters = {}) {
    const page = filters.page ?? 1;
    const limit = Math.min(filters.limit ?? 20, 100);
    const skip = (page - 1) * limit;
    const fromDate = parseDateBound(filters.from, false);
    const toDate = parseDateBound(filters.to, true);
    const groupBy = filters.groupBy;
    const trunc = groupBy ? GROUP_BY_MAP[groupBy] : null;

    // Summary: total customers, total orders, avg orders per customer
    const customerWhere = { tenantId };
    if (fromDate || toDate) {
      customerWhere.createdAt = {};
      if (fromDate) customerWhere.createdAt.gte = fromDate;
      if (toDate) customerWhere.createdAt.lte = toDate;
    }
    const [totalCustomers, orderCount] = await Promise.all([
      this.prisma.customer.count({ where: customerWhere }),
      this.prisma.order.count({ where: { tenantId, ...(fromDate || toDate ? { createdAt: { ...(fromDate ? { gte: fromDate } : {}), ...(toDate ? { lte: toDate } : {}) } } : {}) } }),
    ]);

    // Use raw for top customers to include sum total as Decimal
    const topParams = [tenantId];
    let topConditions = [`o."tenant_id" = $1`];
    let topIdx = 2;
    if (fromDate) { topConditions.push(`o."created_at" >= $${topIdx}`); topParams.push(fromDate); topIdx++; }
    if (toDate) { topConditions.push(`o."created_at" <= $${topIdx}`); topParams.push(toDate); topIdx++; }
    const topWhereClause = topConditions.join(' AND ');
    const totalTopGroupsRow = await this.prisma.$queryRawUnsafe(
      `SELECT COUNT(DISTINCT o."customer_id")::int as cnt FROM "orders" o WHERE ${topWhereClause}`,
      ...topParams
    );
    const totalTopGroups = Number(totalTopGroupsRow[0]?.cnt ?? 0);
    const topRows = await this.prisma.$queryRawUnsafe(
      `SELECT o."customer_id" as "customerId", c."email", c."first_name" as "firstName", c."last_name" as "lastName", COUNT(*)::int as "orderCount", COALESCE(SUM(o."total"),0)::text as "totalSpent" FROM "orders" o JOIN "customers" c ON c."id" = o."customer_id" WHERE ${topWhereClause} GROUP BY o."customer_id", c."email", c."first_name", c."last_name" ORDER BY SUM(o."total") DESC LIMIT $${topIdx} OFFSET $${topIdx + 1}`,
      ...topParams, limit, skip
    );

    let buckets = [];
    let bucketMeta = null;
    if (trunc) {
      const cond = [`c."tenant_id" = $1`];
      const params = [tenantId];
      let idx = 2;
      if (fromDate) { cond.push(`c."created_at" >= $${idx}`); params.push(fromDate); idx++; }
      if (toDate) { cond.push(`c."created_at" <= $${idx}`); params.push(toDate); idx++; }
      const whereClause = cond.join(' AND ');
      const countRows = await this.prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int as cnt FROM (SELECT date_trunc('${trunc}', c."created_at" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' as bucket FROM "customers" c WHERE ${whereClause} GROUP BY bucket) s`,
        ...params
      );
      const totalBuckets = Number(countRows[0]?.cnt ?? 0);
      const dataRows = await this.prisma.$queryRawUnsafe(
        `SELECT date_trunc('${trunc}', c."created_at" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' as bucket, COUNT(*)::int as "newCustomers" FROM "customers" c WHERE ${whereClause} GROUP BY bucket ORDER BY bucket ASC LIMIT $${idx} OFFSET $${idx + 1}`,
        ...params, limit, skip
      );
      buckets = dataRows.map((r) => ({ bucket: r.bucket ? new Date(r.bucket).toISOString() : null, newCustomers: Number(r.newCustomers) }));
      bucketMeta = { page, limit, total: totalBuckets, totalPages: Math.max(1, Math.ceil(totalBuckets / limit)) };
    }

    return {
      summary: {
        totalCustomers,
        totalOrders: orderCount,
        avgOrdersPerCustomer: totalCustomers > 0 ? (orderCount / totalCustomers).toFixed(2) : '0.00',
      },
      topCustomers: topRows.map((r) => ({
        customerId: r.customerId,
        email: r.email,
        firstName: r.firstName,
        lastName: r.lastName,
        orderCount: Number(r.orderCount),
        totalSpent: formatDecimal(r.totalSpent),
      })),
      meta: { page, limit, total: totalTopGroups, totalPages: Math.max(1, Math.ceil(totalTopGroups / limit)) },
      buckets: trunc ? buckets : undefined,
      bucketMeta,
    };
  }

  async getRevenue(tenantId, filters = {}) {
    const page = filters.page ?? 1;
    const limit = Math.min(filters.limit ?? 20, 100);
    const skip = (page - 1) * limit;
    const groupBy = filters.groupBy;
    const status = filters.status || 'COMPLETED';
    const fromDate = parseDateBound(filters.from, false);
    const toDate = parseDateBound(filters.to, true);
    const trunc = groupBy ? GROUP_BY_MAP[groupBy] : null;

    const baseWhere = { tenantId, status };
    if (fromDate || toDate) {
      baseWhere.createdAt = {};
      if (fromDate) baseWhere.createdAt.gte = fromDate;
      if (toDate) baseWhere.createdAt.lte = toDate;
    }

    // Gross revenue and refund totals
    const [revenueAgg, refundAgg, count] = await Promise.all([
      this.prisma.payment.aggregate({ where: baseWhere, _sum: { amount: true }, _count: { id: true } }),
      this.prisma.refund.aggregate({ where: { tenantId, status: 'COMPLETED', ...(fromDate || toDate ? { createdAt: { ...(fromDate ? { gte: fromDate } : {}), ...(toDate ? { lte: toDate } : {}) } } : {}) }, _sum: { amount: true } }),
      this.prisma.payment.count({ where: baseWhere }),
    ]);
    const grossRevenue = formatDecimal(revenueAgg._sum.amount);
    const totalRefunded = formatDecimal(refundAgg._sum.amount);
    const netRevenue = (parseFloat(grossRevenue) - parseFloat(totalRefunded)).toFixed(2);

    if (!trunc) {
      return {
        summary: { grossRevenue, totalRefunded, netRevenue, paymentCount: count },
        data: [{ bucket: null, grossRevenue, totalRefunded, netRevenue, paymentCount: count }],
        meta: { page: 1, limit: 1, total: 1, totalPages: 1 },
      };
    }

    const conditions = [`p."tenant_id" = $1`, `p."status" = $2::"PaymentStatus"`];
    const params = [tenantId, status];
    let idx = 3;
    if (fromDate) { conditions.push(`p."created_at" >= $${idx}`); params.push(fromDate); idx++; }
    if (toDate) { conditions.push(`p."created_at" <= $${idx}`); params.push(toDate); idx++; }
    const whereClause = conditions.join(' AND ');
    const countRows = await this.prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int as cnt FROM (SELECT date_trunc('${trunc}', p."created_at" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' as bucket FROM "payments" p WHERE ${whereClause} GROUP BY bucket) s`,
      ...params
    );
    const totalBuckets = Number(countRows[0]?.cnt ?? 0);
    const dataRows = await this.prisma.$queryRawUnsafe(
      `SELECT date_trunc('${trunc}', p."created_at" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' as bucket, COUNT(*)::int as "paymentCount", COALESCE(SUM(p."amount"),0)::text as "grossRevenue" FROM "payments" p WHERE ${whereClause} GROUP BY bucket ORDER BY bucket ASC LIMIT $${idx} OFFSET $${idx + 1}`,
      ...params, limit, skip
    );
    const data = dataRows.map((r) => ({
      bucket: r.bucket ? new Date(r.bucket).toISOString() : null,
      paymentCount: Number(r.paymentCount),
      grossRevenue: formatDecimal(r.grossRevenue),
    }));
    return {
      summary: { grossRevenue, totalRefunded, netRevenue, paymentCount: count },
      data,
      meta: { page, limit, total: totalBuckets, totalPages: Math.max(1, Math.ceil(totalBuckets / limit)) },
    };
  }
}
