import { Router } from 'express';
import { z } from 'zod';
import { createReport, listReports, getReport, downloadReport } from './reports.controller.js';
import { createReportSchema, listReportsSchema, reportIdSchema } from './reports.validation.js';
import { authenticate } from '../auth/auth.middleware.js';
import { authorize } from '../auth/authorization.middleware.js';

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

export const reportsRouter = Router();
reportsRouter.use(authenticate());

reportsRouter.post('/', validate(createReportSchema), authorize('report:create'), createReport);
reportsRouter.get('/', validate(listReportsSchema), authorize('report:read'), listReports);
reportsRouter.get('/:id', validate(reportIdSchema), authorize('report:read'), getReport);
reportsRouter.get('/:id/download', validate(reportIdSchema), authorize('report:read'), downloadReport);
