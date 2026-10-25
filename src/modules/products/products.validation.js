import { z } from 'zod';
import { TAXABILITY } from '../gst/india.js';

// Phase 38: GST classification. gstRatePercent null = the workspace default rate.
const gstFields = {
  hsnCode: z.string().trim().regex(/^[0-9]{4,8}$/, { message: 'hsnCode must be a 4–8 digit HSN/SAC code' }).nullable().optional(),
  gstRatePercent: z.number().min(0).max(100).refine((n) => Number.isInteger(n * 100), { message: 'gstRatePercent allows at most two decimals' }).nullable().optional(),
  gstTaxability: z.enum(TAXABILITY).optional(),
  unit: z.string().trim().min(1).max(10).nullable().optional(),
};

export const productStatusEnum = z.enum(['ACTIVE', 'INACTIVE', 'DRAFT', 'ARCHIVED']);

export const createProductSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(255),
    description: z.string().max(5000).optional(),
    brand: z.string().max(100).optional(),
    status: productStatusEnum.default('DRAFT'),
    basePrice: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
    categories: z.array(z.string().uuid()).optional(),
    primaryCategoryId: z.string().uuid().optional(),
    ...gstFields,
  }),
});

export const updateProductSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
  body: z.object({
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(5000).optional(),
    brand: z.string().max(100).optional(),
    status: productStatusEnum.optional(),
    basePrice: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
    categories: z.array(z.string().uuid()).optional(),
    primaryCategoryId: z.string().uuid().optional(),
    ...gstFields,
  }).refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided for update',
  }),
});

export const getProductSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
});

export const deleteProductSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
});

export const listProductsQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
    search: z.string().max(255).optional(),
    status: productStatusEnum.optional(),
    categoryId: z.string().uuid().optional(),
    minPrice: z.coerce.number().positive().optional(),
    maxPrice: z.coerce.number().positive().optional(),
    sku: z.string().max(100).optional(),
    barcode: z.string().max(100).optional(),
    attributeFilters: z.record(z.string()).optional(),
    sortBy: z.enum(['name', 'brand', 'status', 'basePrice', 'createdAt', 'updatedAt']).default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
  }),
});

export const setCategoriesSchema = z.object({
  params: z.object({
    productId: z.string().uuid(),
  }),
  body: z.object({
    categories: z.array(z.string().uuid()).min(1),
    primaryCategoryId: z.string().uuid().optional(),
  }),
});

export const getProductCategoriesSchema = z.object({
  params: z.object({
    productId: z.string().uuid(),
  }),
});