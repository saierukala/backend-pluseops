import { IntegrationError, IntegrationErrorCode, normalizeProviderError } from '../errors/integration-error.js';
import { requestWithRetry, mapProviderResponse } from '../http/http-client.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

export class MockEmailProvider {
  constructor(options = {}) {
    this.providerName = 'mock';
    this.shouldTimeout = options.shouldTimeout || false;
    this.shouldFail = options.shouldFail || false;
    this.failStatus = options.failStatus || 502;
    this.sent = []; // for test inspection
  }

  async send({ to, subject, html: _html, text: _text, template: _template, variables: _variables = {}, tenantId }) {
    if (this.shouldTimeout) throw new IntegrationError('Provider mock-email timed out', { code: IntegrationErrorCode.TIMEOUT, statusCode: 504, provider: 'mock-email' });
    if (this.shouldFail) throw new IntegrationError('Provider mock-email unavailable', { code: IntegrationErrorCode.UNAVAILABLE, statusCode: this.failStatus, provider: 'mock-email' });
    if (!to || !subject) throw new IntegrationError('Invalid email parameters', { code: IntegrationErrorCode.VALIDATION, statusCode: 400, provider: 'mock-email' });
    // do not log email body with secrets; sanitize
    logger.info({ provider: 'mock-email', to, tenantId, subject }, 'Mock email sent');
    const id = `email_mock_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const raw = { id, status: 'sent', to, subject };
    this.sent.push({ to, subject, tenantId, id, at: new Date().toISOString() });
    return { providerId: id, status: 'sent', raw, mapped: mapProviderResponse('email', raw) };
  }

  _setFailureMode({ shouldTimeout, shouldFail, failStatus }) {
    if (typeof shouldTimeout === 'boolean') this.shouldTimeout = shouldTimeout;
    if (typeof shouldFail === 'boolean') this.shouldFail = shouldFail;
    if (failStatus) this.failStatus = failStatus;
  }
  _clear() { this.sent = []; }
}

export class HttpEmailProvider {
  constructor(options = {}) {
    this.providerName = 'http';
    this.baseUrl = options.baseUrl || env.EMAIL_PROVIDER_URL || null;
    this.apiKey = options.apiKey || env.EMAIL_PROVIDER_API_KEY || null;
    this.timeoutMs = options.timeoutMs || env.EMAIL_PROVIDER_TIMEOUT_MS || 5000;
    this.retries = options.retries ?? 2;
  }

  _ensureConfig() {
    if (!this.baseUrl) throw new IntegrationError('Email provider URL not configured', { code: IntegrationErrorCode.CONFIGURATION, statusCode: 500, provider: 'http-email' });
  }

  async send({ to, subject, html, text, template, variables = {}, tenantId }) {
    this._ensureConfig();
    if (!to || !subject) throw new IntegrationError('Invalid email parameters', { code: IntegrationErrorCode.VALIDATION, statusCode: 400, provider: 'http-email' });
    const url = `${this.baseUrl.replace(/\/$/, '')}/send`;
    const headers = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const body = JSON.stringify({ to, subject, html, text, template, variables, tenantId });
    try {
      const res = await requestWithRetry(url, { method: 'POST', headers, body }, { timeoutMs: this.timeoutMs, provider: 'http-email', retries: this.retries, idempotent: false });
      const raw = await res.json().catch(() => ({}));
      return { providerId: raw.id || raw.messageId || null, status: raw.status || 'sent', raw, mapped: mapProviderResponse('email', raw) };
    } catch (err) {
      throw normalizeProviderError(err, { provider: 'http-email' });
    }
  }
}

let singletonMock = null;
export function createEmailProvider(name = env.EMAIL_PROVIDER || 'mock', options = {}) {
  if (name === 'http' || name === 'sendgrid' || name === 'ses' || name === 'mailgun') return new HttpEmailProvider(options);
  if (singletonMock && !options.fresh) return singletonMock;
  const inst = new MockEmailProvider(options);
  if (!options.fresh) singletonMock = inst;
  return inst;
}

export function _resetEmailProviderForTest() { singletonMock = null; }
