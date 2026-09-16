import { AppError } from '../../common/errors/app-error.js';

export const IntegrationErrorCode = {
  TIMEOUT: 'INTEGRATION_TIMEOUT',
  UNAVAILABLE: 'INTEGRATION_UNAVAILABLE',
  AUTHENTICATION: 'INTEGRATION_AUTHENTICATION_FAILED',
  VALIDATION: 'INTEGRATION_VALIDATION_ERROR',
  REJECTION: 'INTEGRATION_REJECTED',
  NOT_FOUND: 'INTEGRATION_NOT_FOUND',
  RATE_LIMIT: 'INTEGRATION_RATE_LIMITED',
  CONFIGURATION: 'INTEGRATION_CONFIGURATION_ERROR',
  UNKNOWN: 'INTEGRATION_ERROR',
};

export class IntegrationError extends AppError {
  constructor(message, { code = IntegrationErrorCode.UNKNOWN, statusCode = 502, details = null, cause = null, provider = null } = {}) {
    super(message, { statusCode, code, details });
    this.name = 'IntegrationError';
    this.provider = provider;
    this.cause = cause;
  }

  isRetryable() {
    if (this.code === IntegrationErrorCode.VALIDATION) return false;
    if (this.code === IntegrationErrorCode.AUTHENTICATION) return false;
    if (this.code === IntegrationErrorCode.CONFIGURATION) return false;
    if (this.code === IntegrationErrorCode.NOT_FOUND) return false;
    if (this.code === IntegrationErrorCode.REJECTION) return false;
    if (this.statusCode >= 400 && this.statusCode < 500 && this.statusCode !== 408 && this.statusCode !== 429) return false;
    return this.code === IntegrationErrorCode.TIMEOUT || this.code === IntegrationErrorCode.UNAVAILABLE || this.statusCode === 429 || this.statusCode === 408 || this.statusCode >= 500;
  }
}

export function mapHttpStatusToCode(status) {
  if (status === 408 || status === 504) return IntegrationErrorCode.TIMEOUT;
  if (status === 429) return IntegrationErrorCode.RATE_LIMIT;
  if (status === 401 || status === 403) return IntegrationErrorCode.AUTHENTICATION;
  if (status === 404) return IntegrationErrorCode.NOT_FOUND;
  if (status === 400 || status === 422) return IntegrationErrorCode.VALIDATION;
  if (status >= 500) return IntegrationErrorCode.UNAVAILABLE;
  return IntegrationErrorCode.REJECTION;
}

export function normalizeProviderError(error, { provider = 'unknown', defaultCode = IntegrationErrorCode.UNKNOWN } = {}) {
  if (error instanceof IntegrationError) return error;
  if (error instanceof AppError) return error;

  const msg = error?.message || 'Provider error';
  // timeout detection
  if (error?.name === 'AbortError' || msg.toLowerCase().includes('abort') || msg.toLowerCase().includes('timeout') || error?.code === 'ETIMEDOUT') {
    return new IntegrationError(`Provider ${provider} timed out`, { code: IntegrationErrorCode.TIMEOUT, statusCode: 504, provider, cause: error });
  }
  // network
  if (error?.code === 'ECONNREFUSED' || error?.code === 'ENOTFOUND' || msg.includes('fetch failed') || msg.includes('Network')) {
    return new IntegrationError(`Provider ${provider} unavailable`, { code: IntegrationErrorCode.UNAVAILABLE, statusCode: 502, provider, cause: error });
  }
  // http status on error object
  const status = error?.statusCode || error?.status || error?.response?.status;
  if (status) {
    const code = mapHttpStatusToCode(status);
    const statusCode = status >= 400 && status < 600 ? status : 502;
    // do not leak raw provider body
    return new IntegrationError(`Provider ${provider} error`, { code, statusCode, provider, details: { providerStatus: status }, cause: error });
  }
  return new IntegrationError(`Provider ${provider} error`, { code: defaultCode, statusCode: 502, provider, cause: error });
}
