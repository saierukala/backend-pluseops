import { Router } from 'express';
import { z } from 'zod';
import { authorizePlatform } from '../auth/authorization.middleware.js';
import * as c from './platform-ops.controller.js';
import * as v from './platform-ops.validation.js';

function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse({ body: req.body, params: req.params, query: req.query });
    if (!result.success) return next(new z.ZodError(result.error.issues));
    if (result.data.body !== undefined) req.body = result.data.body;
    if (result.data.params !== undefined) req.params = result.data.params;
    // Express 5 re-parses req.query on every access, so the coerced query travels on res.locals.
    res.locals.query = result.data.query ?? {};
    next();
  };
}

/** Phase 33 platform operations; mounted inside the platform router (platform token already required). */
export const platformOpsRouter = Router();

platformOpsRouter.get('/overview', authorizePlatform('platform:tenant:read'), c.overview);
platformOpsRouter.get('/tenants/:id/usage', validate(v.tenantParamsSchema), authorizePlatform('platform:tenant:read'), c.tenantUsage);
platformOpsRouter.patch('/tenants/:id/plan', validate(v.assignPlanSchema), authorizePlatform('platform:billing:update'), c.assignPlan);

platformOpsRouter.get('/plans', validate(v.listPlansSchema), authorizePlatform('platform:billing:read'), c.listPlans);
platformOpsRouter.post('/plans', validate(v.createPlanSchema), authorizePlatform('platform:billing:update'), c.createPlan);
platformOpsRouter.patch('/plans/:code', validate(v.updatePlanSchema), authorizePlatform('platform:billing:update'), c.updatePlan);

platformOpsRouter.get('/roles', authorizePlatform('platform:admin:read'), c.listRoles);
platformOpsRouter.get('/admins', authorizePlatform('platform:admin:read'), c.listAdmins);
platformOpsRouter.post('/admins', validate(v.addAdminSchema), authorizePlatform('platform:admin:manage'), c.addAdmin);
platformOpsRouter.delete('/admins/:userId', validate(v.adminParamsSchema), authorizePlatform('platform:admin:manage'), c.removeAdmin);

platformOpsRouter.get('/audit-logs', validate(v.listAuditSchema), authorizePlatform('platform:audit:read'), c.listAudit);
