import { Router } from 'express';
import { z } from 'zod';
import { listAuditLogs, listActivityLogs, getActivityLog } from './audit.controller.js';
import { listAuditLogsQuerySchema, listActivityLogsQuerySchema, getActivityLogSchema } from './audit.validation.js';
import { authenticate } from '../auth/auth.middleware.js';
import { authorize } from '../auth/authorization.middleware.js';

function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse({ body: req.body, params: req.params, query: req.query });
    if (!result.success) return next(new z.ZodError(result.error.issues));
    req.body = result.data.body;
    req.params = result.data.params;
    if (result.data.query) Object.assign(req.query, result.data.query);
    next();
  };
}

export const auditRouter = Router();
auditRouter.use(authenticate());
auditRouter.get('/', validate(listAuditLogsQuerySchema), authorize('audit:read'), listAuditLogs);

export const activityRouter = Router();
activityRouter.use(authenticate());
activityRouter.get('/', validate(listActivityLogsQuerySchema), authorize('activity:read'), listActivityLogs);
activityRouter.get('/:id', validate(getActivityLogSchema), authorize('activity:read'), getActivityLog);
