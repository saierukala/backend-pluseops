import { IntegrationError, IntegrationErrorCode, normalizeProviderError } from '../errors/integration-error.js';
import { requestWithRetry, mapProviderResponse } from '../http/http-client.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

export class MockSmsProvider {
  constructor(options = {}) {
    this.providerName = 'mock';
    this.shouldTimeout = options.shouldTimeout || false;
    this.shouldFail = options.shouldFail || false;
    this.failStatus = options.failStatus || 502;
    this.sent = [];
  }
  async send({ to, message, tenantId }) {
    if (this.shouldTimeout) throw new IntegrationError('Provider mock-sms timed out', { code: IntegrationErrorCode.TIMEOUT, statusCode: 504, provider: 'mock-sms' });
    if (this.shouldFail) throw new IntegrationError('Provider mock-sms unavailable', { code: IntegrationErrorCode.UNAVAILABLE, statusCode: this.failStatus, provider: 'mock-sms' });
    if (!to || !message) throw new IntegrationError('Invalid SMS parameters', { code: IntegrationErrorCode.VALIDATION, statusCode: 400, provider: 'mock-sms' });
    logger.info({ provider: 'mock-sms', to, tenantId }, 'Mock SMS sent');
    const id = `sms_mock_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const raw = { id, status: 'sent', to, message };
    this.sent.push({ to, message, tenantId, id, at: new Date().toISOString() });
    return { providerId: id, status: 'sent', raw, mapped: mapProviderResponse('sms', raw) };
  }
  _setFailureMode({ shouldTimeout, shouldFail, failStatus }) {
    if (typeof shouldTimeout === 'boolean') this.shouldTimeout = shouldTimeout;
    if (typeof shouldFail === 'boolean') this.shouldFail = shouldFail;
    if (failStatus) this.failStatus = failStatus;
  }
  _clear() { this.sent = []; }
}

export class HttpSmsProvider {
  constructor(options = {}) {
    this.providerName = 'http';
    this.baseUrl = options.baseUrl || env.SMS_PROVIDER_URL || null;
    this.apiKey = options.apiKey || env.SMS_PROVIDER_API_KEY || null;
    this.timeoutMs = options.timeoutMs || env.SMS_PROVIDER_TIMEOUT_MS || 5000;
    this.retries = options.retries ?? 2;
  }
  _ensureConfig() {
    if (!this.baseUrl) throw new IntegrationError('SMS provider URL not configured', { code: IntegrationErrorCode.CONFIGURATION, statusCode: 500, provider: 'http-sms' });
  }
  async send({ to, message, tenantId }) {
    this._ensureConfig();
    if (!to || !message) throw new IntegrationError('Invalid SMS parameters', { code: IntegrationErrorCode.VALIDATION, statusCode: 400, provider: 'http-sms' });
    const url = `${this.baseUrl.replace(/\/$/, '')}/send`;
    const headers = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const body = JSON.stringify({ to, message, tenantId });
    try {
      const res = await requestWithRetry(url, { method: 'POST', headers, body }, { timeoutMs: this.timeoutMs, provider: 'http-sms', retries: 1, idempotent: false });
      const raw = await res.json().catch(() => ({}));
      return { providerId: raw.id || raw.sid || null, status: raw.status || 'sent', raw, mapped: mapProviderResponse('sms', raw) };
    } catch (err) { throw normalizeProviderError(err, { provider: 'http-sms' }); }
  }
}

let singleton = null;
export function createSmsProvider(name = env.SMS_PROVIDER || 'mock', options = {}) {
  if (name === 'http' || name === 'twilio' || name === 'vonage') return new HttpSmsProvider(options);
  if (singleton && !options.fresh) return singleton;
  const inst = new MockSmsProvider(options);
  if (!options.fresh) singleton = inst;
  return inst;
}
export function _resetSmsProviderForTest() { singleton = null; }
