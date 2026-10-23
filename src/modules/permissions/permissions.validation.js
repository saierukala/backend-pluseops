import { z } from 'zod';

export const permissionIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
});

// Default page size covers the whole catalog, so callers that ignore `meta` still get every permission
export const listPermissionsQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(200).default(100),
    resource: z.string().regex(/^[a-z_]+$/).max(50).optional(),
  }),
});
