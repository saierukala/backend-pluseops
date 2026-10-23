import { z } from 'zod';

const uuid = z.string().uuid();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'Use YYYY-MM-DD' });
const password = z.string().min(12).max(128).regex(/[A-Z]/).regex(/[a-z]/).regex(/[0-9]/).regex(/[^A-Za-z0-9]/);
const limit = z.number().int().min(0).max(10_000_000).nullable();
const limits = z.object({ users: limit, products: limit, warehouses: limit, ordersPerMonth: limit }).partial().strict();

export const addAdminSchema = z.object({
  body: z.object({
    email: z.string().trim().toLowerCase().email().max(255),
    password,
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    roleId: uuid.optional(),
  }),
});
export const adminParamsSchema = z.object({ params: z.object({ userId: uuid }) });

export const createPlanSchema = z.object({
  body: z.object({
    code: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_-]{0,48}$/, { message: 'code is a short key like pro or enterprise' }),
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(500).nullable().optional(),
    limits: limits.optional(),
    isActive: z.boolean().optional(),
  }),
});
export const updatePlanSchema = z.object({
  params: z.object({ code: z.string().trim().toLowerCase().max(50) }),
  body: z.object({ name: z.string().trim().min(1).max(100).optional(), description: z.string().trim().max(500).nullable().optional(), limits: limits.optional(), isActive: z.boolean().optional() })
    .refine((d) => Object.keys(d).length > 0, { message: 'At least one field must be provided' }),
});
export const listPlansSchema = z.object({ query: z.object({ includeInactive: z.enum(['true', 'false']).transform((v) => v === 'true').optional() }) });
export const assignPlanSchema = z.object({ params: z.object({ id: uuid }), body: z.object({ plan: z.string().trim().toLowerCase().min(1).max(50) }) });
export const tenantParamsSchema = z.object({ params: z.object({ id: uuid }) });

export const listAuditSchema = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(50),
    action: z.string().trim().max(100).optional(),
    tenantId: uuid.optional(),
    actorUserId: uuid.optional(),
    from: day.optional(),
    to: day.optional(),
  }),
});
