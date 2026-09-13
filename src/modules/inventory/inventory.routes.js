import { Router } from 'express';
import { z } from 'zod';
import { listInventory, getVariantInventory, adjustInventory, transferInventory, listMovements, lowStock } from './inventory.controller.js';
import { adjustInventorySchema, transferInventorySchema, listInventoryQuerySchema, variantInventoryParamsSchema, movementsQuerySchema, lowStockQuerySchema } from './inventory.validation.js';
import { authenticate } from '../auth/auth.middleware.js';
import { authorize } from '../auth/authorization.middleware.js';

function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse({ body: req.body, params: req.params, query: req.query });
    if (!result.success) return next(new z.ZodError(result.error.issues));
    req.body = result.data.body;
    req.params = result.data.params;
    // query is coerced and validated, but keep original query with defaults applied
    // need to propagate defaults manually because we override query partially; use result.data.query merged
    if (result.data.query) {
      Object.assign(req.query, result.data.query);
    }
    next();
  };
}

export const inventoryRouter = Router();
inventoryRouter.use(authenticate());

// Order matters: specific paths before param
inventoryRouter.get('/', validate(listInventoryQuerySchema), authorize('inventory:read'), listInventory);
inventoryRouter.get('/movements', validate(movementsQuerySchema), authorize('inventory:read'), listMovements);
inventoryRouter.get('/low-stock', validate(lowStockQuerySchema), authorize('inventory:read'), lowStock);
inventoryRouter.get('/variants/:variantId', validate(variantInventoryParamsSchema), authorize('inventory:read'), getVariantInventory);
inventoryRouter.post('/adjust', validate(adjustInventorySchema), authorize('inventory:update'), adjustInventory);
inventoryRouter.post('/transfer', validate(transferInventorySchema), authorize('inventory:update'), transferInventory);
