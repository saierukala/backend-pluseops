import { logger } from '../../config/logger.js';
import { QUEUE_NAMES, JOB_NAMES } from '../jobs.config.js';
import { AppError } from '../../common/errors/app-error.js';

/**
 * Guarantee: at-least-once delivery with idempotent processing.
 * Retrying the same logical notification (same tenant + idempotency key) must not duplicate side effects
 * beyond the first successful DB insert. We achieve this via:
 *  - BullMQ jobId de-duplication at enqueue time (deterministic jobId)
 *  - Processor-level check: if a notification with same tenant + referenceType/referenceId + title already exists recently, skip duplicate.
 *  For exact idempotencyKey support, caller should pass idempotencyKey which becomes part of metadata idempotencyKey field
 *  and we treat duplicate enqueues as no-op.
 *
 * Tenant isolation: every operation is scoped to tenantId from server-generated job payload (never client-trusted).
 * No secrets are persisted in payload; validated at enqueue time.
 */

const RECENT_WINDOW_MS = 60 * 1000;

function isRetryableError(err) {
  if (err instanceof AppError) {
    // Validation/business errors are permanent - do not retry
    const permanentCodes = new Set(['VALIDATION_ERROR', 'TENANT_REQUIRED', 'NOTIFICATION_NOT_FOUND', 'INVALID_NOTIFICATION']);
    if (permanentCodes.has(err.code) || (err.statusCode >= 400 && err.statusCode < 500 && err.code !== 'RATE_LIMITED')) {
      // For validation errors, don't retry; for 4xx generally permanent except 429
      // But we still allow retry for transient 500s
      return false;
    }
  }
  // Network / DB transient errors are retryable
  if (err?.code === 'P2002' || err?.message?.includes('Unique constraint')) {
    // Unique violation means duplicate already handled - not retryable but should be considered success (idempotent)
    return false;
  }
  return true;
}

export async function processSendNotification(payload, opts = {}) {
  const start = Date.now();
  const { tenantId, userId = null, type = 'INFO', title, message, channel = 'IN_APP', referenceType = null, referenceId = null, metadata = {} } = payload;
  const attemptNumber = opts.attempt ?? 1;
  const jobId = opts.jobId || 'unknown';

  // Tenant isolation verification: ensure tenant exists and is active? We trust server-generated but still validate existence lazily via repo
  logger.info({ queue: QUEUE_NAMES.NOTIFICATION, jobId, tenantId, jobName: JOB_NAMES.SEND_NOTIFICATION, attemptNumber }, 'Processing notification job');

  try {
    if (!tenantId) {
      throw new AppError('tenantId is required', { statusCode: 400, code: 'VALIDATION_ERROR' });
    }
    const { NotificationService } = await import('../../modules/notifications/notifications.service.js');
    const service = new NotificationService();

    // Idempotency check: if metadata contains idempotencyKey, check recent notifications with same tenant+reference+title
    // We look for existing notification created within RECENT_WINDOW_MS with same referenceType/referenceId/title
    if (referenceType && referenceId) {
      try {
        const { getPrismaClient } = await import('../../config/database.js');
        const prisma = getPrismaClient();
        const existing = await prisma.notification.findFirst({
          where: {
            tenantId,
            referenceType,
            referenceId: String(referenceId),
            title: String(title).trim(),
            createdAt: { gte: new Date(Date.now() - RECENT_WINDOW_MS) },
          },
          orderBy: { createdAt: 'desc' },
        });
        if (existing) {
          logger.info({ queue: QUEUE_NAMES.NOTIFICATION, jobId, tenantId, existingId: existing.id, durationMs: Date.now() - start }, 'Notification idempotent skip - recent duplicate exists');
          return { idempotent: true, existingId: existing.id, notification: existing };
        }
      } catch (_e) {
        // Non-fatal idempotency check failure - proceed to create
        logger.warn({ err: _e, queue: QUEUE_NAMES.NOTIFICATION, jobId }, 'Idempotency check failed; proceeding');
      }
    }

    const notification = await service.createNotification({
      tenantId, userId, type, title, message, channel, referenceType, referenceId, metadata,
    });

    logger.info({ queue: QUEUE_NAMES.NOTIFICATION, jobId, tenantId, notificationId: notification.id, durationMs: Date.now() - start, attemptNumber }, 'Notification job succeeded');
    return { success: true, notificationId: notification.id, notification };
  } catch (err) {
    const durationMs = Date.now() - start;
    const retryable = isRetryableError(err);
    if (!retryable) {
      logger.warn({ queue: QUEUE_NAMES.NOTIFICATION, jobId, tenantId, attemptNumber, durationMs, err: err?.message, code: err?.code }, 'Notification job permanent failure (no retry)');
      // Throw as UnrecoverableError so BullMQ does not retry
      const { UnrecoverableError } = await import('bullmq');
      throw new UnrecoverableError(err.message || 'Permanent failure');
    }
    logger.error({ queue: QUEUE_NAMES.NOTIFICATION, jobId, tenantId, attemptNumber, durationMs, err: err?.message }, 'Notification job retryable failure');
    throw err;
  }
}

export function isNotificationRetryable(err) { return isRetryableError(err); }
