import { z } from 'zod';

export const variantStatusEnum = z.enum(['ACTIVE', 'INACTIVE', 'DRAFT']);

export const createVariantSchema = z.object({
  params: z.object({
    productId: z.string().uuid(),
  }),
  body: z.object({
    sku: z.string().min(1).max(100),
    barcode: z.string().max(100).optional(),
    price: z.string().regex(/^\d+(\.\d{1,2})?$/),
    costPrice: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
    status: variantStatusEnum.default('DRAFT'),
    attributes: z.array(z.object({
      attributeDefinitionId: z.string().uuid(),
      value: z.string(),
    })).optional(),
  }),
});

export const updateVariantSchema = z.object({
  params: z.object({
    productId: z.string().uuid(),
    variantId: z.string().uuid(),
  }),
  body: z.object({
    sku: z.string().min(1).max(100).optional(),
    barcode: z.string().max(100).optional(),
    price: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
    costPrice: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
    status: variantStatusEnum.optional(),
    attributes: z.array(z.object({
      attributeDefinitionId: z.string().uuid(),
      value: z.string(),
    })).optional(),
  }).refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided for update',
  }),
});

export const getVariantSchema = z.object({
  params: z.object({
    productId: z.string().uuid(),
    variantId: z.string().uuid(),
  }),
});

export const deleteVariantSchema = z.object({
  params: z.object({
    productId: z.string().uuid(),
    variantId: z.string().uuid(),
  }),
});

export const listVariantsQuerySchema = z.object({
  params: z.object({
    productId: z.string().uuid(),
  }),
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
    status: variantStatusEnum.optional(),
    sortBy: z.enum(['sku', 'price', 'status', 'createdAt', 'updatedAt']).default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).default('asc'),
  }),
});

export const setVariantAttributesSchema = z.object({
  params: z.object({
    productId: z.string().uuid(),
    variantId: z.string().uuid(),
  }),
  body: z.object({
    attributes: z.array(z.object({
      attributeDefinitionId: z.string().uuid(),
      value: z.string(),
    })),
  }),
});

export const getVariantAttributesSchema = z.object({
  params: z.object({
    productId: z.string().uuid(),
    variantId: z.string().uuid(),
  }),
});