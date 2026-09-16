import { createEmailProvider } from './email.provider.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { AppError } from '../../common/errors/app-error.js';

export class EmailService {
  constructor(provider) {
    this.provider = provider || createEmailProvider(env.EMAIL_PROVIDER || 'mock');
  }

  async sendEmail({ tenantId, to, subject, html = null, text = null, template = null, variables = {} }) {
    if (!tenantId) throw new AppError('tenantId is required', { statusCode: 400, code: 'VALIDATION_ERROR' });
    if (!to) throw new AppError('to is required', { statusCode: 400, code: 'VALIDATION_ERROR' });
    // Never allow secrets in variables; we validate at queue layer too
    // provider invocation is isolated behind adapter; business logic no longer knows vendor field names
    const result = await this.provider.send({ to, subject, html, text, template, variables, tenantId });
    logger.info({ tenantId, to, provider: this.provider.providerName, providerId: result.providerId }, 'Email dispatched via provider adapter');
    return result;
  }
}
