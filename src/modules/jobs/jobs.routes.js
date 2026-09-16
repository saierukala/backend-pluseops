import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../auth/auth.middleware.js';
import { getJobsStatus, triggerCleanup, triggerNotification, triggerReport, triggerAnalytics } from './jobs.controller.js';

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

jobsRouter.get('/status', authenticate(), getJobsStatus);
jobsRouter.post('/cleanup', authenticate(), triggerCleanup);
jobsRouter.post('/notifications', authenticate(), validate(notificationJobSchema), triggerNotification);
jobsRouter.post('/reports', authenticate(), validate(z.object({ body: z.object({ reportType: z.string().optional(), filters: z.record(z.string(), z.unknown()).optional(), idempotencyKey: z.string().optional() }).passthrough() })), triggerReport);
jobsRouter.post('/analytics', authenticate(), validate(z.object({ body: z.object({ metric: z.string().optional(), period: z.string().optional(), filters: z.record(z.string(), z.unknown()).optional(), idempotencyKey: z.string().optional() }).passthrough() })), triggerAnalytics);
