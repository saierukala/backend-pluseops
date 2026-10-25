import { UnrecoverableError } from 'bullmq';
import { logger } from '../../config/logger.js';
import { QUEUE_NAMES, JOB_NAMES } from '../jobs.config.js';

/**
 * Report processor (Phase 31): builds the CSV for a Report row and stores it in tenant storage.
 * Tenant isolation: the report is looked up by (reportId, tenantId) from the server-built payload.
 */
export async function processGenerateReport(payload, opts = {}) {
  const start = Date.now();
  const { tenantId, reportId } = payload;
  const jobId = opts.jobId || 'unknown';
  if (!tenantId || !reportId) throw new UnrecoverableError('tenantId and reportId are required');
  logger.info({ queue: QUEUE_NAMES.REPORT, jobId, tenantId, reportId, jobName: JOB_NAMES.GENERATE_REPORT }, 'Generating report');
  const { reportService } = await import('../../modules/reports/reports.service.js');
  const result = await reportService.generate(tenantId, reportId);
  logger.info({ queue: QUEUE_NAMES.REPORT, jobId, tenantId, reportId, rowCount: result.rowCount, durationMs: Date.now() - start }, 'Report job finished');
  return result;
}

/** Phase 36: hourly — requests the reports whose schedule period has just ended (all tenants, server-triggered). */
/** Phase 40: raise the recurring invoices that are due. */
export async function processRunRecurringInvoices(payload, opts = {}) {
  const { recurringInvoicesService } = await import('../../modules/recurring/recurring-invoices.service.js');
  const result = await recurringInvoicesService.runDue(new Date());
  logger.info({ queue: QUEUE_NAMES.REPORT, jobId: opts.jobId || 'unknown', checked: result.checked, raised: result.raised }, 'Recurring invoices checked');
  return result;
}

export async function processRunReportSchedules(payload, opts = {}) {
  const { reportScheduleService } = await import('../../modules/reports/report-schedules.service.js');
  const result = await reportScheduleService.runDue(new Date());
  logger.info({ queue: QUEUE_NAMES.REPORT, jobId: opts.jobId || 'unknown', checked: result.checked, ran: result.ran }, 'Report schedules checked');
  return { checked: result.checked, ran: result.ran };
}
