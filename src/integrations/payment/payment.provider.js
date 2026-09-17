import { IntegrationError, IntegrationErrorCode, normalizeProviderError } from '../errors/integration-error.js';
import { requestWithRetry, mapProviderResponse } from '../http/http-client.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

export class MockPaymentProvider {
  constructor(options = {}) {
    this.providerName = 'mock';
    this.shouldTimeout = options.shouldTimeout || false;
    this.shouldFail = options.shouldFail || false;
    this.failStatus = options.failStatus || 502;
    this.delayMs = options.delayMs || 0;
  }

  async charge({ amount, currency, orderId, tenantId, idempotencyKey: _idempotencyKey }) {
    if (this.shouldTimeout) {
      throw new IntegrationError('Provider mock timed out', { code: IntegrationErrorCode.TIMEOUT, statusCode: 504, provider: 'mock' });
    }
    if (this.shouldFail) {
      throw new IntegrationError('Provider mock unavailable', { code: IntegrationErrorCode.UNAVAILABLE, statusCode: this.failStatus, provider: 'mock' });
    }
    if (!amount || Number(amount) <= 0) {
      throw new IntegrationError('Invalid amount', { code: IntegrationErrorCode.VALIDATION, statusCode: 400, provider: 'mock' });
    }
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const providerPaymentId = `pay_mock_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const raw = { id: providerPaymentId, status: 'succeeded', amount, currency, orderId };
    const mapped = mapProviderResponse('payment', raw);
    logger.info({ provider: 'mock', orderId, tenantId, amount }, 'Mock payment charge succeeded');
    return { providerPaymentId: mapped.providerPaymentId, raw, mapped, status: 'COMPLETED' };
  }

  async refund({ paymentId: _paymentId, amount, currency: _currency }) {
    if (this.shouldTimeout) throw new IntegrationError('Provider mock timed out', { code: IntegrationErrorCode.TIMEOUT, statusCode: 504, provider: 'mock' });
    if (this.shouldFail) throw new IntegrationError('Provider mock unavailable', { code: IntegrationErrorCode.UNAVAILABLE, statusCode: 502, provider: 'mock' });
    if (!amount || Number(amount) <= 0) throw new IntegrationError('Invalid refund amount', { code: IntegrationErrorCode.VALIDATION, statusCode: 400, provider: 'mock' });
    const providerRefundId = `ref_mock_${Date.now()}`;
    return { providerRefundId, status: 'COMPLETED', raw: { id: providerRefundId, status: 'succeeded' }, mapped: mapProviderResponse('payment', { id: providerRefundId }) };
  }

  async verifyWebhook(rawBodyOrPayload, signature) {
    // delegation to existing webhook util but via provider boundary — verify over exact raw bytes
    const { verifyWebhookSignature } = await import('../../modules/payments/webhook.util.js');
    const valid = verifyWebhookSignature(rawBodyOrPayload, signature);
    if (!valid) throw new IntegrationError('Invalid webhook signature', { code: IntegrationErrorCode.AUTHENTICATION, statusCode: 401, provider: 'mock' });
    // map provider event to domain — parse if string
    let payload = rawBodyOrPayload;
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); } catch { payload = {}; }
    } else if (Buffer.isBuffer(payload)) {
      try { payload = JSON.parse(payload.toString('utf8')); } catch { payload = {}; }
    }
    const type = payload?.type;
    let targetStatus = null;
    if (type === 'payment.succeeded' || type === 'charge.succeeded') targetStatus = 'COMPLETED';
    else if (type === 'payment.failed' || type === 'charge.failed') targetStatus = 'FAILED';
    else if (type === 'payment.refunded') targetStatus = 'REFUNDED';
    return { verified: true, mappedType: targetStatus, rawType: type };
  }

  // allow test injection
  _setFailureMode({ shouldTimeout, shouldFail, failStatus }) {
    if (typeof shouldTimeout === 'boolean') this.shouldTimeout = shouldTimeout;
    if (typeof shouldFail === 'boolean') this.shouldFail = shouldFail;
    if (failStatus) this.failStatus = failStatus;
  }
}

export class HttpPaymentProvider {
  constructor(options = {}) {
    this.providerName = 'http';
    this.baseUrl = options.baseUrl || env.PAYMENT_PROVIDER_URL || null;
    this.apiKey = options.apiKey || env.PAYMENT_PROVIDER_API_KEY || null;
    this.timeoutMs = options.timeoutMs || env.PAYMENT_PROVIDER_TIMEOUT_MS || 5000;
    this.retries = options.retries ?? 2;
  }

  _ensureConfig() {
    if (!this.baseUrl) {
      throw new IntegrationError('Payment provider URL not configured', { code: IntegrationErrorCode.CONFIGURATION, statusCode: 500, provider: 'http-payment' });
    }
  }

  async charge({ amount, currency, orderId, tenantId, idempotencyKey }) {
    this._ensureConfig();
    if (!amount || Number(amount) <= 0) {
      throw new IntegrationError('Invalid amount', { code: IntegrationErrorCode.VALIDATION, statusCode: 400, provider: 'http-payment' });
    }
    const url = `${this.baseUrl.replace(/\/$/, '')}/charges`;
    const headers = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const body = JSON.stringify({ amount, currency, orderId, tenantId });
    try {
      const res = await requestWithRetry(url, { method: 'POST', headers, body }, { timeoutMs: this.timeoutMs, provider: 'http-payment', retries: this.retries, idempotent: Boolean(idempotencyKey) });
      const raw = await res.json().catch(() => ({}));
      const mapped = mapProviderResponse('payment', raw);
      return { providerPaymentId: mapped.providerPaymentId || raw.id, raw, mapped, status: raw.status === 'succeeded' ? 'COMPLETED' : raw.status };
    } catch (err) {
      throw normalizeProviderError(err, { provider: 'http-payment' });
    }
  }

  async refund({ paymentId, amount, currency }) {
    this._ensureConfig();
    const url = `${this.baseUrl.replace(/\/$/, '')}/refunds`;
    const headers = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const body = JSON.stringify({ paymentId, amount, currency });
    try {
      const res = await requestWithRetry(url, { method: 'POST', headers, body }, { timeoutMs: this.timeoutMs, provider: 'http-payment', retries: 1, idempotent: false });
      const raw = await res.json().catch(() => ({}));
      return { providerRefundId: raw.id || raw.refundId, raw, mapped: mapProviderResponse('payment', raw), status: raw.status || 'COMPLETED' };
    } catch (err) {
      throw normalizeProviderError(err, { provider: 'http-payment' });
    }
  }

  async verifyWebhook(rawBodyOrPayload, signature) {
    const { verifyWebhookSignature } = await import('../../modules/payments/webhook.util.js');
    const valid = verifyWebhookSignature(rawBodyOrPayload, signature);
    if (!valid) throw new IntegrationError('Invalid webhook signature', { code: IntegrationErrorCode.AUTHENTICATION, statusCode: 401, provider: 'http-payment' });
    return { verified: true };
  }
}

export function createPaymentProvider(name = env.PAYMENT_PROVIDER || 'mock', options = {}) {
  if (name === 'http' || name === 'stripe' || name === 'adyen') return new HttpPaymentProvider(options);
  return new MockPaymentProvider(options);
}
