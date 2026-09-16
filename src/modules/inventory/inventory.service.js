import { getPrismaClient } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import { InventoryRepository } from './inventory.repository.js';
import { emitInventoryLowStock } from '../../realtime/realtime.service.js';

const LOW_STOCK_THRESHOLD = 10;

export class InventoryService {
  constructor() {
    this.repository = new InventoryRepository();
    this.prisma = getPrismaClient();
  }

  async list(tenantId, options) {
    return this.repository.list(tenantId, options);
  }

  async getByVariant(tenantId, variantId) {
    const variant = await this.prisma.productVariant.findFirst({ where: { id: variantId, tenantId } });
    if (!variant) throw new AppError('Variant not found', { statusCode: 404, code: 'VARIANT_NOT_FOUND' });
    const inventory = await this.repository.findByVariant(tenantId, variantId);
    return inventory;
  }

  async lowStock(tenantId, options) {
    return this.repository.lowStock(tenantId, options);
  }

  async movements(tenantId, options) {
    return this.repository.listMovements(tenantId, options);
  }

  resolveVariantId(body) {
    return body.variantId || body.productVariantId;
  }

  async adjust(tenantId, userId, body) {
    const variantId = this.resolveVariantId(body);
    const warehouseId = body.warehouseId;
    const quantityChanged = body.quantityChanged ?? body.quantity;
    const reason = body.reason || 'ADJUSTMENT';
    const referenceType = body.referenceType || null;
    const referenceId = body.referenceId || null;

    if (!variantId || !warehouseId) throw new AppError('variantId and warehouseId are required', { statusCode: 400, code: 'VALIDATION_ERROR' });
    if (quantityChanged === 0) throw new AppError('quantityChanged must be non-zero', { statusCode: 400, code: 'INVALID_QUANTITY' });

    const variant = await this.prisma.productVariant.findFirst({ where: { id: variantId, tenantId } });
    if (!variant) throw new AppError('Variant not found', { statusCode: 404, code: 'VARIANT_NOT_FOUND' });

    const warehouse = await this.prisma.warehouse.findFirst({ where: { id: warehouseId, tenantId } });
    if (!warehouse) throw new AppError('Warehouse not found', { statusCode: 404, code: 'WAREHOUSE_NOT_FOUND' });

    // Retry wrapper for serialization failures (could not serialize access)
    const execute = async (maxRetries = 3) => {
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          return await this.prisma.$transaction(async (tx) => {
      // Lock inventory row for update - select for update
      const locked = await tx.$queryRaw`SELECT "quantity" FROM "inventory" WHERE "tenant_id" = ${tenantId} AND "product_variant_id" = ${variantId} AND "warehouse_id" = ${warehouseId} FOR UPDATE`;
      let before = 0;
      let exists = false;
      if (locked.length > 0) {
        before = locked[0].quantity;
        exists = true;
      }
      const after = before + quantityChanged;
      if (after < 0) {
        throw new AppError(`Insufficient stock: current ${before}, change ${quantityChanged}`, { statusCode: 400, code: 'INSUFFICIENT_STOCK' });
      }

      if (exists) {
        // Conditional update ensures no negative due to race - but we already hold lock
        await tx.$executeRaw`UPDATE "inventory" SET "quantity" = ${after}, "updated_at" = NOW() WHERE "tenant_id" = ${tenantId} AND "product_variant_id" = ${variantId} AND "warehouse_id" = ${warehouseId}`;
        // Sync warehouse_inventory
        await tx.$executeRaw`INSERT INTO "warehouse_inventory" ("id", "tenant_id", "warehouse_id", "product_variant_id", "quantity", "reserved_quantity", "created_at", "updated_at") VALUES (gen_random_uuid(), ${tenantId}, ${warehouseId}, ${variantId}, ${after}, 0, NOW(), NOW()) ON CONFLICT ("tenant_id", "warehouse_id", "product_variant_id") DO UPDATE SET "quantity" = ${after}, "updated_at" = NOW()`;
      } else {
        // Create inventory row
        await tx.inventory.create({ data: { tenantId, productVariantId: variantId, warehouseId, quantity: after, reservedQuantity: 0 } });
        // Also ensure warehouse_inventory exists
        await tx.warehouseInventory.upsert({
          where: { tenantId_warehouseId_productVariantId: { tenantId, warehouseId, productVariantId: variantId } },
          update: { quantity: after },
          create: { tenantId, warehouseId, productVariantId: variantId, quantity: after, reservedQuantity: 0 },
        });
      }

      const movement = await tx.inventoryMovement.create({
        data: {
          tenantId,
          productVariantId: variantId,
          warehouseId,
          type: 'ADJUSTMENT',
          quantityBefore: before,
          quantityChanged,
          quantityAfter: after,
          reason,
          referenceType,
          referenceId,
          createdBy: userId,
        },
      });

      return { quantityBefore: before, quantityAfter: after, quantityChanged, movement };
          });
        } catch (err) {
          // Prisma serialization failure (40001) or deadlock (40P01)
          const code = err?.code || err?.meta?.code;
          const isRetryable = code === 'P2010' || err?.message?.includes('could not serialize') || err?.message?.includes('deadlock');
          // Also check inner meta code
          const metaCode = err?.meta?.code;
          const isSerRetry = metaCode === '40001' || metaCode === '40P01';
          if ((isRetryable || isSerRetry) && attempt < maxRetries - 1) {
            await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
            continue;
          }
          throw err;
        }
      }
      throw new Error('Max retries exceeded');
    };
    const result = await execute();
    // Emit low_stock if quantity dropped to/below threshold
    try {
      if (result.quantityAfter <= LOW_STOCK_THRESHOLD) {
        emitInventoryLowStock(tenantId, {
          productVariantId: variantId,
          warehouseId,
          quantity: result.quantityAfter,
          threshold: LOW_STOCK_THRESHOLD,
          quantityBefore: result.quantityBefore,
        });
      }
    } catch (_e) { void _e; }
    return result;
  }

  async getOverview(tenantId) {
    return this.repository.getOverview(tenantId);
  }

  async transfer(tenantId, userId, body) {
    const variantId = this.resolveVariantId(body);
    const sourceWarehouseId = body.sourceWarehouseId || body.warehouseId;
    const destinationWarehouseId = body.destinationWarehouseId || body.destWarehouseId;
    const quantity = body.quantity;
    const reason = body.reason || 'TRANSFER';
    const referenceType = body.referenceType || 'TRANSFER';
    const referenceId = body.referenceId || null;

    if (!variantId || !sourceWarehouseId || !destinationWarehouseId) throw new AppError('variantId, sourceWarehouseId and destinationWarehouseId are required', { statusCode: 400, code: 'VALIDATION_ERROR' });
    if (sourceWarehouseId === destinationWarehouseId) throw new AppError('Source and destination warehouses must be different', { statusCode: 400, code: 'SAME_WAREHOUSE' });
    if (!quantity || quantity <= 0) throw new AppError('Quantity must be positive', { statusCode: 400, code: 'INVALID_QUANTITY' });

    const variant = await this.prisma.productVariant.findFirst({ where: { id: variantId, tenantId } });
    if (!variant) throw new AppError('Variant not found', { statusCode: 404, code: 'VARIANT_NOT_FOUND' });

    const sourceWarehouse = await this.prisma.warehouse.findFirst({ where: { id: sourceWarehouseId, tenantId } });
    if (!sourceWarehouse) throw new AppError('Source warehouse not found', { statusCode: 404, code: 'WAREHOUSE_NOT_FOUND' });

    const destWarehouse = await this.prisma.warehouse.findFirst({ where: { id: destinationWarehouseId, tenantId } });
    if (!destWarehouse) throw new AppError('Destination warehouse not found', { statusCode: 404, code: 'WAREHOUSE_NOT_FOUND' });

    const executeTransfer = async (maxRetries = 3) => {
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          return await this.prisma.$transaction(async (tx) => {
      // Lock in deterministic order to avoid deadlock
      const idsSorted = [sourceWarehouseId, destinationWarehouseId].sort();
      for (const wid of idsSorted) {
        await tx.$queryRaw`SELECT "quantity" FROM "inventory" WHERE "tenant_id" = ${tenantId} AND "product_variant_id" = ${variantId} AND "warehouse_id" = ${wid} FOR UPDATE`;
      }

      const sourceRows = await tx.$queryRaw`SELECT "quantity" FROM "inventory" WHERE "tenant_id" = ${tenantId} AND "product_variant_id" = ${variantId} AND "warehouse_id" = ${sourceWarehouseId}`;
      const destRows = await tx.$queryRaw`SELECT "quantity" FROM "inventory" WHERE "tenant_id" = ${tenantId} AND "product_variant_id" = ${variantId} AND "warehouse_id" = ${destinationWarehouseId}`;

      const sourceBefore = sourceRows.length > 0 ? sourceRows[0].quantity : 0;
      const destBefore = destRows.length > 0 ? destRows[0].quantity : 0;
      const sourceExists = sourceRows.length > 0;
      const destExists = destRows.length > 0;

      if (sourceBefore < quantity) {
        throw new AppError(`Insufficient stock in source warehouse: current ${sourceBefore}, required ${quantity}`, { statusCode: 400, code: 'INSUFFICIENT_STOCK' });
      }

      const sourceAfter = sourceBefore - quantity;
      const destAfter = destBefore + quantity;

      // Update source
      if (sourceExists) {
        await tx.$executeRaw`UPDATE "inventory" SET "quantity" = ${sourceAfter}, "updated_at" = NOW() WHERE "tenant_id" = ${tenantId} AND "product_variant_id" = ${variantId} AND "warehouse_id" = ${sourceWarehouseId}`;
        await tx.$executeRaw`INSERT INTO "warehouse_inventory" ("id", "tenant_id", "warehouse_id", "product_variant_id", "quantity", "reserved_quantity", "created_at", "updated_at") VALUES (gen_random_uuid(), ${tenantId}, ${sourceWarehouseId}, ${variantId}, ${sourceAfter}, 0, NOW(), NOW()) ON CONFLICT ("tenant_id", "warehouse_id", "product_variant_id") DO UPDATE SET "quantity" = ${sourceAfter}, "updated_at" = NOW()`;
      } else {
        // Should not reach here because sourceBefore would be 0 and insufficient check would fail; but keep logic
        await tx.inventory.create({ data: { tenantId, productVariantId: variantId, warehouseId: sourceWarehouseId, quantity: sourceAfter } });
      }

      // Update destination
      if (destExists) {
        await tx.$executeRaw`UPDATE "inventory" SET "quantity" = ${destAfter}, "updated_at" = NOW() WHERE "tenant_id" = ${tenantId} AND "product_variant_id" = ${variantId} AND "warehouse_id" = ${destinationWarehouseId}`;
        await tx.$executeRaw`INSERT INTO "warehouse_inventory" ("id", "tenant_id", "warehouse_id", "product_variant_id", "quantity", "reserved_quantity", "created_at", "updated_at") VALUES (gen_random_uuid(), ${tenantId}, ${destinationWarehouseId}, ${variantId}, ${destAfter}, 0, NOW(), NOW()) ON CONFLICT ("tenant_id", "warehouse_id", "product_variant_id") DO UPDATE SET "quantity" = ${destAfter}, "updated_at" = NOW()`;
      } else {
        await tx.inventory.create({ data: { tenantId, productVariantId: variantId, warehouseId: destinationWarehouseId, quantity: destAfter } });
        await tx.warehouseInventory.upsert({
          where: { tenantId_warehouseId_productVariantId: { tenantId, warehouseId: destinationWarehouseId, productVariantId: variantId } },
          update: { quantity: destAfter },
          create: { tenantId, warehouseId: destinationWarehouseId, productVariantId: variantId, quantity: destAfter },
        });
      }

      const transferRefId = referenceId || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

      const sourceMovement = await tx.inventoryMovement.create({
        data: {
          tenantId,
          productVariantId: variantId,
          warehouseId: sourceWarehouseId,
          type: 'TRANSFER',
          quantityBefore: sourceBefore,
          quantityChanged: -quantity,
          quantityAfter: sourceAfter,
          reason,
          referenceType,
          referenceId: transferRefId,
          createdBy: userId,
        },
      });

      const destMovement = await tx.inventoryMovement.create({
        data: {
          tenantId,
          productVariantId: variantId,
          warehouseId: destinationWarehouseId,
          type: 'TRANSFER',
          quantityBefore: destBefore,
          quantityChanged: quantity,
          quantityAfter: destAfter,
          reason,
          referenceType,
          referenceId: transferRefId,
          createdBy: userId,
        },
      });

      return { sourceBefore, sourceAfter, destBefore, destAfter, sourceMovement, destMovement };
          });
        } catch (err) {
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
    const result = await executeTransfer();
    try {
      // If source dropped into low stock after transfer, emit
      if (result.sourceAfter <= LOW_STOCK_THRESHOLD) {
        emitInventoryLowStock(tenantId, {
          productVariantId: variantId,
          warehouseId: sourceWarehouseId,
          quantity: result.sourceAfter,
          threshold: LOW_STOCK_THRESHOLD,
          quantityBefore: result.sourceBefore,
        });
      }
      if (result.destAfter <= LOW_STOCK_THRESHOLD) {
        emitInventoryLowStock(tenantId, {
          productVariantId: variantId,
          warehouseId: destinationWarehouseId,
          quantity: result.destAfter,
          threshold: LOW_STOCK_THRESHOLD,
          quantityBefore: result.destBefore,
        });
      }
    } catch (_e) { void _e; }
    return result;
  }
}
