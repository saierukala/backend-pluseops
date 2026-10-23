import { z } from 'zod';

export const createRoleSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100).regex(/^[a-z0-9_-]+$/),
    description: z.string().max(500).optional(),
  }),
});

export const updateRoleSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
  body: z.object({
    name: z.string().min(1).max(100).regex(/^[a-z0-9_-]+$/).optional(),
    description: z.string().max(500).optional(),
  }).refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field is required',
  }),
});

export const roleIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
});

export const assignPermissionsSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
  body: z.object({
    permissionIds: z.array(z.string().uuid()).min(1),
  }),
});

// Replace the full set; an empty array clears every permission from the role
export const replacePermissionsSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
  body: z.object({
    permissionIds: z.array(z.string().uuid()).max(500),
  }),
});

export const removePermissionSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
    permissionId: z.string().uuid(),
  }),
});

export const listRolesQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(50),
  }),
});