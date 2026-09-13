import { z } from 'zod';

export const categoryStatusEnum = z.enum(['ACTIVE', 'INACTIVE']);

export const createCategorySchema = z.object({
  body: z.object({
    name: z.string().min(1).max(255),
    slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/),
    description: z.string().max(1000).optional(),
    parentId: z.string().uuid().optional(),
    sortOrder: z.coerce.number().int().default(0),
    isActive: z.boolean().default(true),
  }),
});

export const updateCategorySchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
  body: z.object({
    name: z.string().min(1).max(255).optional(),
    slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/).optional(),
    description: z.string().max(1000).optional(),
    parentId: z.string().uuid().nullable().optional(),
    sortOrder: z.coerce.number().int().optional(),
    isActive: z.boolean().optional(),
  }).refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided for update',
  }),
});

export const getCategorySchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
});

export const deleteCategorySchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
});

export const listCategoriesQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
    search: z.string().max(255).optional(),
    isActive: z.boolean().optional(),
    parentId: z.string().uuid().optional(),
    sortBy: z.enum(['name', 'slug', 'sortOrder', 'createdAt', 'updatedAt', 'isActive']).default('sortOrder'),
    sortOrder: z.enum(['asc', 'desc']).default('asc'),
  }),
});

export const getCategoryTreeSchema = z.object({
  query: z.object({}),
});