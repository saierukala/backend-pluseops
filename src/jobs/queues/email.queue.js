import { Queue } from 'bullmq';
import { getBullMqRedisConnection } from '../connection.js';
import { QUEUE_NAMES, QUEUE_PREFIX, DEFAULT_JOB_OPTIONS, JOB_NAMES, jobTimeoutMs } from '../jobs.config.js';
import { logger } from '../../config/logger.js';

/**
 * Email queue — DEFERRED provider integration.
 * Phase 16 will attach real email provider (SES/SendGrid/etc) via adapter.
 * Phase 15 provides queue + job boundary only; processor is a safe no-op that logs.
 */
let emailQueue = null;

function getQueue() {
  if (emailQueue) return emailQueue;
  const connection = getBullMqRedisConnection();
  if (!connection) return null;
  emailQueue = new Queue(QUEUE_NAMES.EMAIL, {
    connection,
    prefix: QUEUE_PREFIX,
    defaultJobOptions: DEFAULT_JOB_OPTIONS[QUEUE_NAMES.EMAIL],
  });
  emailQueue.on('error', (err) => logger.warn({ err, queue: QUEUE_NAMES.EMAIL }, 'Queue error'));
  return emailQueue;
}

export async function enqueueEmail({ tenantId, to, subject, template = null, variables = {}, idempotencyKey = null }) {
  if (!tenantId) throw new Error('tenantId is required');
  if (!to) throw new Error('to is required');
  const queue = getQueue();
  const payload = { tenantId, to, subject, template, variables, enqueuedAt: new Date().toISOString() };
  // BullMQ Custom Id cannot contain `:` — use `-`
  const rawJobId = idempotencyKey ? `email-${tenantId}-${idempotencyKey}` : undefined;
  const jobId = rawJobId ? rawJobId.replace(/:/g, '-') : undefined;

  if (!queue) {
    logger.warn({ queue: QUEUE_NAMES.EMAIL }, 'Redis unavailable; email job deferred (no provider)');
    return { id: `deferred-${Date.now()}`, fallback: true, deferred: true };
  }

  try {
    const job = await queue.add(JOB_NAMES.SEND_EMAIL, payload, {
      jobId,
      attempts: DEFAULT_JOB_OPTIONS[QUEUE_NAMES.EMAIL].attempts,
      backoff: DEFAULT_JOB_OPTIONS[QUEUE_NAMES.EMAIL].backoff,
      removeOnComplete: DEFAULT_JOB_OPTIONS[QUEUE_NAMES.EMAIL].removeOnComplete,
      removeOnFail: DEFAULT_JOB_OPTIONS[QUEUE_NAMES.EMAIL].removeOnFail,
      timeout: jobTimeoutMs(QUEUE_NAMES.EMAIL),
    });
    logger.info({ queue: QUEUE_NAMES.EMAIL, jobId: job.id, tenantId }, 'Email job enqueued (provider deferred)');
    return job;
  } catch (err) {
    if (String(err?.message).toLowerCase().includes('already exists') || String(err?.message).includes('JobId')) {
      return { id: jobId, duplicate: true };
    }
    logger.error({ err, queue: QUEUE_NAMES.EMAIL }, 'Failed to enqueue email job');
    throw err;
  }
}

export function getEmailQueue() { return getQueue(); }
export function _resetEmailQueueForTest() { emailQueue = null; }
