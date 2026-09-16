import { logger } from '../../config/logger.js';
import { QUEUE_NAMES, JOB_NAMES } from '../jobs.config.js';

/**
 * Report processor — DEFERRED (Phase 18).
 * In Phase 15 this is a provider-independent stub that logs and succeeds,
 * demonstrating queue/worker wiring without building real reporting/analytics logic.
 */
export async function processGenerateReport(payload, opts = {}) {
  const start = Date.now();
  const { tenantId, userId, reportType, filters } = payload;
  const jobId = opts.jobId || 'unknown';
  logger.info({ queue: QUEUE_NAMES.REPORT, jobId, tenantId, userId, reportType, jobName: JOB_NAMES.GENERATE_REPORT }, 'Report generation deferred — Phase 18 will implement provider logic');
  // Simulate minimal work; tenant-isolated placeholder
  logger.info({ queue: QUEUE_NAMES.REPORT, jobId, tenantId, durationMs: Date.now() - start }, 'Report job succeeded (deferred stub)');
  return { deferred: true, tenantId, reportType, filters, note: 'Report generation is deferred to Phase 18; no external provider called.' };
}
