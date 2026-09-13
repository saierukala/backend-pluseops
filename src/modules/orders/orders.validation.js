import { z } from 'zod';

export const orderStatusEnum = z.enum(['DRAFT', 'PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED']);

const decimalString = z.string().regex(/^\d+(\.\d{1,2})?$/, { message: 'Invalid decimal format' });

export const createOrderSchema = z.object({
  body: z.object({
    customerId: z.string().uuid(),
    items: z.array(z.object({
      productVariantId: z.string().uuid(),
      variantId: z.string().uuid().optional(),
      warehouseId: z.string().uuid(),
      quantity: z.number().int().positive(),
      discount: decimalString.optional(),
      tax: decimalString.optional(),
    })).min(1, { message: 'At least one item is required' }),
    shippingTotal: decimalString.optional(),
    currency: z.string().min(3).max(3).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    productId: z.string().uuid().optional(),
  }).superRefine((data, ctx) => {
    if (data.productId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'productId is not allowed, use productVariantId', path: ['productId'] });
    }
  }),
});

export const listOrdersQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
    status: orderStatusEnum.optional(),
    customerId: z.string().uuid().optional(),
    sortBy: z.enum(['createdAt', 'updatedAt', 'total', 'status']).default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
  }),
});

export const getOrderSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
});

export const updateOrderStatusSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    status: orderStatusEnum,
    reason: z.string().max(500).optional(),
  }),
});

export const cancelOrderSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    reason: z.string().max(500).optional(),
  }).optional(),
});

export const getOrderHistorySchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
  }),
});
