import { Router } from 'express';
import { z } from 'zod';
import {
  listRoles,
  getRole,
  createRole,
  updateRole,
  deleteRole,
  assignPermissions,
} from './roles.controller.js';
import {
  createRoleSchema,
  updateRoleSchema,
  roleIdParamSchema,
  assignPermissionsSchema,
  listRolesQuerySchema,
} from './roles.validation.js';
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

export const rolesRouter = Router();

rolesRouter.use(authenticate());

rolesRouter.get('/', validate(listRolesQuerySchema), authorize('role:read'), listRoles);
rolesRouter.get('/:id', validate(roleIdParamSchema), authorize('role:read'), getRole);
rolesRouter.post('/', validate(createRoleSchema), authorize('role:create'), createRole);
rolesRouter.patch('/:id', validate(updateRoleSchema), authorize('role:update'), updateRole);
rolesRouter.delete('/:id', validate(roleIdParamSchema), authorize('role:delete'), deleteRole);
rolesRouter.post('/:id/permissions', validate(assignPermissionsSchema), authorize('role:update'), assignPermissions);