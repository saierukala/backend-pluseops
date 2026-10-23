import { enqueueNotification } from '../../jobs/queues/notification.queue.js';
import { enqueueCleanup } from '../../jobs/queues/cleanup.queue.js';
import { z } from 'zod';
import { reportService } from '../reports/reports.service.js';
import { reportRequestBody } from '../reports/reports.validation.js';
import { enqueueAnalytics } from '../../jobs/queues/analytics.queue.js';
import { getWorkers, isWorkersStarted } from '../../jobs/workers/index.js';
import { isBullMqEnabled } from '../../jobs/connection.js';
import { QUEUE_NAMES } from '../../jobs/jobs.config.js';

export async function getJobsStatus(req, res, next) {
  try {
    const workers = getWorkers();
    res.status(200).json({
      success: true,
      data: {
        enabled: isBullMqEnabled(),
        workersStarted: isWorkersStarted(),
        workerCount: workers.length,
        queues: Object.values(QUEUE_NAMES),
      },
      message: 'Jobs status retrieved',
    });
  } catch (error) { next(error); }
}

export async function triggerCleanup(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const job = await enqueueCleanup({ tenantId });
    const enqueued = Boolean(job?.id);
    res.status(job?.fallback ? 200 : 202).json({
      success: true,
      data: { jobId: job?.id || null, enqueued, fallback: Boolean(job?.fallback), duplicate: Boolean(job?.duplicate) },
      message: job?.fallback ? 'Cleanup processed synchronously (Redis unavailable)' : 'Cleanup job enqueued',
    });
  } catch (error) { next(error); }
}

export async function triggerNotification(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const userId = req.context.userId;
    const { title, message, type, channel, referenceType, referenceId, metadata, idempotencyKey } = req.body;
    const job = await enqueueNotification({ tenantId, userId, title, message, type, channel, referenceType, referenceId, metadata, idempotencyKey });
    res.status(job?.fallback ? 200 : 202).json({
      success: true,
      data: { jobId: job?.id || null, fallback: Boolean(job?.fallback), duplicate: Boolean(job?.duplicate) },
      message: job?.fallback ? 'Notification processed synchronously' : 'Notification job enqueued',
    });
  } catch (error) { next(error); }
}

export async function triggerReport(req, res, next) {
  try {
    const parsed = reportRequestBody.safeParse({ type: req.body.reportType, filters: req.body.filters });
    if (!parsed.success) throw new z.ZodError(parsed.error.issues);
    const report = await reportService.request(req.context, parsed.data, { ipAddress: req.ip || null, userAgent: req.headers['user-agent'] || null });
    res.status(202).json({ success: true, data: { jobId: `report-${report.id}`, reportId: report.id, status: report.status }, message: 'Report requested' });
  } catch (error) { next(error); }
}

export async function triggerAnalytics(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { metric, filters, idempotencyKey } = req.body;
    const job = await enqueueAnalytics({ tenantId, metric, filters, idempotencyKey });
    res.status(202).json({ success: true, data: { jobId: job?.id || null, fallback: Boolean(job?.fallback) }, message: 'Analytics job enqueued' });
  } catch (error) { next(error); }
}
