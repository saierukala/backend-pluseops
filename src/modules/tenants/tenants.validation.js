import { z } from 'zod';

export const tenantStatusEnum = z.enum(['ACTIVE', 'SUSPENDED', 'TRIAL', 'CANCELLED']);

export const createTenantSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(255),
    slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/),
    status: tenantStatusEnum.optional(),
    plan: z.string().max(50).optional(),
  }),
});

export const updateTenantSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
  body: z.object({
    name: z.string().min(1).max(255).optional(),
    slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/).optional(),
    status: tenantStatusEnum.optional(),
    plan: z.string().max(50).optional(),
  }).refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided for update',
  }),
});

export const getTenantSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
});

export const deleteTenantSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
});