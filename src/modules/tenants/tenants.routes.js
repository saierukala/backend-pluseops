import { Router } from 'express';
import { z } from 'zod';
import {
  createTenant,
  getTenant,
  updateTenant,
  deleteTenant,
} from './tenants.controller.js';
import {
  createTenantSchema,
  updateTenantSchema,
  getTenantSchema,
  deleteTenantSchema,
} from './tenants.validation.js';
import { authenticatePlatform } from '../auth/auth.middleware.js';
import { authorizePlatform } from '../auth/authorization.middleware.js';

function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse({
      body: req.body,
      params: req.params,
      query: req.query,
    });
    if (!result.success) {
      const error = new z.ZodError(result.error.issues);
      return next(error);
    }
    req.body = result.data.body;
    req.params = result.data.params;
    next();
  };
}

export const tenantsRouter = Router();

// Legacy tenant CRUD: platform administrators only (Phase 26). Prefer /api/v1/platform/tenants,
// which also provisions roles and a first admin; this router is kept for raw CRUD and deletion.
tenantsRouter.use(authenticatePlatform());

tenantsRouter.post('/', validate(createTenantSchema), authorizePlatform('platform:tenant:create'), createTenant);
tenantsRouter.get('/:id', validate(getTenantSchema), authorizePlatform('platform:tenant:read'), getTenant);
tenantsRouter.patch('/:id', validate(updateTenantSchema), authorizePlatform('platform:tenant:update'), updateTenant);
tenantsRouter.delete('/:id', validate(deleteTenantSchema), authorizePlatform('platform:tenant:delete'), deleteTenant);