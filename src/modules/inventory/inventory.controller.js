import { InventoryService } from './inventory.service.js';

const inventoryService = new InventoryService();

export async function listInventory(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { page, limit, warehouseId, variantId, warehouse_id, productVariantId, sku, search } = req.query;
    const result = await inventoryService.list(tenantId, {
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 20,
      warehouseId: warehouseId || warehouse_id,
      variantId: variantId || productVariantId,
      sku,
      search,
    });
    res.status(200).json({ success: true, data: result.data, meta: result.meta, pagination: result.meta, message: 'Inventory retrieved successfully' });
  } catch (error) { next(error); }
}

export async function getVariantInventory(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { variantId } = req.params;
    const data = await inventoryService.getByVariant(tenantId, variantId);
    res.status(200).json({ success: true, data, message: 'Variant inventory retrieved successfully' });
  } catch (error) { next(error); }
}

export async function adjustInventory(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const userId = req.context.userId;
    const result = await inventoryService.adjust(tenantId, userId, req.body);
    res.status(200).json({ success: true, data: result, message: 'Inventory adjusted successfully' });
  } catch (error) { next(error); }
}

export async function transferInventory(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const userId = req.context.userId;
    const result = await inventoryService.transfer(tenantId, userId, req.body);
    res.status(200).json({ success: true, data: result, message: 'Inventory transferred successfully' });
  } catch (error) { next(error); }
}

export async function listMovements(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { page, limit, variantId, productVariantId, warehouseId, type, reason } = req.query;
    const result = await inventoryService.movements(tenantId, {
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 20,
      variantId: variantId || productVariantId,
      warehouseId,
      type,
      reason,
    });
    res.status(200).json({ success: true, data: result.data, meta: result.meta, pagination: result.meta, message: 'Movements retrieved successfully' });
  } catch (error) { next(error); }
}

export async function lowStock(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { page, limit, threshold, warehouseId } = req.query;
    const t = threshold !== undefined ? parseInt(threshold) : 10;
    const result = await inventoryService.lowStock(tenantId, {
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 20,
      threshold: Number.isNaN(t) ? 10 : t,
      warehouseId,
    });
    res.status(200).json({ success: true, data: result.data, meta: result.meta, pagination: result.meta, message: 'Low stock inventory retrieved successfully' });
  } catch (error) { next(error); }
}
