import { Router } from 'express';
import { z } from 'zod';
import { createWarehouse, getWarehouse, listWarehouses, updateWarehouse, deleteWarehouse } from './warehouses.controller.js';
import { createWarehouseSchema, updateWarehouseSchema, getWarehouseSchema, deleteWarehouseSchema, listWarehousesQuerySchema } from './warehouses.validation.js';
import { authenticate } from '../auth/auth.middleware.js';
import { authorize } from '../auth/authorization.middleware.js';

function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse({ body: req.body, params: req.params, query: req.query });
    if (!result.success) return next(new z.ZodError(result.error.issues));
    req.body = result.data.body;
    req.params = result.data.params;
    next();
  };
}

export const warehousesRouter = Router();
warehousesRouter.use(authenticate());
warehousesRouter.post('/', validate(createWarehouseSchema), authorize('warehouse:create'), createWarehouse);
warehousesRouter.get('/', validate(listWarehousesQuerySchema), authorize('warehouse:read'), listWarehouses);
warehousesRouter.get('/:id', validate(getWarehouseSchema), authorize('warehouse:read'), getWarehouse);
warehousesRouter.patch('/:id', validate(updateWarehouseSchema), authorize('warehouse:update'), updateWarehouse);
warehousesRouter.delete('/:id', validate(deleteWarehouseSchema), authorize('warehouse:delete'), deleteWarehouse);
