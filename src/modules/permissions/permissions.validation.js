import { z } from 'zod';

export const permissionIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
});

export const listPermissionsQuerySchema = z.object({
  query: z.object({}),
});