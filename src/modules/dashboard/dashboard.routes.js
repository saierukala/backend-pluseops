import { Router } from 'express';
import { getOverview } from './dashboard.controller.js';
import { authenticate } from '../auth/auth.middleware.js';
import { authorize } from '../auth/authorization.middleware.js';

export const dashboardRouter = Router();

dashboardRouter.use(authenticate());

// Dashboard overview aggregates multiple modules.
// Requires explicit dashboard:read permission.
// Tenant isolation is enforced via req.context.tenantId derived from JWT.
dashboardRouter.get('/overview', authorize('dashboard:read'), getOverview);
