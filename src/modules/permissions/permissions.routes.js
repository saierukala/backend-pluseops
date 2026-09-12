import { Router } from 'express';
import { z } from 'zod';
import { listPermissions, getPermission } from './permissions.controller.js';
import { permissionIdParamSchema, listPermissionsQuerySchema } from './permissions.validation.js';
import { authenticate } from '../auth/auth.middleware.js';
import { authorize } from '../auth/authorization.middleware.js';

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

export const permissionsRouter = Router();

permissionsRouter.use(authenticate());

permissionsRouter.get('/', validate(listPermissionsQuerySchema), authorize('permission:read'), listPermissions);
permissionsRouter.get('/:id', validate(permissionIdParamSchema), authorize('permission:read'), getPermission);