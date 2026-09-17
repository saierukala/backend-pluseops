import { logger } from '../../config/logger.js';
import { QUEUE_NAMES, JOB_NAMES } from '../jobs.config.js';
import { AppError } from '../../common/errors/app-error.js';

/**
 * Webhook processor preserves existing payment webhook guarantees:
 * - HMAC verification (do not weaken to move to queue)
 * - idempotency via unique constraint + ON CONFLICT
 * - tenant isolation via tenant_id scoped operations
 * - payment state machine transitions
 *
 * Enqueued payload was already validated for signature synchronously in HTTP layer,
 * but processor re-validates via PaymentService.handleWebhook to ensure safety.
 */

function isRetryableError(err) {
  if (err instanceof AppError) {
    // Permanent failures: invalid signature, missing eventId, tenant resolution failure, validation
    const permanentCodes = new Set(['INVALID_WEBHOOK', 'INVALID_WEBHOOK_SIGNATURE', 'VALIDATION_ERROR', 'PAYMENT_NOT_FOUND']);
    if (permanentCodes.has(err.code)) return false;
    if (err.statusCode === 401 || err.statusCode === 400) {
      // For webhook, 401/400 are permanent (bad signature, bad payload)
      // Except 404 where payment not found might be transient? Treat as permanent for now
      return false;
    }
  }
  // Unique constraint duplicate is handled inside service as success (duplicate:true) - not an error to retry
  if (err?.code === 'P2002' || String(err?.message).includes('Unique constraint') || String(err?.message).includes('duplicate key')) {
    return false;
  }
  return true;
}

export async function processWebhook(payload, opts = {}) {
  const start = Date.now();
  const { tenantId, eventId, payload: webhookPayload, rawBody = null, headers = {}, signature = null } = payload;
  const jobId = opts.jobId || 'unknown';
  const attemptNumber = opts.attempt ?? 1;

  logger.info({ queue: QUEUE_NAMES.WEBHOOK, jobId, tenantId, eventId, jobName: JOB_NAMES.PROCESS_WEBHOOK, attemptNumber }, 'Processing webhook job');

  if (!eventId || !webhookPayload) {
    logger.warn({ queue: QUEUE_NAMES.WEBHOOK, jobId, attemptNumber }, 'Webhook job missing eventId or payload');
    const { UnrecoverableError } = await import('bullmq');
    throw new UnrecoverableError('Missing eventId or payload');
  }

  try {
    const { PaymentService } = await import('../../modules/payments/payments.service.js');
    const service = new PaymentService();
    const sig = signature || headers?.['x-webhook-signature'] || headers?.['x-payment-signature'];
    // Prefer rawBody for HMAC verification (exact bytes provider signed); service falls back to payload JSON if rawBody missing (backwards compat for older enqueued jobs)
    const result = await service.handleWebhook(rawBody, webhookPayload, headers, sig);

    logger.info({
      queue: QUEUE_NAMES.WEBHOOK, jobId, tenantId: result?.payment?.tenantId || tenantId, eventId, duplicate: result?.duplicate, paymentId: result?.payment?.id, status: result?.payment?.status, durationMs: Date.now() - start, attemptNumber,
    }, result?.duplicate ? 'Webhook job idempotent duplicate handled' : 'Webhook job succeeded');

    return result;
  } catch (err) {
    const durationMs = Date.now() - start;
    const retryable = isRetryableError(err);
    if (!retryable) {
      logger.warn({ queue: QUEUE_NAMES.WEBHOOK, jobId, tenantId, eventId, attemptNumber, durationMs, err: err?.message, code: err?.code }, 'Webhook job permanent failure (no retry)');
      const { UnrecoverableError } = await import('bullmq');
      throw new UnrecoverableError(err.message || 'Permanent webhook failure');
    }
    logger.error({ queue: QUEUE_NAMES.WEBHOOK, jobId, tenantId, eventId, attemptNumber, durationMs, err: err?.message }, 'Webhook job retryable failure');
    throw err;
  }
}

export function isWebhookRetryable(err) { return isRetryableError(err); }
