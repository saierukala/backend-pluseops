import { getPrismaClient } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import { OrderRepository } from './orders.repository.js';
import { auditService } from '../audit/audit.service.js';
import { emitOrderCreated, emitOrderUpdated } from '../../realtime/realtime.service.js';

const ORDER_STATUS_TRANSITIONS = {
  DRAFT: ['PENDING', 'CANCELLED'],
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['DELIVERED'],
  DELIVERED: ['REFUNDED', 'PARTIALLY_REFUNDED'],
  CANCELLED: [],
  REFUNDED: [],
  PARTIALLY_REFUNDED: ['REFUNDED'],
};

const CANCELLABLE_STATUSES = ['DRAFT', 'PENDING', 'CONFIRMED', 'PROCESSING'];

function isValidTransition(from, to) {
  if (!from) return true;
  if (from === to) return false;
  const allowed = ORDER_STATUS_TRANSITIONS[from] || [];
  return allowed.includes(to);
}

export class OrderService {
  constructor() {
    this.repository = new OrderRepository();
    this.prisma = getPrismaClient();
  }

  async create(tenantId, userId, body, auditContext = {}) {
    const customerId = body.customerId;
    const itemsInput = body.items;
    const shippingTotalStr = body.shippingTotal || '0';
    const currency = body.currency || 'USD';
    const metadata = body.metadata || {};

    // Validate customer exists tenant-scoped
    const customer = await this.prisma.customer.findFirst({ where: { id: customerId, tenantId } });
    if (!customer) throw new AppError('Customer not found', { statusCode: 404, code: 'CUSTOMER_NOT_FOUND' });

    // Normalize items: resolve productVariantId
    const normalizedItems = itemsInput.map((it) => ({
      productVariantId: it.productVariantId || it.variantId,
      warehouseId: it.warehouseId,
      quantity: it.quantity,
      discount: it.discount || '0',
      tax: it.tax || '0',
    }));

    // Validate all variants and warehouses exist tenant-scoped, collect variant data
    const variantIds = [...new Set(normalizedItems.map((i) => i.productVariantId))];
    const warehouseIds = [...new Set(normalizedItems.map((i) => i.warehouseId))];

    // Fetch variants with product and attributes for snapshots
    const variants = await this.prisma.productVariant.findMany({
      where: { id: { in: variantIds }, tenantId },
      include: {
        product: { select: { id: true, name: true } },
        attributes: { include: { attributeDefinition: true } },
      },
    });
    const variantMap = new Map(variants.map((v) => [v.id, v]));
    for (const item of normalizedItems) {
      const v = variantMap.get(item.productVariantId);
      if (!v) throw new AppError(`Variant ${item.productVariantId} not found`, { statusCode: 404, code: 'VARIANT_NOT_FOUND' });
      if (v.status !== 'ACTIVE') throw new AppError(`Variant ${item.productVariantId} is not sellable (status ${v.status})`, { statusCode: 400, code: 'VARIANT_NOT_SELLABLE' });
    }

    // Validate warehouses
    const warehouses = await this.prisma.warehouse.findMany({ where: { id: { in: warehouseIds }, tenantId } });
    const warehouseMap = new Map(warehouses.map((w) => [w.id, w]));
    for (const item of normalizedItems) {
      if (!warehouseMap.has(item.warehouseId)) throw new AppError(`Warehouse ${item.warehouseId} not found`, { statusCode: 404, code: 'WAREHOUSE_NOT_FOUND' });
    }

    // Validate quantities and compute totals server-side using variant.price authoritative
    // Use integer cents to avoid float errors, but keep Decimal string handling
    let subtotalCents = 0;
    let discountTotalCents = 0;
    let taxTotalCents = 0;
    const shippingCents = Math.round(parseFloat(shippingTotalStr) * 100);

    const itemCalculations = [];
    for (const item of normalizedItems) {
      const variant = variantMap.get(item.productVariantId);
      const unitPriceStr = variant.price.toString();
      const unitCents = Math.round(parseFloat(unitPriceStr) * 100);
      const qty = item.quantity;
      if (qty <= 0) throw new AppError('Quantity must be positive', { statusCode: 400, code: 'INVALID_QUANTITY' });
      const discountCents = Math.round(parseFloat(item.discount) * 100);
      const taxCents = Math.round(parseFloat(item.tax) * 100);
      if (discountCents < 0 || taxCents < 0) throw new AppError('Discount/tax cannot be negative', { statusCode: 400, code: 'INVALID_MONEY' });
      const lineTotalCents = unitCents * qty - discountCents + taxCents;
      if (lineTotalCents < 0) throw new AppError('Line total cannot be negative', { statusCode: 400, code: 'INVALID_LINE_TOTAL' });
      subtotalCents += unitCents * qty;
      discountTotalCents += discountCents;
      taxTotalCents += taxCents;
      itemCalculations.push({
        productVariantId: item.productVariantId,
        warehouseId: item.warehouseId,
        quantity: qty,
        unitPriceStr,
        discountStr: (discountCents / 100).toFixed(2),
        taxStr: (taxCents / 100).toFixed(2),
        lineTotalStr: (lineTotalCents / 100).toFixed(2),
        variant,
      });
    }
    const totalCents = subtotalCents - discountTotalCents + taxTotalCents + shippingCents;
    const subtotalStr = (subtotalCents / 100).toFixed(2);
    const discountTotalStr = (discountTotalCents / 100).toFixed(2);
    const taxTotalStr = (taxTotalCents / 100).toFixed(2);
    const totalStr = (totalCents / 100).toFixed(2);
    const shippingTotalFixed = (shippingCents / 100).toFixed(2);

    // Transaction with inventory locking
    const execute = async (maxRetries = 3) => {
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          return await this.prisma.$transaction(async (tx) => {
            // Lock inventory rows in deterministic order to avoid deadlock
            // Sort by variantId + warehouseId
            const lockKeys = [...itemCalculations].sort((a, b) => `${a.productVariantId}-${a.warehouseId}`.localeCompare(`${b.productVariantId}-${b.warehouseId}`));
            for (const it of lockKeys) {
              await tx.$queryRaw`SELECT "quantity" FROM "inventory" WHERE "tenant_id" = ${tenantId} AND "product_variant_id" = ${it.productVariantId} AND "warehouse_id" = ${it.warehouseId} FOR UPDATE`;
            }

            // Validate inventory availability and deduct
            for (const it of itemCalculations) {
              const rows = await tx.$queryRaw`SELECT "quantity" FROM "inventory" WHERE "tenant_id" = ${tenantId} AND "product_variant_id" = ${it.productVariantId} AND "warehouse_id" = ${it.warehouseId}`;
              const currentQty = rows.length > 0 ? rows[0].quantity : 0;
              if (currentQty < it.quantity) {
                throw new AppError(`Insufficient stock for variant ${it.productVariantId} in warehouse ${it.warehouseId}: available ${currentQty}, requested ${it.quantity}`, { statusCode: 400, code: 'INSUFFICIENT_STOCK' });
              }
              const afterQty = currentQty - it.quantity;
              // Check if inventory row exists
              if (rows.length > 0) {
                await tx.$executeRaw`UPDATE "inventory" SET "quantity" = ${afterQty}, "updated_at" = NOW() WHERE "tenant_id" = ${tenantId} AND "product_variant_id" = ${it.productVariantId} AND "warehouse_id" = ${it.warehouseId}`;
                await tx.$executeRaw`INSERT INTO "warehouse_inventory" ("id", "tenant_id", "warehouse_id", "product_variant_id", "quantity", "reserved_quantity", "created_at", "updated_at") VALUES (gen_random_uuid(), ${tenantId}, ${it.warehouseId}, ${it.productVariantId}, ${afterQty}, 0, NOW(), NOW()) ON CONFLICT ("tenant_id", "warehouse_id", "product_variant_id") DO UPDATE SET "quantity" = ${afterQty}, "updated_at" = NOW()`;
              } else {
                // Should not happen because insufficient would have triggered, but handle
                throw new AppError(`Insufficient stock for variant ${it.productVariantId} in warehouse ${it.warehouseId}`, { statusCode: 400, code: 'INSUFFICIENT_STOCK' });
              }
            }

            // Create order
            const order = await tx.order.create({
              data: {
                tenantId,
                customerId,
                status: 'PENDING',
                subtotal: subtotalStr,
                discountTotal: discountTotalStr,
                taxTotal: taxTotalStr,
                shippingTotal: shippingTotalFixed,
                total: totalStr,
                currency,
                metadata,
              },
            });

            // Create order items with immutable snapshots
            for (const it of itemCalculations) {
              const variant = it.variant;
              const productName = variant.product.name;
              // variantNameSnapshot: use SKU + attribute values if available
              const attrSnapshot = {};
              let variantNameParts = [];
              for (const attr of variant.attributes) {
                attrSnapshot[attr.attributeDefinition.code] = attr.value;
                variantNameParts.push(`${attr.attributeDefinition.name}=${attr.value}`);
              }
              const variantNameSnapshot = variantNameParts.length > 0 ? variantNameParts.join(', ') : variant.sku;
              await tx.orderItem.create({
                data: {
                  tenantId,
                  orderId: order.id,
                  productVariantId: it.productVariantId,
                  productNameSnapshot: productName,
                  variantNameSnapshot,
                  attributeSnapshot: attrSnapshot,
                  skuSnapshot: variant.sku,
                  unitPrice: it.unitPriceStr,
                  quantity: it.quantity,
                  discount: it.discountStr,
                  tax: it.taxStr,
                  lineTotal: it.lineTotalStr,
                },
              });
            }

            // Record inventory movements for each item (ORDER_RESERVATION)
            for (const it of itemCalculations) {
              // Need quantityBefore and after: we already know before = currentQty, after = currentQty - quantity
              // Re-fetch for accurate before/after? We have currentQty variable but it was inside loop above; redo fetch for movement detail
              // Instead, compute before as (after + quantity) is current before, but we have afterQty calculated above
              // To avoid re-query, we can store beforeQty in a map
              // Simplify: query again for before value (now after update, before = after + quantity)
              const rowsAfter = await tx.$queryRaw`SELECT "quantity" FROM "inventory" WHERE "tenant_id" = ${tenantId} AND "product_variant_id" = ${it.productVariantId} AND "warehouse_id" = ${it.warehouseId}`;
              const afterQty = rowsAfter[0].quantity;
              const beforeQty = afterQty + it.quantity;
              await tx.inventoryMovement.create({
                data: {
                  tenantId,
                  productVariantId: it.productVariantId,
                  warehouseId: it.warehouseId,
                  type: 'ORDER_RESERVATION',
                  quantityBefore: beforeQty,
                  quantityChanged: -it.quantity,
                  quantityAfter: afterQty,
                  reason: 'ORDER_CREATED',
                  referenceType: 'ORDER',
                  referenceId: order.id,
                  createdBy: userId,
                },
              });
            }

            // Create status history
            await tx.orderStatusHistory.create({
              data: {
                tenantId,
                orderId: order.id,
                fromStatus: null,
                toStatus: 'PENDING',
                reason: 'Order created',
                createdBy: userId,
              },
            });

            // Audit and activity logging atomically with order creation
            const ipAddress = auditContext.ipAddress || null;
            const userAgent = auditContext.userAgent || null;
            await auditService.logAudit({
              tenantId, userId, action: 'CREATE', resource: 'order', resourceId: order.id,
              oldValue: null,
              newValue: { orderId: order.id, customerId, total: totalStr, itemCount: itemCalculations.length },
              ipAddress, userAgent, tx,
            });
            await auditService.logActivity({
              tenantId, userId, action: 'order.create',
              description: `Order ${order.id} created`,
              metadata: { orderId: order.id, total: totalStr, itemCount: itemCalculations.length },
              ipAddress, userAgent, tx,
            });

            // Return full order with items and history
            const full = await tx.order.findFirst({
              where: { id: order.id, tenantId },
              include: {
                customer: true,
                items: { include: { productVariant: { select: { id: true, sku: true } } } },
                statusHistory: { orderBy: { createdAt: 'asc' } },
              },
            });
            return full;
          });
        } catch (err) {
          if (err instanceof AppError) throw err;
          const metaCode = err?.meta?.code;
          const isRetryable = err?.code === 'P2010' || metaCode === '40001' || metaCode === '40P01' || err?.message?.includes('could not serialize') || err?.message?.includes('deadlock');
          if (isRetryable && attempt < maxRetries - 1) {
            await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
            continue;
          }
          throw err;
        }
      }
      throw new Error('Max retries exceeded');
    };

    const result = await execute();
    // Emit realtime event with minimal payload after transaction success
    try {
      emitOrderCreated(tenantId, {
        id: result.id,
        tenantId,
        customerId: result.customerId,
        status: result.status,
        total: result.total?.toString?.() ?? String(result.total),
        currency: result.currency,
        createdAt: result.createdAt,
      });
    } catch (_e) { void _e; }
    // Phase 15: enqueue async notification for order creation (non-blocking, tenant-isolated)
    // Do not await failure; HTTP should not block on notification delivery
    try {
      const { enqueueNotification } = await import('../../jobs/queues/notification.queue.js');
      enqueueNotification({
        tenantId,
        userId,
        type: 'SUCCESS',
        title: 'Order created',
        message: `Order ${result.id} created with total ${result.total}`,
        channel: 'IN_APP',
        referenceType: 'ORDER',
        referenceId: result.id,
        metadata: { orderId: result.id, total: result.total?.toString?.() ?? String(result.total) },
        idempotencyKey: `order:${result.id}`,
      }).catch(() => {});
    } catch (_e) { void _e; }
    return result;
  }

  async list(tenantId, options) {
    return this.repository.list(tenantId, options);
  }

  async getById(id, tenantId) {
    const order = await this.repository.findById(id, tenantId);
    if (!order) throw new AppError('Order not found', { statusCode: 404, code: 'ORDER_NOT_FOUND' });
    return order;
  }

  async getHistory(id, tenantId, options) {
    await this.getById(id, tenantId);
    return this.repository.getHistory(id, tenantId, options);
  }

  async updateStatus(id, tenantId, userId, status, reason, auditContext = {}) {
    const order = await this.getById(id, tenantId);
    if (!isValidTransition(order.status, status)) {
      throw new AppError(`Invalid status transition from ${order.status} to ${status}`, { statusCode: 400, code: 'INVALID_STATUS_TRANSITION' });
    }

    const ipAddress = auditContext.ipAddress || null;
    const userAgent = auditContext.userAgent || null;
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id },
        data: { status },
      });
      await tx.orderStatusHistory.create({
        data: {
          tenantId,
          orderId: id,
          fromStatus: order.status,
          toStatus: status,
          reason: reason || null,
          createdBy: userId,
        },
      });
      await auditService.logAudit({
        tenantId, userId, action: 'UPDATE', resource: 'order', resourceId: id,
        oldValue: { status: order.status },
        newValue: { status },
        ipAddress, userAgent, tx,
      });
      await auditService.logActivity({
        tenantId, userId, action: 'order.status_update',
        description: `Order ${id} status ${order.status} -> ${status}`,
        metadata: { orderId: id, fromStatus: order.status, toStatus: status },
        ipAddress, userAgent, tx,
      });
      return tx.order.findFirst({
        where: { id, tenantId },
        include: { customer: true, items: true, statusHistory: { orderBy: { createdAt: 'asc' } } },
      });
    });
    try {
      emitOrderUpdated(tenantId, {
        id: updated.id,
        tenantId,
        status: updated.status,
        previousStatus: order.status,
        updatedAt: updated.updatedAt,
      });
    } catch (_e) { void _e; }
    return updated;
  }

  async cancel(id, tenantId, userId, reason, auditContext = {}) {
    const order = await this.getById(id, tenantId);
    if (!CANCELLABLE_STATUSES.includes(order.status)) {
      throw new AppError(`Cannot cancel order in status ${order.status}`, { statusCode: 400, code: 'CANCELLATION_NOT_ALLOWED' });
    }
    if (order.status === 'CANCELLED') {
      throw new AppError('Order already cancelled', { statusCode: 400, code: 'ALREADY_CANCELLED' });
    }

    const ipAddress = auditContext.ipAddress || null;
    const userAgent = auditContext.userAgent || null;
    const result = await this.prisma.$transaction(async (tx) => {
      // Restore inventory for each item
      for (const item of order.items) {
        // Find the original reservation movement to know warehouse
        const movements = await tx.inventoryMovement.findMany({
          where: { tenantId, productVariantId: item.productVariantId, referenceType: 'ORDER', referenceId: order.id, type: 'ORDER_RESERVATION' },
        });
        if (movements.length > 0) {
          for (const mov of movements) {
            const warehouseId = mov.warehouseId;
            // Lock inventory row
            await tx.$queryRaw`SELECT "quantity" FROM "inventory" WHERE "tenant_id" = ${tenantId} AND "product_variant_id" = ${item.productVariantId} AND "warehouse_id" = ${warehouseId} FOR UPDATE`;
            const rows = await tx.$queryRaw`SELECT "quantity" FROM "inventory" WHERE "tenant_id" = ${tenantId} AND "product_variant_id" = ${item.productVariantId} AND "warehouse_id" = ${warehouseId}`;
            const beforeQty = rows.length > 0 ? rows[0].quantity : 0;
            // For cancellation, restore full quantity of this item per movement? There is one movement per item-warehouse
            // Use item.quantity if movements correspond 1:1, but if multiple warehouses per variant we restore each movement's changed quantity abs
            const restoreQty = Math.abs(mov.quantityChanged);
            const afterQty = beforeQty + restoreQty;
            if (rows.length > 0) {
              await tx.$executeRaw`UPDATE "inventory" SET "quantity" = ${afterQty}, "updated_at" = NOW() WHERE "tenant_id" = ${tenantId} AND "product_variant_id" = ${item.productVariantId} AND "warehouse_id" = ${warehouseId}`;
              await tx.$executeRaw`INSERT INTO "warehouse_inventory" ("id", "tenant_id", "warehouse_id", "product_variant_id", "quantity", "reserved_quantity", "created_at", "updated_at") VALUES (gen_random_uuid(), ${tenantId}, ${warehouseId}, ${item.productVariantId}, ${afterQty}, 0, NOW(), NOW()) ON CONFLICT ("tenant_id", "warehouse_id", "product_variant_id") DO UPDATE SET "quantity" = ${afterQty}, "updated_at" = NOW()`;
            } else {
              await tx.inventory.create({ data: { tenantId, productVariantId: item.productVariantId, warehouseId, quantity: afterQty } });
              await tx.warehouseInventory.create({ data: { tenantId, warehouseId, productVariantId: item.productVariantId, quantity: afterQty } });
            }
            await tx.inventoryMovement.create({
              data: {
                tenantId,
                productVariantId: item.productVariantId,
                warehouseId,
                type: 'ORDER_RELEASE',
                quantityBefore: beforeQty,
                quantityChanged: restoreQty,
                quantityAfter: afterQty,
                reason: reason || 'ORDER_CANCELLED',
                referenceType: 'ORDER',
                referenceId: order.id,
                createdBy: userId,
              },
            });
          }
        } else {
          // Fallback: if no movement found (legacy), try to restore using order item quantity assuming default warehouse?
          // For Phase 9, we require movements to exist; if not, skip restoration but still cancel order
          // Try to find any inventory for this variant
          const inventories = await tx.inventory.findMany({ where: { tenantId, productVariantId: item.productVariantId } });
          if (inventories.length > 0) {
            const inv = inventories[0];
            const beforeQty = inv.quantity;
            const afterQty = beforeQty + item.quantity;
            await tx.$executeRaw`UPDATE "inventory" SET "quantity" = ${afterQty}, "updated_at" = NOW() WHERE "tenant_id" = ${tenantId} AND "product_variant_id" = ${item.productVariantId} AND "warehouse_id" = ${inv.warehouseId}`;
            await tx.inventoryMovement.create({
              data: {
                tenantId,
                productVariantId: item.productVariantId,
                warehouseId: inv.warehouseId,
                type: 'ORDER_RELEASE',
                quantityBefore: beforeQty,
                quantityChanged: item.quantity,
                quantityAfter: afterQty,
                reason: reason || 'ORDER_CANCELLED',
                referenceType: 'ORDER',
                referenceId: order.id,
                createdBy: userId,
              },
            });
          }
        }
      }

      await tx.order.update({ where: { id }, data: { status: 'CANCELLED' } });
      await tx.orderStatusHistory.create({
        data: {
          tenantId,
          orderId: id,
          fromStatus: order.status,
          toStatus: 'CANCELLED',
          reason: reason || 'Order cancelled',
          createdBy: userId,
        },
      });
      await auditService.logAudit({
        tenantId, userId, action: 'UPDATE', resource: 'order', resourceId: id,
        oldValue: { status: order.status },
        newValue: { status: 'CANCELLED' },
        ipAddress, userAgent, tx,
      });
      await auditService.logActivity({
        tenantId, userId, action: 'order.cancel',
        description: `Order ${id} cancelled`,
        metadata: { orderId: id, fromStatus: order.status },
        ipAddress, userAgent, tx,
      });
      return tx.order.findFirst({ where: { id, tenantId }, include: { customer: true, items: true, statusHistory: { orderBy: { createdAt: 'asc' } } } });
    });
    try {
      emitOrderUpdated(tenantId, {
        id: result.id,
        tenantId,
        status: result.status,
        previousStatus: order.status,
        updatedAt: result.updatedAt,
      });
    } catch (_e) { void _e; }
    return result;
  }

  getStatusTransitions() {
    return ORDER_STATUS_TRANSITIONS;
  }
}
