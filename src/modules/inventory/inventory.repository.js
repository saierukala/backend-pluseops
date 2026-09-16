import { getPrismaClient } from '../../config/database.js';

export class InventoryRepository {
  constructor() {
    this.prisma = getPrismaClient();
  }

  async list(tenantId, options = {}) {
    const { page = 1, limit = 20, warehouseId, variantId, sku, search } = options;
    const skip = (page - 1) * limit;
    const take = Math.min(limit, 100);
    const where = { tenantId };
    if (warehouseId) where.warehouseId = warehouseId;
    if (variantId) where.productVariantId = variantId;
    if (sku) {
      where.productVariant = { sku: { contains: sku, mode: 'insensitive' }, tenantId };
    }
    if (search) {
      where.productVariant = {
        OR: [
          { sku: { contains: search, mode: 'insensitive' } },
          { barcode: { contains: search, mode: 'insensitive' } },
        ],
        tenantId,
      };
    }
    const [data, total] = await Promise.all([
      this.prisma.inventory.findMany({
        where,
        include: {
          productVariant: { select: { id: true, sku: true, barcode: true, price: true, productId: true } },
          warehouse: { select: { id: true, name: true, code: true } },
        },
        orderBy: { updatedAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.inventory.count({ where }),
    ]);
    return { data, meta: { page, limit: take, total, totalPages: Math.ceil(total / take) } };
  }

  async findByVariant(tenantId, variantId) {
    return this.prisma.inventory.findMany({
      where: { tenantId, productVariantId: variantId },
      include: {
        warehouse: { select: { id: true, name: true, code: true, city: true } },
        productVariant: { select: { id: true, sku: true, price: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async lowStock(tenantId, options = {}) {
    const { page = 1, limit = 20, threshold = 10, warehouseId } = options;
    const skip = (page - 1) * limit;
    const take = Math.min(limit, 100);
    const where = { tenantId, quantity: { lte: threshold } };
    if (warehouseId) where.warehouseId = warehouseId;
    const [data, total] = await Promise.all([
      this.prisma.inventory.findMany({
        where,
        include: {
          productVariant: { select: { id: true, sku: true, barcode: true, price: true } },
          warehouse: { select: { id: true, name: true, code: true } },
        },
        orderBy: { quantity: 'asc' },
        skip,
        take,
      }),
      this.prisma.inventory.count({ where }),
    ]);
    return { data, meta: { page, limit: take, total, totalPages: Math.ceil(total / take) } };
  }

  async listMovements(tenantId, options = {}) {
    const { page = 1, limit = 20, variantId, warehouseId, type, reason } = options;
    const skip = (page - 1) * limit;
    const take = Math.min(limit, 100);
    const where = { tenantId };
    if (variantId) where.productVariantId = variantId;
    if (warehouseId) where.warehouseId = warehouseId;
    if (type) where.type = type;
    if (reason) where.reason = { contains: reason, mode: 'insensitive' };
    const [data, total] = await Promise.all([
      this.prisma.inventoryMovement.findMany({
        where,
        include: {
          productVariant: { select: { id: true, sku: true } },
          warehouse: { select: { id: true, name: true, code: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.inventoryMovement.count({ where }),
    ]);
    return { data, meta: { page, limit: take, total, totalPages: Math.ceil(total / take) } };
  }

  async getOverview(tenantId) {
    const [warehouseCount, variantCount, lowStockCount, inventoryAgg] = await Promise.all([
      this.prisma.warehouse.count({ where: { tenantId } }),
      this.prisma.productVariant.count({ where: { tenantId } }),
      this.prisma.inventory.count({ where: { tenantId, quantity: { lte: 10 } } }),
      this.prisma.inventory.aggregate({ where: { tenantId }, _sum: { quantity: true } }),
    ]);
    return {
      warehouses: warehouseCount,
      variants: variantCount,
      lowStockItems: lowStockCount,
      totalQuantity: inventoryAgg._sum.quantity ?? 0,
    };
  }
}
