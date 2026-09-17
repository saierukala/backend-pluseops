import { Router } from 'express';
import { z } from 'zod';
import { createPayment, confirmPayment, webhookHandler, getPayment, refundPayment } from './payments.controller.js';
import { createPaymentSchema, confirmPaymentSchema, getPaymentSchema, refundPaymentSchema, webhookSchema } from './payments.validation.js';
import { authenticate } from '../auth/auth.middleware.js';
import { authorize } from '../auth/authorization.middleware.js';
import { createWebhookLimiter } from '../../common/middleware/rate-limiters.js';
import { env } from '../../config/env.js';

const webhookLimiter = env.NODE_ENV !== 'test' ? createWebhookLimiter() : (req, res, next) => next();

function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse({ body: req.body, params: req.params, query: req.query, headers: req.headers });
    if (!result.success) return next(new z.ZodError(result.error.issues));
    req.body = result.data.body;
    req.params = result.data.params;
    if (result.data.query) Object.assign(req.query, result.data.query);
    // headers are not mutated
    next();
  };
}

function validateWebhook(schema) {
  return (req, res, next) => {
    // For webhook, we validate only body, header signature is handled in service
    const result = schema.safeParse({ body: req.body, headers: req.headers, params: req.params, query: req.query });
    if (!result.success) return next(new z.ZodError(result.error.issues));
    req.body = result.data.body;
    next();
  };
}

export const paymentsRouter = Router();

// Webhook is public but signature validated in service - no authenticate; rate-limited to mitigate abuse
paymentsRouter.post('/webhook', webhookLimiter, validateWebhook(webhookSchema), webhookHandler);

// All other routes require authentication
paymentsRouter.post('/create', authenticate(), validate(createPaymentSchema), authorize('payment:create'), createPayment);
paymentsRouter.post('/confirm', authenticate(), validate(confirmPaymentSchema), authorize('payment:confirm'), confirmPayment);
paymentsRouter.get('/:id', authenticate(), validate(getPaymentSchema), authorize('payment:read'), getPayment);
paymentsRouter.post('/:id/refund', authenticate(), validate(refundPaymentSchema), authorize('payment:refund'), refundPayment);
