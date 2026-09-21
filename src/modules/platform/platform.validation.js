import { z } from 'zod';

export const tenantStatusEnum = z.enum(['ACTIVE', 'SUSPENDED', 'TRIAL', 'CANCELLED']);

export const createTenantWithAdminSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(255),
    slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/),
    status: tenantStatusEnum.optional(),
    plan: z.string().max(50).optional(),
    admin: z.object({
      email: z.string().email(),
      password: z.string().min(8).max(128).regex(/[A-Z]/).regex(/[a-z]/).regex(/[0-9]/).regex(/[^A-Za-z0-9]/),
      firstName: z.string().min(1).max(100),
      lastName: z.string().min(1).max(100),
    }),
  }),
});

export const createTenantOnlySchema = z.object({
  body: z.object({
    name: z.string().min(1).max(255),
    slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/),
    status: tenantStatusEnum.optional(),
    plan: z.string().max(50).optional(),
  }),
});

export const listTenantsQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    status: tenantStatusEnum.optional(),
    search: z.string().max(100).optional(),
  }),
});

export const getTenantParamsSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
});

export const updateTenantStatusSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
  body: z.object({
    status: tenantStatusEnum,
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

export const createTenantAdminSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
  body: z.object({
    email: z.string().email(),
    password: z.string().min(8).max(128).regex(/[A-Z]/).regex(/[a-z]/).regex(/[0-9]/).regex(/[^A-Za-z0-9]/),
    firstName: z.string().min(1).max(100),
    lastName: z.string().min(1).max(100),
  }),
});
