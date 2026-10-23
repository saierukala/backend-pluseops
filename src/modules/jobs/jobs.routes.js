import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../auth/auth.middleware.js';
import { authorize } from '../auth/authorization.middleware.js';
import { getJobsStatus, triggerCleanup, triggerNotification, triggerReport, triggerAnalytics } from './jobs.controller.js';
import { ANALYTICS_METRICS } from '../../jobs/processors/analytics.processor.js';

function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse({ body: req.body, params: req.params, query: req.query });
    if (!result.success) return next(new z.ZodError(result.error.issues));
    req.body = result.data.body;
    req.params = result.data.params;
    next();
  };
}

const notificationJobSchema = z.object({
  body: z.object({
    title: z.string().min(1).max(255),
    message: z.string().min(1).max(2000),
    type: z.enum(['INFO', 'SUCCESS', 'WARNING', 'ERROR']).optional(),
    channel: z.enum(['IN_APP', 'EMAIL', 'SMS', 'PUSH']).optional(),
    referenceType: z.string().max(100).optional(),
    referenceId: z.string().max(255).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    idempotencyKey: z.string().max(255).optional(),
  }).strict(),
});

export const jobsRouter = Router();

jobsRouter.get('/status', authenticate(), authorize('jobs:read'), getJobsStatus);
jobsRouter.post('/cleanup', authenticate(), authorize('jobs:manage'), triggerCleanup);
jobsRouter.post('/notifications', authenticate(), validate(notificationJobSchema), authorize('jobs:manage'), triggerNotification);
// Phase 31: same as POST /reports (creates a Report row); kept for existing callers. `reportType` = ORDERS | INVENTORY | CUSTOMERS.
jobsRouter.post('/reports', authenticate(), authorize('jobs:manage'), validate(z.object({ body: z.object({ reportType: z.string(), filters: z.record(z.string(), z.unknown()).optional() }) })), triggerReport);
jobsRouter.post('/analytics', authenticate(), authorize('jobs:manage'), validate(z.object({ body: z.object({ metric: z.enum(Object.keys(ANALYTICS_METRICS)).optional(), filters: z.object({ from: z.string().optional(), to: z.string().optional(), groupBy: z.enum(['day', 'week', 'month']).optional() }).optional(), idempotencyKey: z.string().optional() }) })), triggerAnalytics);
