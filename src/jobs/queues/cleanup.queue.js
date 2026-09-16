import { Queue } from 'bullmq';
import { getBullMqRedisConnection } from '../connection.js';
import { QUEUE_NAMES, QUEUE_PREFIX, DEFAULT_JOB_OPTIONS, JOB_NAMES, jobTimeoutMs } from '../jobs.config.js';
import { logger } from '../../config/logger.js';

let cleanupQueue = null;

function getQueue() {
  if (cleanupQueue) return cleanupQueue;
  const connection = getBullMqRedisConnection();
  if (!connection) return null;
  cleanupQueue = new Queue(QUEUE_NAMES.CLEANUP, {
    connection,
    prefix: QUEUE_PREFIX,
    defaultJobOptions: DEFAULT_JOB_OPTIONS[QUEUE_NAMES.CLEANUP],
  });
  cleanupQueue.on('error', (err) => logger.warn({ err, queue: QUEUE_NAMES.CLEANUP }, 'Queue error'));
  return cleanupQueue;
}

/**
 * Enqueue cleanup of expired tokens.
 * Tenant-scoped: if tenantId provided, only that tenant's tokens are cleaned; otherwise global.
 * Idempotency: deterministic jobId per day + tenant so repeated enqueues are deduplicated.
 */
export async function enqueueCleanup({ tenantId = null, idempotencyKey = null } = {}) {
  // No sensitive payload allowed
  const queue = getQueue();
  const payload = { tenantId: tenantId || null, requestedAt: new Date().toISOString() };
  const today = new Date().toISOString().slice(0, 10);
  const jobId = idempotencyKey ? `cleanup:${idempotencyKey}` : `cleanup:${tenantId || 'global'}:${today}`;

  if (!queue) {
    logger.warn({ queue: QUEUE_NAMES.CLEANUP }, 'Redis unavailable; cleanup job will be processed synchronously fallback');
    try {
      const { processCleanupExpiredTokens } = await import('../processors/cleanup.processor.js');
      const result = await processCleanupExpiredTokens(payload, { attempt: 1 });
      return { id: `sync-${Date.now()}`, fallback: true, result };
    } catch (err) {
      logger.warn({ err, queue: QUEUE_NAMES.CLEANUP }, 'Synchronous cleanup fallback failed');
      throw err;
    }
  }

  try {
    const job = await queue.add(JOB_NAMES.CLEANUP_EXPIRED_TOKENS, payload, {
      jobId,
      attempts: DEFAULT_JOB_OPTIONS[QUEUE_NAMES.CLEANUP].attempts,
      backoff: DEFAULT_JOB_OPTIONS[QUEUE_NAMES.CLEANUP].backoff,
      removeOnComplete: DEFAULT_JOB_OPTIONS[QUEUE_NAMES.CLEANUP].removeOnComplete,
      removeOnFail: DEFAULT_JOB_OPTIONS[QUEUE_NAMES.CLEANUP].removeOnFail,
      timeout: jobTimeoutMs(QUEUE_NAMES.CLEANUP),
    });
    logger.info({ queue: QUEUE_NAMES.CLEANUP, jobId: job.id, tenantId, jobName: JOB_NAMES.CLEANUP_EXPIRED_TOKENS }, 'Cleanup job enqueued');
    return job;
  } catch (err) {
    if (String(err?.message).toLowerCase().includes('already exists') || String(err?.message).includes('JobId')) {
      logger.info({ queue: QUEUE_NAMES.CLEANUP, tenantId, jobId }, 'Duplicate cleanup job ignored (idempotent)');
      return { id: jobId, duplicate: true };
    }
    const isConnError = err?.code === 'ECONNREFUSED' || err?.message?.includes('ECONNREFUSED') || err?.message?.includes('Connection is closed') || err?.message?.includes('Redis');
    if (isConnError) {
      logger.warn({ err: err?.message, queue: QUEUE_NAMES.CLEANUP, tenantId }, 'Redis enqueue failed; falling back to synchronous cleanup');
      try {
        const { processCleanupExpiredTokens } = await import('../processors/cleanup.processor.js');
        const result = await processCleanupExpiredTokens(payload, { attempt: 1 });
        return { id: `sync-${Date.now()}`, fallback: true, result };
      } catch (fallbackErr) {
        logger.warn({ err: fallbackErr, queue: QUEUE_NAMES.CLEANUP }, 'Synchronous cleanup fallback failed');
        throw fallbackErr;
      }
    }
    logger.error({ err, queue: QUEUE_NAMES.CLEANUP, tenantId }, 'Failed to enqueue cleanup job');
    throw err;
  }
}

export function getCleanupQueue() { return getQueue(); }
export function _resetCleanupQueueForTest() { cleanupQueue = null; }
