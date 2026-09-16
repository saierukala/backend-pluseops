import { logger } from '../../config/logger.js';
import { QUEUE_NAMES, JOB_NAMES } from '../jobs.config.js';
import { IntegrationError } from '../../integrations/errors/integration-error.js';

function isRetryableEmailError(err) {
  if (err instanceof IntegrationError) return err.isRetryable();
  if (err?.name === 'UnrecoverableError') return false;
  return true;
}

export async function processSendEmail(payload, opts = {}) {
  const start = Date.now();
  const { tenantId, to, subject, template, variables = {}, html, text } = payload;
  const jobId = opts.jobId || 'unknown';

  if (!tenantId) {
    const { AppError } = await import('../../common/errors/app-error.js');
    const err = new AppError('tenantId is required', { statusCode: 400, code: 'VALIDATION_ERROR' });
    const { UnrecoverableError } = await import('bullmq');
    throw new UnrecoverableError(err.message);
  }
  if (!to || !subject) {
    const { UnrecoverableError } = await import('bullmq');
    throw new UnrecoverableError('to and subject are required');
  }

  // Ensure no secrets leaked into payload; sanitize log
  logger.info({ queue: QUEUE_NAMES.EMAIL, jobId, tenantId, to, subject, template, jobName: JOB_NAMES.SEND_EMAIL }, 'Processing email job via provider adapter');

  try {
    const { EmailService } = await import('../../integrations/email/email.service.js');
    const service = new EmailService();
    const result = await service.sendEmail({ tenantId, to, subject, template, variables, html, text });
    logger.info({ queue: QUEUE_NAMES.EMAIL, jobId, tenantId, durationMs: Date.now() - start, providerId: result.providerId }, 'Email job succeeded via provider');
    return { success: true, providerId: result.providerId, tenantId, to, provider: result.mapped?.provider || 'mock' };
  } catch (err) {
    const durationMs = Date.now() - start;
    const retryable = isRetryableEmailError(err);
    if (!retryable) {
      logger.warn({ queue: QUEUE_NAMES.EMAIL, jobId, tenantId, durationMs, err: err?.message, code: err?.code }, 'Email job permanent failure');
      const { UnrecoverableError } = await import('bullmq');
      throw new UnrecoverableError(err.message || 'Permanent email failure');
    }
    logger.error({ queue: QUEUE_NAMES.EMAIL, jobId, tenantId, durationMs, err: err?.message }, 'Email job retryable failure');
    throw err;
  }
}
