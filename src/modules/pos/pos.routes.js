import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../auth/auth.middleware.js';
import { authorize } from '../auth/authorization.middleware.js';
import { idempotent } from '../../common/middleware/idempotency.js';
import { posService } from './pos.service.js';
import { cashRegisterService } from './cash-register.service.js';
import * as v from './pos.validation.js';

function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse({ body: req.body, params: req.params, query: req.query });
    if (!result.success) return next(new z.ZodError(result.error.issues));
    if (result.data.body !== undefined) req.body = result.data.body;
    if (result.data.params !== undefined) req.params = result.data.params;
    if (result.data.query !== undefined) req.validatedQuery = result.data.query;
    next();
  };
}

const ctxOf = (req) => ({
  userId: req.context.userId,
  ipAddress: req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || null,
  userAgent: req.headers['user-agent'] || null,
});
const ok = (res, data, message, status = 200) => res.status(status).json({ success: true, data, message });
const handle = (fn) => (req, res, next) => fn(req, res).catch(next);

// ── /pos: selling at the counter (pos:sell) ───────────────────────────
export const posRouter = Router();
posRouter.use(authenticate());

posRouter.get('/context', authorize('pos:sell'), handle(async (req, res) => ok(res, await posService.context(req.context.tenantId), 'Counter ready')));
posRouter.get('/lookup', validate(v.lookupSchema), authorize('pos:sell'), handle(async (req, res) => ok(res, await posService.lookup(req.context.tenantId, req.validatedQuery), 'Items found')));
posRouter.post('/sales', validate(v.saleSchema), authorize('pos:sell'), idempotent(), handle(async (req, res) => {
  ok(res, await posService.sale(req.context.tenantId, req.context.userId, req.body, ctxOf(req)), 'Sale completed', 201);
}));
posRouter.get('/held-sales', authorize('pos:sell'), handle(async (req, res) => ok(res, await posService.listHeld(req.context.tenantId), 'Held sales retrieved')));
posRouter.post('/held-sales', validate(v.holdSchema), authorize('pos:sell'), handle(async (req, res) => ok(res, await posService.hold(req.context.tenantId, req.context.userId, req.body), 'Sale held', 201)));
posRouter.delete('/held-sales/:id', validate(v.heldParams), authorize('pos:sell'), handle(async (req, res) => {
  await posService.removeHeld(req.context.tenantId, req.params.id);
  ok(res, null, 'Held sale removed');
}));
posRouter.post('/upi-qr', validate(v.upiQrSchema), authorize('pos:sell'), handle(async (req, res) => ok(res, await posService.upiQr(req.context.tenantId, req.body), 'UPI QR ready', 201)));
posRouter.get('/upi-qr/:qrId', validate(v.upiQrParams), authorize('pos:sell'), handle(async (req, res) => ok(res, await posService.upiQrStatus(req.context.tenantId, req.params.qrId), 'UPI QR status')));

// ── /cash-registers: counters and their shifts ────────────────────────
export const cashRegistersRouter = Router();
cashRegistersRouter.use(authenticate());

cashRegistersRouter.get('/', authorize('cash_register:read'), handle(async (req, res) => ok(res, await cashRegisterService.list(req.context.tenantId), 'Registers retrieved')));
cashRegistersRouter.post('/', validate(v.createRegisterSchema), authorize('cash_register:manage'), handle(async (req, res) => ok(res, await cashRegisterService.create(req.context.tenantId, req.body, ctxOf(req)), 'Register created', 201)));
cashRegistersRouter.get('/sessions', validate(v.listSessionsSchema), authorize('cash_register:read'), handle(async (req, res) => {
  const { data, meta } = await cashRegisterService.listSessions(req.context.tenantId, req.validatedQuery);
  res.status(200).json({ success: true, data, meta, message: 'Shifts retrieved' });
}));
cashRegistersRouter.get('/sessions/:sessionId', validate(v.sessionParams), authorize('cash_register:read'), handle(async (req, res) => ok(res, await cashRegisterService.getSession(req.context.tenantId, req.params.sessionId), 'Shift retrieved')));
cashRegistersRouter.post('/sessions/:sessionId/movements', validate(v.cashMovementSchema), authorize('cash_register:manage'), handle(async (req, res) => {
  ok(res, await cashRegisterService.addMovement(req.context.tenantId, req.params.sessionId, req.body, ctxOf(req)), 'Cash recorded', 201);
}));
cashRegistersRouter.post('/sessions/:sessionId/close', validate(v.closeSessionSchema), authorize('cash_register:manage'), handle(async (req, res) => {
  ok(res, await cashRegisterService.close(req.context.tenantId, req.params.sessionId, req.body, ctxOf(req)), 'Shift closed');
}));
cashRegistersRouter.get('/:registerId/current', validate(v.registerParams), authorize('cash_register:read'), handle(async (req, res) => ok(res, await cashRegisterService.current(req.context.tenantId, req.params.registerId), 'Current shift')));
cashRegistersRouter.post('/:registerId/open', validate(v.openRegisterSchema), authorize('cash_register:manage'), handle(async (req, res) => {
  ok(res, await cashRegisterService.open(req.context.tenantId, req.params.registerId, req.body, ctxOf(req)), 'Register opened', 201);
}));
