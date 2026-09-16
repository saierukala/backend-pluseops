import { logger } from '../../config/logger.js';
import { QUEUE_NAMES, JOB_NAMES } from '../jobs.config.js';

/**
 * Analytics processor — DEFERRED (Phase 18).
 * Stub that preserves tenant isolation and logging; no real aggregation yet.
 */
export async function processCalculateAnalytics(payload, opts = {}) {
  const start = Date.now();
  const { tenantId, metric, period, filters } = payload;
  const jobId = opts.jobId || 'unknown';
  logger.info({ queue: QUEUE_NAMES.ANALYTICS, jobId, tenantId, metric, jobName: JOB_NAMES.CALCULATE_ANALYTICS }, 'Analytics calculation deferred — Phase 18 will implement aggregation');
  logger.info({ queue: QUEUE_NAMES.ANALYTICS, jobId, tenantId, durationMs: Date.now() - start }, 'Analytics job succeeded (deferred stub)');
  return { deferred: true, tenantId, metric, period, filters, note: 'Analytics calculation is deferred to Phase 18.' };
}
