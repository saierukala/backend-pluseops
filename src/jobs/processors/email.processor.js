import { logger } from '../../config/logger.js';
import { QUEUE_NAMES, JOB_NAMES } from '../jobs.config.js';

/**
 * Email processor — DEFERRED provider (Phase 16).
 * Phase 15 only logs; real email adapter arrives in Phase 16.
 */

export async function processSendEmail(payload, opts = {}) {
  const start = Date.now();
  const { tenantId, to, subject, template } = payload;
  const jobId = opts.jobId || 'unknown';
  logger.info({ queue: QUEUE_NAMES.EMAIL, jobId, tenantId, to, subject, template, jobName: JOB_NAMES.SEND_EMAIL }, 'Email dispatch deferred — Phase 16 will implement provider adapter');
  logger.info({ queue: QUEUE_NAMES.EMAIL, jobId, tenantId, durationMs: Date.now() - start }, 'Email job succeeded (deferred stub)');
  return { deferred: true, tenantId, to, note: 'Email provider is deferred to Phase 16; no external email sent.' };
}
