import { Queue } from 'bullmq';
import { getBullMqRedisConnection } from '../connection.js';
import { QUEUE_NAMES, QUEUE_PREFIX, DEFAULT_JOB_OPTIONS, JOB_NAMES, jobTimeoutMs } from '../jobs.config.js';
import { logger } from '../../config/logger.js';

let notificationQueue = null;

function getQueue() {
  if (notificationQueue) return notificationQueue;
  const connection = getBullMqRedisConnection();
  if (!connection) return null;
  notificationQueue = new Queue(QUEUE_NAMES.NOTIFICATION, {
    connection,
    prefix: QUEUE_PREFIX,
    defaultJobOptions: DEFAULT_JOB_OPTIONS[QUEUE_NAMES.NOTIFICATION],
  });
  notificationQueue.on('error', (err) => logger.warn({ err, queue: QUEUE_NAMES.NOTIFICATION }, 'Queue error'));
  return notificationQueue;
}

const SENSITIVE_KEYS = new Set(['password', 'passwordHash', 'password_hash', 'secret', 'token', 'refreshToken', 'accessToken', 'authorization', 'cookie']);

function containsSensitiveKey(obj) {
  if (!obj || typeof obj !== 'object') return false;
  for (const k of Object.keys(obj)) {
    if (SENSITIVE_KEYS.has(k) || k.toLowerCase().includes('password') || k.toLowerCase().includes('secret') || k.toLowerCase().includes('token') || k.toLowerCase().includes('authorization') || k.toLowerCase().includes('cookie')) {
      return true;
    }
    if (obj[k] && typeof obj[k] === 'object' && containsSensitiveKey(obj[k])) return true;
  }
  return false;
}

function sanitizeForLog(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const out = { ...payload };
  for (const k of SENSITIVE_KEYS) if (k in out) delete out[k];
  return out;
}

/**
 * Enqueue a notification job.
 * Tenant context is server-generated; never trust client-supplied tenantId blindly - caller must pass validated tenantId.
 * Idempotency: if idempotencyKey provided, used as BullMQ jobId for deterministic de-duplication.
 * No secrets/tokens/passwords should be placed in payload; validated here.
 */
export async function enqueueNotification({ tenantId, userId = null, type = 'INFO', title, message, channel = 'IN_APP', referenceType = null, referenceId = null, metadata = {}, idempotencyKey = null }) {
  if (!tenantId) throw new Error('tenantId is required for notification job');
  if (!title || !message) throw new Error('title and message are required');
  if (metadata && containsSensitiveKey(metadata)) {
    logger.warn({ queue: QUEUE_NAMES.NOTIFICATION, tenantId }, 'Rejecting notification job with sensitive payload keys');
    throw new Error('Sensitive data must not be enqueued in job payload');
  }
  if (containsSensitiveKey({ title, message })) {
    throw new Error('Sensitive data must not be enqueued');
  }

  const queue = getQueue();
  const payload = {
    tenantId, userId, type, title, message, channel, referenceType, referenceId, metadata,
    enqueuedAt: new Date().toISOString(),
  };

  if (!queue) {
    logger.warn({ queue: QUEUE_NAMES.NOTIFICATION }, 'Redis unavailable; notification job will be processed synchronously fallback');
    // Fallback: process directly via processor (synchronous) - caller can handle, but we return a fake job descriptor
    try {
      const { processSendNotification } = await import('../processors/notification.processor.js');
      const result = await processSendNotification(payload, { attempt: 1 });
      return { id: `sync-${Date.now()}`, fallback: true, result };
    } catch (err) {
      logger.warn({ err, queue: QUEUE_NAMES.NOTIFICATION }, 'Synchronous notification fallback failed');
      throw err;
    }
  }

  // BullMQ Custom Id cannot contain `:` — use `-`
  const rawJobId = idempotencyKey ? `notif-${tenantId}-${idempotencyKey}` : undefined;
  const jobId = rawJobId ? rawJobId.replace(/:/g, '-') : undefined;
  try {
    const job = await queue.add(JOB_NAMES.SEND_NOTIFICATION, payload, {
      jobId,
      attempts: DEFAULT_JOB_OPTIONS[QUEUE_NAMES.NOTIFICATION].attempts,
      backoff: DEFAULT_JOB_OPTIONS[QUEUE_NAMES.NOTIFICATION].backoff,
      removeOnComplete: DEFAULT_JOB_OPTIONS[QUEUE_NAMES.NOTIFICATION].removeOnComplete,
      removeOnFail: DEFAULT_JOB_OPTIONS[QUEUE_NAMES.NOTIFICATION].removeOnFail,
      timeout: jobTimeoutMs(QUEUE_NAMES.NOTIFICATION),
    });
    logger.info({ queue: QUEUE_NAMES.NOTIFICATION, jobId: job.id, tenantId, jobName: JOB_NAMES.SEND_NOTIFICATION, payload: sanitizeForLog(payload) }, 'Notification job enqueued');
    return job;
  } catch (err) {
    // Duplicate jobId (idempotent) - BullMQ throws error; treat as success (already enqueued)
    if (err?.message?.includes('JobId') || err?.code === 'EEXIST' || String(err?.message).toLowerCase().includes('already exists')) {
      logger.info({ queue: QUEUE_NAMES.NOTIFICATION, tenantId, idempotencyKey }, 'Duplicate notification job ignored (idempotent)');
      return { id: jobId, duplicate: true };
    }
    // Redis connection failure -> fallback to synchronous processing so HTTP does not fail and tests remain passing
    const isConnError = err?.code === 'ECONNREFUSED' || err?.message?.includes('ECONNREFUSED') || err?.message?.includes('Connection is closed') || err?.message?.includes('Redis');
    if (isConnError) {
      logger.warn({ err: err?.message, queue: QUEUE_NAMES.NOTIFICATION, tenantId }, 'Redis enqueue failed; falling back to synchronous notification processor');
      try {
        const { processSendNotification } = await import('../processors/notification.processor.js');
        const result = await processSendNotification(payload, { attempt: 1 });
        return { id: `sync-${Date.now()}`, fallback: true, result };
      } catch (fallbackErr) {
        logger.warn({ err: fallbackErr, queue: QUEUE_NAMES.NOTIFICATION }, 'Synchronous notification fallback failed');
        throw fallbackErr;
      }
    }
    logger.error({ err, queue: QUEUE_NAMES.NOTIFICATION, tenantId }, 'Failed to enqueue notification job');
    throw err;
  }
}

export function getNotificationQueue() {
  return getQueue();
}

export function _resetNotificationQueueForTest() {
  notificationQueue = null;
}
