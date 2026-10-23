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
