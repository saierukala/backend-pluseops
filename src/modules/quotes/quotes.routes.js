import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../auth/auth.middleware.js';
import { authorize } from '../auth/authorization.middleware.js';
import { quotesService } from './quotes.service.js';

const uuid = z.string().uuid();
const money = z.string().regex(/^\d+(\.\d{1,2})?$/, { message: 'amount like 120 or 120.50' });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'date as YYYY-MM-DD' });
const items = z.array(z.object({ variantId: uuid, quantity: z.number().int().positive().max(100000), discount: money.optional() })).min(1).max(200);
const idParams = z.object({ id: uuid });

export const schemas = {
  create: z.object({ body: z.object({ customerId: uuid, items, validUntil: date.optional(), notes: z.string().trim().max(2000).optional() }) }),
  update: z.object({
    params: idParams,
    body: z.object({ items: items.optional(), validUntil: date.nullable().optional(), notes: z.string().trim().max(2000).nullable().optional() }).refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change' }),
  }),
  status: z.object({ params: idParams, body: z.object({ status: z.enum(['SENT', 'ACCEPTED', 'DECLINED']) }) }),
  convert: z.object({ params: idParams, body: z.object({ warehouseId: uuid.optional(), shippingAddressId: uuid.optional(), billingAddressId: uuid.optional() }) }),
  id: z.object({ params: idParams }),
  list: z.object({
    query: z.object({
      page: z.coerce.number().int().positive().default(1), limit: z.coerce.number().int().positive().max(100).default(20),
      status: z.enum(['DRAFT', 'SENT', 'ACCEPTED', 'DECLINED', 'CONVERTED']).optional(), customerId: uuid.optional(), search: z.string().trim().max(100).optional(),
    }),
  }),
};

export function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse({ body: req.body, params: req.params, query: req.query });
    if (!result.success) return next(new z.ZodError(result.error.issues));
    if (result.data.body !== undefined) req.body = result.data.body;
    if (result.data.params !== undefined) req.params = result.data.params;
    if (result.data.query !== undefined) req.validatedQuery = result.data.query;
    next();
  };
}

export const ctxOf = (req) => ({
  userId: req.context.userId,
  ipAddress: req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || null,
  userAgent: req.headers['user-agent'] || null,
});
export const handle = (fn) => (req, res, next) => fn(req, res).catch(next);
export const ok = (res, data, message, status = 200) => res.status(status).json({ success: true, data, message });

export const quotesRouter = Router();
quotesRouter.use(authenticate());

quotesRouter.get('/', validate(schemas.list), authorize('quote:read'), handle(async (req, res) => {
  const { data, meta } = await quotesService.list(req.context.tenantId, req.validatedQuery);
  res.status(200).json({ success: true, data, meta, message: 'Quotes retrieved' });
}));
quotesRouter.post('/', validate(schemas.create), authorize('quote:create'), handle(async (req, res) => ok(res, await quotesService.create(req.context.tenantId, req.body, ctxOf(req)), 'Quote created', 201)));
quotesRouter.get('/:id', validate(schemas.id), authorize('quote:read'), handle(async (req, res) => ok(res, await quotesService.get(req.context.tenantId, req.params.id), 'Quote retrieved')));
quotesRouter.patch('/:id', validate(schemas.update), authorize('quote:update'), handle(async (req, res) => ok(res, await quotesService.update(req.context.tenantId, req.params.id, req.body, ctxOf(req)), 'Quote updated')));
quotesRouter.post('/:id/status', validate(schemas.status), authorize('quote:update'), handle(async (req, res) => ok(res, await quotesService.setStatus(req.context.tenantId, req.params.id, req.body.status, ctxOf(req)), 'Quote updated')));
quotesRouter.post('/:id/convert', validate(schemas.convert), authorize('quote:update'), authorize('order:create'), handle(async (req, res) => {
  ok(res, await quotesService.convert(req.context.tenantId, req.context.userId, req.params.id, req.body, ctxOf(req)), 'Quote converted to an order', 201);
}));
quotesRouter.delete('/:id', validate(schemas.id), authorize('quote:delete'), handle(async (req, res) => {
  await quotesService.remove(req.context.tenantId, req.params.id, ctxOf(req));
  ok(res, null, 'Quote deleted');
}));
