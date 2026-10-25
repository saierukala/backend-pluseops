import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../auth/auth.middleware.js';
import { authorize } from '../auth/authorization.middleware.js';
import { validate, ctxOf, handle, ok } from '../quotes/quotes.routes.js';
import { recurringInvoicesService, FREQUENCIES } from './recurring-invoices.service.js';

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'date as YYYY-MM-DD' });
const items = z.array(z.object({ variantId: uuid, quantity: z.number().int().positive().max(100000), discount: z.string().regex(/^\d+(\.\d{1,2})?$/).optional() })).min(1).max(100);
const idParams = z.object({ id: uuid });

const schemas = {
  create: z.object({
    body: z.object({
      customerId: uuid, name: z.string().trim().min(1).max(120), items, frequency: z.enum(FREQUENCIES),
      startOn: date.optional(), endOn: date.optional(), warehouseId: uuid.optional(), sendPaymentLink: z.boolean().optional(),
    }),
  }),
  update: z.object({
    params: idParams,
    body: z.object({
      name: z.string().trim().min(1).max(120).optional(), items: items.optional(), frequency: z.enum(FREQUENCIES).optional(),
      endOn: date.nullable().optional(), warehouseId: uuid.nullable().optional(), sendPaymentLink: z.boolean().optional(), status: z.enum(['ACTIVE', 'PAUSED', 'ENDED']).optional(),
    }).refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change' }),
  }),
  id: z.object({ params: idParams }),
  list: z.object({ query: z.object({ page: z.coerce.number().int().positive().default(1), limit: z.coerce.number().int().positive().max(100).default(20), status: z.enum(['ACTIVE', 'PAUSED', 'ENDED']).optional(), customerId: uuid.optional() }) }),
};

export const recurringInvoicesRouter = Router();
recurringInvoicesRouter.use(authenticate());
recurringInvoicesRouter.get('/', validate(schemas.list), authorize('recurring_invoice:read'), handle(async (req, res) => {
  const { data, meta } = await recurringInvoicesService.list(req.context.tenantId, req.validatedQuery);
  res.status(200).json({ success: true, data, meta, message: 'Recurring invoices retrieved' });
}));
recurringInvoicesRouter.post('/', validate(schemas.create), authorize('recurring_invoice:create'), handle(async (req, res) => ok(res, await recurringInvoicesService.create(req.context.tenantId, req.body, ctxOf(req)), 'Recurring invoice created', 201)));
recurringInvoicesRouter.get('/:id', validate(schemas.id), authorize('recurring_invoice:read'), handle(async (req, res) => ok(res, await recurringInvoicesService.get(req.context.tenantId, req.params.id), 'Recurring invoice retrieved')));
recurringInvoicesRouter.patch('/:id', validate(schemas.update), authorize('recurring_invoice:update'), handle(async (req, res) => ok(res, await recurringInvoicesService.update(req.context.tenantId, req.params.id, req.body, ctxOf(req)), 'Recurring invoice updated')));
recurringInvoicesRouter.delete('/:id', validate(schemas.id), authorize('recurring_invoice:delete'), handle(async (req, res) => {
  await recurringInvoicesService.remove(req.context.tenantId, req.params.id, ctxOf(req));
  ok(res, null, 'Recurring invoice deleted');
}));
// "Bill now": this period's invoice immediately, also handy to check a new schedule
recurringInvoicesRouter.post('/:id/run', validate(schemas.id), authorize('recurring_invoice:update'), authorize('order:create'), handle(async (req, res) => {
  ok(res, await recurringInvoicesService.runNow(req.context.tenantId, req.context.userId, req.params.id), 'Invoice raised', 201);
}));
