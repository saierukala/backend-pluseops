import { Router } from 'express';
import { z } from 'zod';
import {
  getWorkspace, updateWorkspace, getSettings, updateSettings, listDomains, createDomain, updateDomain, verifyDomain, deleteDomain,
  getPaymentGateway, savePaymentGateway, updatePaymentGateway, deletePaymentGateway,
} from './workspace.controller.js';
import {
  updateWorkspaceSchema, updateSettingsSchema, createDomainSchema, updateDomainSchema, deleteDomainSchema, savePaymentGatewaySchema, updatePaymentGatewaySchema,
} from './workspace.validation.js';
import { authenticate } from '../auth/auth.middleware.js';
import { authorize } from '../auth/authorization.middleware.js';

function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse({ body: req.body, params: req.params, query: req.query });
    if (!result.success) return next(new z.ZodError(result.error.issues));
    if (result.data.body !== undefined) req.body = result.data.body;
    if (result.data.params !== undefined) req.params = result.data.params;
    next();
  };
}

// The caller's own tenant (from the token) — there is no tenant id in these URLs.
export const workspaceRouter = Router();
workspaceRouter.use(authenticate());

workspaceRouter.get('/', authorize('tenant:read'), getWorkspace);
workspaceRouter.patch('/', validate(updateWorkspaceSchema), authorize('tenant:update'), updateWorkspace);
workspaceRouter.get('/settings', authorize('tenant:read'), getSettings);
workspaceRouter.patch('/settings', validate(updateSettingsSchema), authorize('tenant:update'), updateSettings);
workspaceRouter.get('/domains', authorize('tenant:read'), listDomains);
workspaceRouter.post('/domains', validate(createDomainSchema), authorize('tenant:update'), createDomain);
workspaceRouter.patch('/domains/:domainId', validate(updateDomainSchema), authorize('tenant:update'), updateDomain);
workspaceRouter.post('/domains/:domainId/verify', validate(deleteDomainSchema), authorize('tenant:update'), verifyDomain);
workspaceRouter.delete('/domains/:domainId', validate(deleteDomainSchema), authorize('tenant:update'), deleteDomain);

// Phase 35: the shop's own Razorpay account. Secrets are write-only; tenant:update (owners/admins, not managers).
workspaceRouter.get('/payment-gateway', authorize('tenant:read'), getPaymentGateway);
workspaceRouter.put('/payment-gateway', validate(savePaymentGatewaySchema), authorize('tenant:update'), savePaymentGateway);
workspaceRouter.patch('/payment-gateway', validate(updatePaymentGatewaySchema), authorize('tenant:update'), updatePaymentGateway);
workspaceRouter.delete('/payment-gateway', authorize('tenant:update'), deletePaymentGateway);
