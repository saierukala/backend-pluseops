import { z } from 'zod';

const uuid = z.string().uuid();
const orderStatusValues = ['DRAFT', 'PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED'];
const paymentStatusValues = ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'CANCELLED'];
const groupByValues = ['day', 'week', 'month'];

const dateString = z.string().refine((v) => !Number.isNaN(Date.parse(v)), { message: 'Invalid date format' });

const paginationFields = {
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
};

const baseDateRange = {
  from: dateString.optional(),
  to: dateString.optional(),
  groupBy: z.enum(groupByValues).optional(),
};

const categoryField = uuid.optional();
const productField = uuid.optional();
const statusFieldOrders = z.enum(orderStatusValues).optional();
const statusFieldPayments = z.enum(paymentStatusValues).optional();

function dateRangeRefine(data, ctx) {
  if (data.from && data.to) {
    const f = new Date(data.from);
    const t = new Date(data.to);
    if (f > t) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'from must be <= to', path: ['from'] });
    }
  }
}

export const analyticsOverviewQuerySchema = z.object({
  query: z.object({
    ...baseDateRange,
    // tenant param is allowed but ignored for isolation
    tenantId: z.string().optional(),
    tenant: z.string().optional(),
  }).superRefine(dateRangeRefine),
});

export const analyticsSalesQuerySchema = z.object({
  query: z.object({
    ...baseDateRange,
    ...paginationFields,
    category: categoryField,
    categoryId: categoryField,
    product: productField,
    productId: productField,
    status: statusFieldOrders,
    tenantId: z.string().optional(),
    tenant: z.string().optional(),
  }).superRefine(dateRangeRefine),
});

export const analyticsOrdersQuerySchema = z.object({
  query: z.object({
    ...baseDateRange,
    ...paginationFields,
    status: statusFieldOrders,
    tenantId: z.string().optional(),
    tenant: z.string().optional(),
  }).superRefine(dateRangeRefine),
});

export const analyticsInventoryQuerySchema = z.object({
  query: z.object({
    ...paginationFields,
    category: categoryField,
    categoryId: categoryField,
    product: productField,
    productId: productField,
    warehouseId: uuid.optional(),
    warehouse: uuid.optional(),
    status: z.enum(['ACTIVE', 'INACTIVE', 'DRAFT', 'ARCHIVED']).optional(),
    tenantId: z.string().optional(),
    tenant: z.string().optional(),
  }),
});

export const analyticsCustomersQuerySchema = z.object({
  query: z.object({
    ...baseDateRange,
    ...paginationFields,
    tenantId: z.string().optional(),
    tenant: z.string().optional(),
  }).superRefine(dateRangeRefine),
});

export const analyticsRevenueQuerySchema = z.object({
  query: z.object({
    ...baseDateRange,
    ...paginationFields,
    status: statusFieldPayments.optional(),
    tenantId: z.string().optional(),
    tenant: z.string().optional(),
  }).superRefine(dateRangeRefine),
});
