import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../auth/auth.middleware.js';
import { authorize } from '../auth/authorization.middleware.js';
import { idempotent } from '../../common/middleware/idempotency.js';
import { validate, ctxOf, handle, ok } from '../quotes/quotes.routes.js';
import { creditNotesService, REFUND_METHODS } from './credit-notes.service.js';

const uuid = z.string().uuid();
const schemas = {
  create: z.object({
    params: z.object({ id: uuid }),
    body: z.object({
      items: z.array(z.object({ orderItemId: uuid, quantity: z.number().int().positive(), restock: z.boolean().optional() })).min(1).max(200),
      reason: z.string().trim().max(500).optional(),
      refundMethod: z.enum(REFUND_METHODS).default('CREDIT'),
      registerId: uuid.optional(),
    }),
  }),
  order: z.object({ params: z.object({ id: uuid }) }),
  id: z.object({ params: z.object({ id: uuid }) }),
  list: z.object({ query: z.object({ page: z.coerce.number().int().positive().default(1), limit: z.coerce.number().int().positive().max(100).default(20), customerId: uuid.optional() }) }),
};

// Mounted on /orders (next to the orders router)
export const orderReturnsRouter = Router();
orderReturnsRouter.post('/:id/returns', authenticate(), validate(schemas.create), authorize('order:return'), idempotent(), handle(async (req, res) => {
  ok(res, await creditNotesService.create(req.context.tenantId, req.context.userId, req.params.id, req.body, ctxOf(req)), 'Return recorded', 201);
}));
orderReturnsRouter.get('/:id/credit-notes', authenticate(), validate(schemas.order), authorize('order:read'), handle(async (req, res) => ok(res, await creditNotesService.listForOrder(req.context.tenantId, req.params.id), 'Credit notes retrieved')));

export const creditNotesRouter = Router();
creditNotesRouter.use(authenticate());
creditNotesRouter.get('/', validate(schemas.list), authorize('order:read'), handle(async (req, res) => {
  const { data, meta } = await creditNotesService.list(req.context.tenantId, req.validatedQuery);
  res.status(200).json({ success: true, data, meta, message: 'Credit notes retrieved' });
}));
creditNotesRouter.get('/:id', validate(schemas.id), authorize('order:read'), handle(async (req, res) => ok(res, await creditNotesService.get(req.context.tenantId, req.params.id), 'Credit note retrieved')));
