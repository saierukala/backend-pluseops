import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../auth/auth.middleware.js';
import { authorize } from '../auth/authorization.middleware.js';
import {
  getOverview,
  getSales,
  getOrders,
  getInventory,
  getCustomers,
  getRevenue,
} from './analytics.controller.js';
import {
  analyticsOverviewQuerySchema,
  analyticsSalesQuerySchema,
  analyticsOrdersQuerySchema,
  analyticsInventoryQuerySchema,
  analyticsCustomersQuerySchema,
  analyticsRevenueQuerySchema,
} from './analytics.validation.js';

function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse({ body: req.body, params: req.params, query: req.query });
    if (!result.success) return next(new z.ZodError(result.error.issues));
    if (result.data.query) Object.assign(req.query, result.data.query);
    if (result.data.params) req.params = result.data.params;
    if (result.data.body) req.body = result.data.body;
    next();
  };
}

export const analyticsRouter = Router();
analyticsRouter.use(authenticate());

analyticsRouter.get('/overview', validate(analyticsOverviewQuerySchema), authorize('analytics:read'), getOverview);
analyticsRouter.get('/sales', validate(analyticsSalesQuerySchema), authorize('analytics:read'), getSales);
analyticsRouter.get('/orders', validate(analyticsOrdersQuerySchema), authorize('analytics:read'), getOrders);
analyticsRouter.get('/inventory', validate(analyticsInventoryQuerySchema), authorize('analytics:read'), getInventory);
analyticsRouter.get('/customers', validate(analyticsCustomersQuerySchema), authorize('analytics:read'), getCustomers);
analyticsRouter.get('/revenue', validate(analyticsRevenueQuerySchema), authorize('analytics:read'), getRevenue);
