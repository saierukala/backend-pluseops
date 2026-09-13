import { z } from 'zod';

export const createProductImageSchema = z.object({
  params: z.object({
    productId: z.string().uuid(),
  }),
  body: z.object({
    altText: z.string().max(255).optional(),
    sortOrder: z.coerce.number().int().default(0),
    isPrimary: z.coerce.boolean().default(false),
  }),
});

export const createVariantImageSchema = z.object({
  params: z.object({
    productId: z.string().uuid(),
    variantId: z.string().uuid(),
  }),
  body: z.object({
    altText: z.string().max(255).optional(),
    sortOrder: z.coerce.number().int().default(0),
    isPrimary: z.coerce.boolean().default(false),
  }),
});

export const updateImageSchema = z.object({
  params: z.object({
    productId: z.string().uuid(),
    imageId: z.string().uuid(),
  }),
  body: z.object({
    altText: z.string().max(255).optional(),
    sortOrder: z.coerce.number().int().optional(),
    isPrimary: z.coerce.boolean().optional(),
  }).refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided for update',
  }),
});

export const getImageSchema = z.object({
  params: z.object({
    productId: z.string().uuid(),
    imageId: z.string().uuid(),
  }),
});

export const deleteImageSchema = z.object({
  params: z.object({
    productId: z.string().uuid(),
    imageId: z.string().uuid(),
  }),
});

export const listProductImagesQuerySchema = z.object({
  params: z.object({
    productId: z.string().uuid(),
  }),
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
  }),
});

export const listVariantImagesQuerySchema = z.object({
  params: z.object({
    productId: z.string().uuid(),
    variantId: z.string().uuid(),
  }),
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
  }),
});