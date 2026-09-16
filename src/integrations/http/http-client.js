import { IntegrationError, IntegrationErrorCode, normalizeProviderError } from '../errors/integration-error.js';
import { logger } from '../../config/logger.js';

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RETRIES = 2;

function isRetryableStatus(status) {
  return status === 408 || status === 429 || status === 502 || status === 503 || status === 504;
}

function isRetryableError(error) {
  if (error instanceof IntegrationError) return error.isRetryable();
  const msg = error?.message || '';
  if (msg.toLowerCase().includes('timeout') || error?.name === 'AbortError') return true;
  if (error?.code === 'ECONNREFUSED' || error?.code === 'ENOTFOUND') return true;
  const status = error?.statusCode || error?.status || error?.response?.status;
  if (status && isRetryableStatus(status)) return true;
  return false;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function fetchWithTimeout(url, options = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, provider = 'http' } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new IntegrationError(`Provider ${provider} timed out after ${timeoutMs}ms`, {
        code: IntegrationErrorCode.TIMEOUT,
        statusCode: 504,
        provider,
        cause: err,
      });
    }
    throw normalizeProviderError(err, { provider });
  } finally {
    clearTimeout(timeout);
  }
}

export async function requestWithRetry(url, options = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, retries = DEFAULT_RETRIES, provider = 'http', retryDelayMs = 200, idempotent = true } = {}) {
  let lastError = null;
  const maxAttempts = idempotent ? retries + 1 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await fetchWithTimeout(url, options, { timeoutMs, provider });
      if (!res.ok) {
        const status = res.status;
        if (isRetryableStatus(status) && attempt < maxAttempts) {
          logger.warn({ provider, url, status, attempt }, 'Retryable HTTP status, will retry');
          await sleep(retryDelayMs * attempt);
          continue;
        }
        // normalize non-ok status
        const err = new IntegrationError(`Provider ${provider} returned ${status}`, {
          code: status === 429 ? IntegrationErrorCode.RATE_LIMIT : status === 404 ? IntegrationErrorCode.NOT_FOUND : (status === 401 || status === 403) ? IntegrationErrorCode.AUTHENTICATION : status >= 500 ? IntegrationErrorCode.UNAVAILABLE : IntegrationErrorCode.REJECTION,
          statusCode: status,
          provider,
          details: { providerStatus: status },
        });
        // only retry if retryable and idempotent
        if (isRetryableError(err) && idempotent && attempt < maxAttempts) {
          await sleep(retryDelayMs * attempt);
          continue;
        }
        throw err;
      }
      return res;
    } catch (err) {
      lastError = normalizeProviderError(err, { provider });
      if (!isRetryableError(lastError) || !idempotent || attempt >= maxAttempts) {
        throw lastError;
      }
      logger.warn({ provider, url, attempt, error: lastError.message }, 'Retryable error, retrying request');
      await sleep(retryDelayMs * attempt);
    }
  }
  throw lastError;
}

export function mapProviderResponse(provider, raw) {
  // generic mapper: never leak provider internals; convert to domain shape
  if (provider === 'email') {
    return { providerId: raw?.id || raw?.messageId || null, status: raw?.status || 'sent', provider };
  }
  if (provider === 'sms') {
    return { providerId: raw?.sid || raw?.id || null, status: raw?.status || 'sent', provider };
  }
  if (provider === 'shipping') {
    return {
      rate: raw?.rate ?? raw?.price ?? null,
      currency: raw?.currency || 'USD',
      eta: raw?.eta || raw?.estimatedDays || null,
      provider,
    };
  }
  if (provider === 'maps') {
    return {
      lat: raw?.lat ?? raw?.latitude ?? null,
      lng: raw?.lng ?? raw?.longitude ?? null,
      address: raw?.address || raw?.formatted || null,
      provider,
    };
  }
  if (provider === 'payment') {
    return {
      providerPaymentId: raw?.id || raw?.paymentId || null,
      status: raw?.status || 'unknown',
      provider,
    };
  }
  return { provider, rawMapped: true };
}
