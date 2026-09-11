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

tenantsRouter.post('/', validate(createTenantSchema), createTenant);
tenantsRouter.get('/:id', validate(getTenantSchema), getTenant);
tenantsRouter.patch('/:id', validate(updateTenantSchema), updateTenant);
tenantsRouter.delete('/:id', validate(deleteTenantSchema), deleteTenant);