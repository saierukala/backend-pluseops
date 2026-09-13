import { z } from 'zod';

export const createWarehouseSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(255),
    code: z.string().min(1).max(50),
    address: z.string().max(500).optional(),
    city: z.string().max(100).optional(),
    state: z.string().max(100).optional(),
    country: z.string().max(100).optional(),
    postalCode: z.string().max(20).optional(),
    isActive: z.boolean().optional(),
    isDefault: z.boolean().optional(),
  }),
});

export const updateWarehouseSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    name: z.string().min(1).max(255).optional(),
    address: z.string().max(500).optional(),
    city: z.string().max(100).optional(),
    state: z.string().max(100).optional(),
    country: z.string().max(100).optional(),
    postalCode: z.string().max(20).optional(),
    isActive: z.boolean().optional(),
    isDefault: z.boolean().optional(),
  }).refine((data) => Object.keys(data).length > 0, { message: 'At least one field must be provided' }),
});

export const getWarehouseSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
});

export const deleteWarehouseSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
});

export const listWarehousesQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
    search: z.string().max(255).optional(),
    isActive: z.enum(['true', 'false']).optional(),
  }),
});
