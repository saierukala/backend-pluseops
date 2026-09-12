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