import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../auth/auth.middleware.js';
import { authorize } from '../auth/authorization.middleware.js';
import { idempotent } from '../../common/middleware/idempotency.js';
import { validate, ctxOf, handle, ok } from '../quotes/quotes.routes.js';
import { receivablesService, RECEIPT_METHODS } from './receivables.service.js';

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'date as YYYY-MM-DD' });
const schemas = {
  customer: z.object({ params: z.object({ id: uuid }) }),
  statement: z.object({ params: z.object({ id: uuid }), query: z.object({ from: date.optional(), to: date.optional() }) }),
  receive: z.object({
    params: z.object({ id: uuid }),
    body: z.object({
      amount: z.string().regex(/^\d+(\.\d{1,2})?$/).refine((v) => Number(v) > 0, { message: 'must be more than 0' }),
      method: z.enum(RECEIPT_METHODS),
      reference: z.string().trim().max(100).optional(),
      registerId: uuid.optional(),
      note: z.string().trim().max(500).optional(),
    }),
  }),
  link: z.object({ params: z.object({ id: uuid }), body: z.object({ notify: z.boolean().default(true) }) }),
};

// Mounted on /customers: what one customer owes
export const customerAccountRouter = Router();
customerAccountRouter.get('/:id/balance', authenticate(), validate(schemas.customer), authorize('customer:read'), handle(async (req, res) => ok(res, await receivablesService.balance(req.context.tenantId, req.params.id), 'Balance retrieved')));
customerAccountRouter.get('/:id/statement', authenticate(), validate(schemas.statement), authorize('customer:read'), handle(async (req, res) => ok(res, await receivablesService.statement(req.context.tenantId, req.params.id, req.validatedQuery), 'Statement retrieved')));
customerAccountRouter.post('/:id/payments', authenticate(), validate(schemas.receive), authorize('payment:create'), idempotent(), handle(async (req, res) => {
  ok(res, await receivablesService.receivePayment(req.context.tenantId, req.context.userId, req.params.id, req.body, ctxOf(req)), 'Payment received', 201);
}));

// /receivables: everyone who owes, with ageing
export const receivablesRouter = Router();
receivablesRouter.use(authenticate());
receivablesRouter.get('/', authorize('customer:read'), authorize('payment:read'), handle(async (req, res) => ok(res, await receivablesService.receivables(req.context.tenantId), 'Receivables retrieved')));

// Mounted on /orders: send a Razorpay payment link for what's due on an invoice
export const orderPaymentLinkRouter = Router();
orderPaymentLinkRouter.post('/:id/payment-link', authenticate(), validate(schemas.link), authorize('payment:create'), handle(async (req, res) => {
  ok(res, await receivablesService.paymentLink(req.context.tenantId, req.context.userId, req.params.id, req.body), 'Payment link ready', 201);
}));
