import { Queue } from 'bullmq';
import { getBullMqRedisConnection } from '../connection.js';
import { QUEUE_NAMES, QUEUE_PREFIX, DEFAULT_JOB_OPTIONS, JOB_NAMES, jobTimeoutMs } from '../jobs.config.js';
import { logger } from '../../config/logger.js';

/**
 * Analytics queue — DEFERRED (Phase 18).
 * Queue/worker boundary exists; processor is a safe stub in Phase 15.
 */
let analyticsQueue = null;

function getQueue() {
  if (analyticsQueue) return analyticsQueue;
  const connection = getBullMqRedisConnection();
  if (!connection) return null;
  analyticsQueue = new Queue(QUEUE_NAMES.ANALYTICS, {
    connection,
    prefix: QUEUE_PREFIX,
    defaultJobOptions: DEFAULT_JOB_OPTIONS[QUEUE_NAMES.ANALYTICS],
  });
  analyticsQueue.on('error', (err) => logger.warn({ err, queue: QUEUE_NAMES.ANALYTICS }, 'Queue error'));
  return analyticsQueue;
}

export async function enqueueAnalytics({ tenantId, metric = 'generic', period = null, filters = {}, idempotencyKey = null }) {
  if (!tenantId) throw new Error('tenantId is required');
  const queue = getQueue();
  const payload = { tenantId, metric, period, filters, enqueuedAt: new Date().toISOString() };
  const jobId = idempotencyKey ? `analytics:${tenantId}:${idempotencyKey}` : undefined;
  if (!queue) {
    logger.warn({ queue: QUEUE_NAMES.ANALYTICS }, 'Redis unavailable; analytics job deferred');
    return { id: `deferred-${Date.now()}`, fallback: true, deferred: true };
  }
  try {
    const job = await queue.add(JOB_NAMES.CALCULATE_ANALYTICS, payload, {
      jobId,
      attempts: DEFAULT_JOB_OPTIONS[QUEUE_NAMES.ANALYTICS].attempts,
      backoff: DEFAULT_JOB_OPTIONS[QUEUE_NAMES.ANALYTICS].backoff,
      removeOnComplete: DEFAULT_JOB_OPTIONS[QUEUE_NAMES.ANALYTICS].removeOnComplete,
      removeOnFail: DEFAULT_JOB_OPTIONS[QUEUE_NAMES.ANALYTICS].removeOnFail,
      timeout: jobTimeoutMs(QUEUE_NAMES.ANALYTICS),
    });
    logger.info({ queue: QUEUE_NAMES.ANALYTICS, jobId: job.id, tenantId, metric }, 'Analytics job enqueued (calculation deferred)');
    return job;
  } catch (err) {
    if (String(err?.message).toLowerCase().includes('already exists') || String(err?.message).includes('JobId')) {
      return { id: jobId, duplicate: true };
    }
    logger.error({ err, queue: QUEUE_NAMES.ANALYTICS }, 'Failed to enqueue analytics job');
    throw err;
  }
}

export function getAnalyticsQueue() { return getQueue(); }
export function _resetAnalyticsQueueForTest() { analyticsQueue = null; }
