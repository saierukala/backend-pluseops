import { z } from 'zod';
import { orderStatusEnum } from '../orders/orders.validation.js';
import { REPORT_DEFINITIONS } from './reports.builders.js';

export const reportTypeEnum = z.enum(['ORDERS', 'INVENTORY', 'CUSTOMERS']);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'Use YYYY-MM-DD' }).refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), { message: 'Invalid date' });

export const reportRequestBody = z.object({
  type: z.string().trim().toUpperCase().pipe(reportTypeEnum),
  filters: z.object({
    from: day.optional(),
    to: day.optional(),
    status: orderStatusEnum.optional(),
    warehouseId: z.string().uuid().optional(),
  }).strict().default({}),
}).superRefine((data, ctx) => {
  const allowed = REPORT_DEFINITIONS[data.type].filters;
  for (const key of Object.keys(data.filters)) {
    if (!allowed.includes(key)) ctx.addIssue({ code: 'custom', path: ['filters', key], message: `${data.type} reports accept filters: ${allowed.join(', ')}` });
  }
  if (data.filters.from && data.filters.to && data.filters.from > data.filters.to) {
    ctx.addIssue({ code: 'custom', path: ['filters', 'to'], message: 'to must not be before from' });
  }
});

export const createReportSchema = z.object({ body: reportRequestBody });

export const listReportsSchema = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
    type: reportTypeEnum.optional(),
    status: z.enum(['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED']).optional(),
  }),
});

export const reportIdSchema = z.object({ params: z.object({ id: z.string().uuid() }) });

// Phase 36: schedules. from/to come from the period (yesterday / last week / last month, UTC); other filters stay fixed.
const scheduleFilters = z.object({ status: orderStatusEnum.optional(), warehouseId: z.string().uuid().optional() }).strict();
const scheduleBody = z.object({
  name: z.string().trim().min(1).max(120),
  type: z.string().trim().toUpperCase().pipe(reportTypeEnum),
  frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY']),
  filters: scheduleFilters.default({}),
  recipientUserIds: z.array(z.string().uuid()).min(1).max(20).optional(),
  enabled: z.boolean().optional(),
});
const checkFilters = (data, ctx) => {
  if (!data.type || !data.filters) return;
  const allowed = REPORT_DEFINITIONS[data.type].filters;
  for (const key of Object.keys(data.filters)) {
    if (!allowed.includes(key)) ctx.addIssue({ code: 'custom', path: ['filters', key], message: `${data.type} reports accept filters: ${allowed.filter((f) => f !== 'from' && f !== 'to').join(', ') || 'none'}` });
  }
};

export const createReportScheduleSchema = z.object({ body: scheduleBody.superRefine(checkFilters) });
export const updateReportScheduleSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: scheduleBody.omit({ type: true }).partial().refine((d) => Object.keys(d).length > 0, { message: 'At least one field must be provided' }),
});
export const listReportSchedulesSchema = z.object({
  query: z.object({ page: z.coerce.number().int().positive().default(1), limit: z.coerce.number().int().positive().max(100).default(20) }),
});
