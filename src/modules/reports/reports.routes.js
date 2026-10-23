import { Router } from 'express';
import { z } from 'zod';
import {
  createReport, listReports, getReport, downloadReport,
  createReportSchedule, listReportSchedules, getReportSchedule, updateReportSchedule, deleteReportSchedule,
} from './reports.controller.js';
import {
  createReportSchema, listReportsSchema, reportIdSchema, createReportScheduleSchema, updateReportScheduleSchema, listReportSchedulesSchema,
} from './reports.validation.js';
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

// Phase 36: a schedule requests reports on its own, so managing one needs report:create (reading: report:read)
export const reportSchedulesRouter = Router();
reportSchedulesRouter.use(authenticate());
reportSchedulesRouter.post('/', validate(createReportScheduleSchema), authorize('report:create'), createReportSchedule);
reportSchedulesRouter.get('/', validate(listReportSchedulesSchema), authorize('report:read'), listReportSchedules);
reportSchedulesRouter.get('/:id', validate(reportIdSchema), authorize('report:read'), getReportSchedule);
reportSchedulesRouter.patch('/:id', validate(updateReportScheduleSchema), authorize('report:create'), updateReportSchedule);
reportSchedulesRouter.delete('/:id', validate(reportIdSchema), authorize('report:create'), deleteReportSchedule);
