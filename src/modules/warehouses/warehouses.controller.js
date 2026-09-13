import { WarehouseService } from './warehouses.service.js';

const warehouseService = new WarehouseService();

export async function createWarehouse(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const warehouse = await warehouseService.create(tenantId, req.body);
    res.status(201).json({ success: true, data: warehouse, message: 'Warehouse created successfully' });
  } catch (error) { next(error); }
}

export async function getWarehouse(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { id } = req.params;
    const warehouse = await warehouseService.getById(id, tenantId);
    res.status(200).json({ success: true, data: warehouse, message: 'Warehouse retrieved successfully' });
  } catch (error) { next(error); }
}

export async function listWarehouses(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { page, limit, search, isActive } = req.query;
    const result = await warehouseService.list(tenantId, {
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 20,
      search,
      isActive: isActive !== undefined ? isActive === 'true' : undefined,
    });
    res.status(200).json({ success: true, data: result.data, meta: result.meta, message: 'Warehouses retrieved successfully' });
  } catch (error) { next(error); }
}

export async function updateWarehouse(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { id } = req.params;
    const warehouse = await warehouseService.update(id, tenantId, req.body);
    res.status(200).json({ success: true, data: warehouse, message: 'Warehouse updated successfully' });
  } catch (error) { next(error); }
}

export async function deleteWarehouse(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { id } = req.params;
    await warehouseService.delete(id, tenantId);
    res.status(200).json({ success: true, data: null, message: 'Warehouse deleted successfully' });
  } catch (error) { next(error); }
}
