import nodemailer from 'nodemailer';
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

// Phase 35: plain SMTP through nodemailer, the same setup as businesshub-backend: SMTP_URL (Brevo, Gmail app password,
// SES SMTP, …) and EMAIL_FROM. Without SMTP_URL the jsonTransport builds the message and sends nothing.
export class SmtpEmailProvider {
  constructor(options = {}) {
    this.providerName = 'smtp';
    this.from = options.from || env.EMAIL_FROM;
    const url = options.url ?? env.SMTP_URL;
    this.transport = options.transport || (url
      ? nodemailer.createTransport(url, { connectionTimeout: env.EMAIL_PROVIDER_TIMEOUT_MS, greetingTimeout: env.EMAIL_PROVIDER_TIMEOUT_MS, socketTimeout: env.EMAIL_PROVIDER_TIMEOUT_MS * 2 })
      : nodemailer.createTransport({ jsonTransport: true }));
  }

  async send({ to, subject, html, text, tenantId, replyTo }) {
    if (!to || !subject) throw new IntegrationError('Invalid email parameters', { code: IntegrationErrorCode.VALIDATION, statusCode: 400, provider: 'smtp' });
    try {
      const info = await this.transport.sendMail({ from: this.from, to, subject, text: text || undefined, html: html || undefined, replyTo: replyTo || undefined });
      const raw = { id: info.messageId, status: 'sent', accepted: info.accepted, rejected: info.rejected };
      return { providerId: info.messageId || null, status: 'sent', raw, mapped: mapProviderResponse('email', raw) };
    } catch (err) {
      // 5xx SMTP replies (bad recipient, auth refused) won't succeed on retry; connection problems might
      const permanent = Number(err?.responseCode) >= 500 || err?.code === 'EAUTH' || err?.code === 'EENVELOPE';
      logger.warn({ provider: 'smtp', tenantId, code: err?.code, responseCode: err?.responseCode }, 'SMTP send failed');
      throw new IntegrationError(`SMTP send failed: ${err?.message || 'unknown error'}`, {
        code: permanent ? IntegrationErrorCode.VALIDATION : IntegrationErrorCode.UNAVAILABLE, statusCode: permanent ? 400 : 503, provider: 'smtp', cause: err,
      });
    }
  }
}

let singletonMock = null;
export function createEmailProvider(name = env.EMAIL_PROVIDER || 'mock', options = {}) {
  if (name === 'smtp') return new SmtpEmailProvider(options);
  if (name === 'http' || name === 'sendgrid' || name === 'ses' || name === 'mailgun') return new HttpEmailProvider(options);
  if (singletonMock && !options.fresh) return singletonMock;
  const inst = new MockEmailProvider(options);
  if (!options.fresh) singletonMock = inst;
  return inst;
}

export function _resetEmailProviderForTest() { singletonMock = null; }
