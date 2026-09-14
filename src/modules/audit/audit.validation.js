import { z } from 'zod';

export const auditActionEnum = z.enum(['CREATE', 'UPDATE', 'DELETE', 'LOGIN', 'LOGOUT', 'EXPORT', 'IMPORT']);

export const listAuditLogsQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
    action: auditActionEnum.optional(),
    resource: z.string().max(100).optional(),
    resourceId: z.string().uuid().optional(),
    userId: z.string().uuid().optional(),
    from: z.string().datetime({ offset: true }).or(z.string().datetime()).optional(),
    to: z.string().datetime({ offset: true }).or(z.string().datetime()).optional(),
    sortBy: z.enum(['createdAt', 'action', 'resource']).default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
  }),
});

export const listActivityLogsQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
    action: z.string().max(100).optional(),
    userId: z.string().uuid().optional(),
    from: z.string().datetime({ offset: true }).or(z.string().datetime()).optional(),
    to: z.string().datetime({ offset: true }).or(z.string().datetime()).optional(),
    sortBy: z.enum(['createdAt', 'action']).default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
  }),
});

export const getActivityLogSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
});
