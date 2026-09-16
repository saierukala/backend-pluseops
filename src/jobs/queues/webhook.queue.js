import { Queue } from 'bullmq';
import { getBullMqRedisConnection } from '../connection.js';
import { QUEUE_NAMES, QUEUE_PREFIX, DEFAULT_JOB_OPTIONS, JOB_NAMES, jobTimeoutMs } from '../jobs.config.js';
import { logger } from '../../config/logger.js';

let webhookQueue = null;

function getQueue() {
  if (webhookQueue) return webhookQueue;
  const connection = getBullMqRedisConnection();
  if (!connection) return null;
  webhookQueue = new Queue(QUEUE_NAMES.WEBHOOK, {
    connection,
    prefix: QUEUE_PREFIX,
    defaultJobOptions: DEFAULT_JOB_OPTIONS[QUEUE_NAMES.WEBHOOK],
  });
  webhookQueue.on('error', (err) => logger.warn({ err, queue: QUEUE_NAMES.WEBHOOK }, 'Queue error'));
  return webhookQueue;
}

// eslint-disable-next-line no-unused-vars
const _SENSITIVE_KEYS = new Set(['password', 'passwordHash', 'secret', 'token', 'refreshToken', 'accessToken', 'authorization', 'cookie', 'webhookSecret']);

function containsSensitive(payload) {
  if (!payload || typeof payload !== 'object') return false;
  for (const k of Object.keys(payload)) {
    const lower = String(k).toLowerCase();
    if (lower.includes('password') || lower.includes('secret') || lower.includes('token') || lower.includes('authorization') || lower.includes('cookie')) {
      // Allow eventId, providerPaymentId etc but not secrets; webhookSecret is forbidden
      if (lower.includes('webhooksecret') || lower.includes('api_secret') || lower === 'secret') return true;
    }
    if (payload[k] && typeof payload[k] === 'object' && containsSensitive(payload[k])) return true;
  }
  return false;
}

/**
 * Enqueue webhook processing.
 * Signature has already been verified synchronously in HTTP layer before enqueueing;
 * worker re-verifies via PaymentService.handleWebhook which also handles idempotency.
 * Tenant context is server-resolved (from DB lookup or payload) and propagated.
 */
export async function enqueueWebhook({ tenantId, eventId, payload, headers = {}, signature = null, idempotencyKey = null }) {
  if (!eventId) throw new Error('eventId is required for webhook job');
  if (!payload) throw new Error('payload is required');
  // Do not allow secrets beyond signature (which is validated, not stored long-term)
  if (containsSensitive(payload)) {
    logger.warn({ queue: QUEUE_NAMES.WEBHOOK }, 'Rejecting webhook job with sensitive payload');
    throw new Error('Sensitive data must not be enqueued');
  }

  const queue = getQueue();
  const jobPayload = { tenantId: tenantId || null, eventId, payload, headers, signature, enqueuedAt: new Date().toISOString() };
  const jobId = idempotencyKey ? `webhook:${idempotencyKey}` : `webhook:${eventId}`;

  if (!queue) {
    logger.warn({ queue: QUEUE_NAMES.WEBHOOK, eventId }, 'Redis unavailable; webhook job will be processed synchronously fallback');
    try {
      const { processWebhook } = await import('../processors/webhook.processor.js');
      const result = await processWebhook(jobPayload, { attempt: 1 });
      return { id: `sync-${Date.now()}`, fallback: true, result };
    } catch (err) {
      logger.warn({ err, queue: QUEUE_NAMES.WEBHOOK, eventId }, 'Synchronous webhook fallback failed');
      throw err;
    }
  }

  try {
    const job = await queue.add(JOB_NAMES.PROCESS_WEBHOOK, jobPayload, {
      jobId,
      attempts: DEFAULT_JOB_OPTIONS[QUEUE_NAMES.WEBHOOK].attempts,
      backoff: DEFAULT_JOB_OPTIONS[QUEUE_NAMES.WEBHOOK].backoff,
      removeOnComplete: DEFAULT_JOB_OPTIONS[QUEUE_NAMES.WEBHOOK].removeOnComplete,
      removeOnFail: DEFAULT_JOB_OPTIONS[QUEUE_NAMES.WEBHOOK].removeOnFail,
      timeout: jobTimeoutMs(QUEUE_NAMES.WEBHOOK),
    });
    logger.info({ queue: QUEUE_NAMES.WEBHOOK, jobId: job.id, eventId, tenantId, jobName: JOB_NAMES.PROCESS_WEBHOOK }, 'Webhook job enqueued');
    return job;
  } catch (err) {
    if (String(err?.message).toLowerCase().includes('already exists') || String(err?.message).includes('JobId')) {
      logger.info({ queue: QUEUE_NAMES.WEBHOOK, eventId, jobId }, 'Duplicate webhook job ignored (idempotent)');
      return { id: jobId, duplicate: true };
    }
    const isConnError = err?.code === 'ECONNREFUSED' || err?.message?.includes('ECONNREFUSED') || err?.message?.includes('Connection is closed') || err?.message?.includes('Redis');
    if (isConnError) {
      logger.warn({ err: err?.message, queue: QUEUE_NAMES.WEBHOOK, eventId }, 'Redis enqueue failed; falling back to synchronous webhook processor');
      try {
        const { processWebhook } = await import('../processors/webhook.processor.js');
        const result = await processWebhook(jobPayload, { attempt: 1 });
        return { id: `sync-${Date.now()}`, fallback: true, result };
      } catch (fallbackErr) {
        logger.warn({ err: fallbackErr, queue: QUEUE_NAMES.WEBHOOK, eventId }, 'Synchronous webhook fallback failed');
        throw fallbackErr;
      }
    }
    logger.error({ err, queue: QUEUE_NAMES.WEBHOOK, eventId }, 'Failed to enqueue webhook job');
    throw err;
  }
}

export function getWebhookQueue() { return getQueue(); }
export function _resetWebhookQueueForTest() { webhookQueue = null; }
