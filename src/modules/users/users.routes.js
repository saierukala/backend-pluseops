import { Router } from 'express';
import { z } from 'zod';
import {
  listUsers,
  getUser,
  updateUser,
  deleteUser,
  getUserRoles,
  assignRoles,
} from './users.controller.js';
import {
  listUsersQuerySchema,
  getUserSchema,
  updateUserSchema,
  deleteUserSchema,
  assignRolesSchema,
  listUserRolesQuerySchema,
} from './users.validation.js';
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

export const usersRouter = Router();

usersRouter.use(authenticate());

// User CRUD endpoints
usersRouter.get('/', validate(listUsersQuerySchema), authorize('user:read'), listUsers);
usersRouter.get('/:id', validate(getUserSchema), authorize('user:read'), getUser);
usersRouter.patch('/:id', validate(updateUserSchema), authorize('user:update'), updateUser);
usersRouter.delete('/:id', validate(deleteUserSchema), authorize('user:delete'), deleteUser);

// User role management endpoints
usersRouter.get('/:id/roles', validate(listUserRolesQuerySchema), authorize('user:read'), getUserRoles);
usersRouter.post('/:id/roles', validate(assignRolesSchema), authorize('user:update'), assignRoles);