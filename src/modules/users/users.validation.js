import { z } from 'zod';

export const userIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
});

export const assignRolesSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
  body: z.object({
    roleIds: z.array(z.string().uuid()).min(1),
  }),
});

export const listUserRolesQuerySchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
  query: z.object({}),
});

export const userStatusEnum = z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']);

export const listUsersQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
    search: z.string().max(255).optional(),
    status: userStatusEnum.optional(),
    roleId: z.string().uuid().optional(),
    sortBy: z.enum(['createdAt', 'updatedAt', 'email', 'firstName', 'lastName', 'status']).default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
  }),
});

export const updateUserStatusEnum = z.string(); // Allow any string, service will validate

export const getUserSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
});

export const updateUserSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
  body: z.object({
    firstName: z.string().min(1).max(100).optional(),
    lastName: z.string().min(1).max(100).optional(),
    status: updateUserStatusEnum.optional(),
    email: z.string().email().optional(),
    passwordHash: z.string().optional(),
    tenantId: z.string().uuid().optional(),
    roleIds: z.array(z.string().uuid()).optional(),
  }).refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided for update',
  }),
}).passthrough();

export const deleteUserSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
});