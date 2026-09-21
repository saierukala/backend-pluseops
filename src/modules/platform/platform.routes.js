import { Router } from 'express';
import { z } from 'zod';
import {
  listTenants,
  getTenant,
  createTenant,
  updateTenant,
  updateTenantStatus,
  createTenantAdmin,
} from './platform.controller.js';
import {
  createTenantWithAdminSchema,
  createTenantOnlySchema,
  listTenantsQuerySchema,
  getTenantParamsSchema,
  updateTenantSchema,
  updateTenantStatusSchema,
  createTenantAdminSchema,
} from './platform.validation.js';
import { authenticatePlatform } from '../auth/auth.middleware.js';
import { authorizePlatform } from '../auth/authorization.middleware.js';

function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse({ body: req.body, params: req.params, query: req.query });
    if (!result.success) {
      const error = new z.ZodError(result.error.issues);
      return next(error);
    }
    if (result.data.body !== undefined) req.body = result.data.body;
    if (result.data.params !== undefined) req.params = result.data.params;
    if (result.data.query !== undefined) {
      // Express 5 makes req.query a getter; define own property to override parsed string values with coerced numbers
      try {
        Object.defineProperty(req, 'query', { value: result.data.query, writable: true, configurable: true });
      } catch {
        // Fallback for Express 4: merge
        Object.keys(req.query).forEach((k) => delete req.query[k]);
        Object.assign(req.query, result.data.query);
      }
    }
    next();
  };
}

function validateCreateTenant(req, res, next) {
  const hasAdmin = !!req.body.admin;
  const schema = hasAdmin ? createTenantWithAdminSchema : createTenantOnlySchema;
  const result = schema.safeParse({ body: req.body, params: req.params, query: req.query });
  if (!result.success) {
    const error = new z.ZodError(result.error.issues);
    return next(error);
  }
  req.body = result.data.body;
  next();
}

export const platformRouter = Router();

// All platform routes require platform authentication + platform permission
platformRouter.use(authenticatePlatform());
platformRouter.use((req, res, next) => {
  // Ensure platform scope; authorize will check permissions per route
  next();
});

platformRouter.get('/tenants', validate(listTenantsQuerySchema), authorizePlatform('platform:tenant:read'), listTenants);
platformRouter.post('/tenants', validateCreateTenant, authorizePlatform('platform:tenant:create'), createTenant);
platformRouter.get('/tenants/:id', validate(getTenantParamsSchema), authorizePlatform('platform:tenant:read'), getTenant);
platformRouter.patch('/tenants/:id', validate(updateTenantSchema), authorizePlatform('platform:tenant:update'), updateTenant);
platformRouter.patch('/tenants/:id/status', validate(updateTenantStatusSchema), authorizePlatform('platform:tenant:suspend'), updateTenantStatus);
platformRouter.post('/tenants/:id/admin', validate(createTenantAdminSchema), authorizePlatform('platform:tenant:create'), createTenantAdmin);
