import { z } from 'zod';

export const adjustInventorySchema = z.object({
  body: z.object({
    variantId: z.string().uuid(),
    productVariantId: z.string().uuid().optional(),
    warehouseId: z.string().uuid(),
    quantityChanged: z.number().int().refine((v) => v !== 0, { message: 'quantityChanged must be non-zero' }),
    quantity: z.number().int().optional(),
    reason: z.string().min(1).max(500).optional(),
    referenceType: z.string().max(100).optional(),
    referenceId: z.string().max(255).optional(),
  }).refine((data) => data.variantId || data.productVariantId, { message: 'variantId is required' }),
});

export const transferInventorySchema = z.object({
  body: z.object({
    variantId: z.string().uuid().optional(),
    productVariantId: z.string().uuid().optional(),
    sourceWarehouseId: z.string().uuid(),
    destinationWarehouseId: z.string().uuid(),
    warehouseId: z.string().uuid().optional(),
    destWarehouseId: z.string().uuid().optional(),
    quantity: z.number().int().positive(),
    reason: z.string().min(1).max(500).optional(),
    referenceType: z.string().max(100).optional(),
    referenceId: z.string().max(255).optional(),
  }).refine((data) => data.variantId || data.productVariantId, { message: 'variantId is required' }),
});

export const listInventoryQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
    warehouseId: z.string().uuid().optional(),
    variantId: z.string().uuid().optional(),
    warehouse_id: z.string().uuid().optional(),
    productVariantId: z.string().uuid().optional(),
    sku: z.string().max(100).optional(),
    search: z.string().max(255).optional(),
  }),
});

export const variantInventoryParamsSchema = z.object({
  params: z.object({ variantId: z.string().uuid() }),
});

export const movementsQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
    variantId: z.string().uuid().optional(),
    productVariantId: z.string().uuid().optional(),
    warehouseId: z.string().uuid().optional(),
    type: z.enum(['ADJUSTMENT', 'TRANSFER', 'ORDER_RESERVATION', 'ORDER_RELEASE', 'ORDER_FULFILLMENT', 'RETURN', 'DAMAGED', 'LOST', 'COUNT']).optional(),
    reason: z.string().optional(),
  }),
});

export const lowStockQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
    threshold: z.coerce.number().int().min(0).default(10),
    warehouseId: z.string().uuid().optional(),
  }),
});
