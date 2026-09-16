import { IntegrationError, IntegrationErrorCode, normalizeProviderError } from '../errors/integration-error.js';
import { requestWithRetry, mapProviderResponse } from '../http/http-client.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

export class MockShippingProvider {
  constructor(options = {}) {
    this.providerName = 'mock';
    this.shouldTimeout = options.shouldTimeout || false;
    this.shouldFail = options.shouldFail || false;
    this.failStatus = options.failStatus || 502;
  }
  async getRate({ origin, destination, weight, dimensions: _dimensions, tenantId }) {
    if (this.shouldTimeout) throw new IntegrationError('Provider mock-shipping timed out', { code: IntegrationErrorCode.TIMEOUT, statusCode: 504, provider: 'mock-shipping' });
    if (this.shouldFail) throw new IntegrationError('Provider mock-shipping unavailable', { code: IntegrationErrorCode.UNAVAILABLE, statusCode: this.failStatus, provider: 'mock-shipping' });
    if (!origin || !destination) throw new IntegrationError('Origin and destination required', { code: IntegrationErrorCode.VALIDATION, statusCode: 400, provider: 'mock-shipping' });
    logger.info({ provider: 'mock-shipping', tenantId, origin, destination }, 'Mock shipping rate fetched');
    const raw = { rate: 12.5, currency: 'USD', eta: '3-5 days', origin, destination, weight };
    return { ...mapProviderResponse('shipping', raw), raw };
  }
  async createShipment({ orderId, origin: _origin, destination: _destination, tenantId: _tenantId }) {
    if (this.shouldTimeout) throw new IntegrationError('Provider mock-shipping timed out', { code: IntegrationErrorCode.TIMEOUT, statusCode: 504, provider: 'mock-shipping' });
    if (this.shouldFail) throw new IntegrationError('Provider mock-shipping unavailable', { code: IntegrationErrorCode.UNAVAILABLE, statusCode: this.failStatus, provider: 'mock-shipping' });
    if (!orderId) throw new IntegrationError('orderId required', { code: IntegrationErrorCode.VALIDATION, statusCode: 400, provider: 'mock-shipping' });
    const raw = { id: `ship_mock_${Date.now()}`, trackingNumber: `TRK${Date.now()}`, status: 'created' };
    return { providerId: raw.id, trackingNumber: raw.trackingNumber, status: 'created', raw };
  }
  _setFailureMode({ shouldTimeout, shouldFail, failStatus }) {
    if (typeof shouldTimeout === 'boolean') this.shouldTimeout = shouldTimeout;
    if (typeof shouldFail === 'boolean') this.shouldFail = shouldFail;
    if (failStatus) this.failStatus = failStatus;
  }
}

export class HttpShippingProvider {
  constructor(options = {}) {
    this.providerName = 'http';
    this.baseUrl = options.baseUrl || env.SHIPPING_PROVIDER_URL || null;
    this.apiKey = options.apiKey || env.SHIPPING_PROVIDER_API_KEY || null;
    this.timeoutMs = options.timeoutMs || env.SHIPPING_PROVIDER_TIMEOUT_MS || 5000;
    this.retries = options.retries ?? 2;
  }
  _ensureConfig() {
    if (!this.baseUrl) throw new IntegrationError('Shipping provider URL not configured', { code: IntegrationErrorCode.CONFIGURATION, statusCode: 500, provider: 'http-shipping' });
  }
  async getRate({ origin, destination, weight, dimensions, tenantId }) {
    this._ensureConfig();
    if (!origin || !destination) throw new IntegrationError('Origin and destination required', { code: IntegrationErrorCode.VALIDATION, statusCode: 400, provider: 'http-shipping' });
    const url = `${this.baseUrl.replace(/\/$/, '')}/rates`;
    const headers = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const body = JSON.stringify({ origin, destination, weight, dimensions, tenantId });
    try {
      const res = await requestWithRetry(url, { method: 'POST', headers, body }, { timeoutMs: this.timeoutMs, provider: 'http-shipping', retries: this.retries, idempotent: true });
      const raw = await res.json().catch(() => ({}));
      return { ...mapProviderResponse('shipping', raw), raw };
    } catch (err) { throw normalizeProviderError(err, { provider: 'http-shipping' }); }
  }
  async createShipment({ orderId, origin, destination, tenantId }) {
    this._ensureConfig();
    const url = `${this.baseUrl.replace(/\/$/, '')}/shipments`;
    const headers = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const body = JSON.stringify({ orderId, origin, destination, tenantId });
    try {
      const res = await requestWithRetry(url, { method: 'POST', headers, body }, { timeoutMs: this.timeoutMs, provider: 'http-shipping', retries: 0, idempotent: false });
      const raw = await res.json().catch(() => ({}));
      return { providerId: raw.id, trackingNumber: raw.trackingNumber, raw, mapped: mapProviderResponse('shipping', raw) };
    } catch (err) { throw normalizeProviderError(err, { provider: 'http-shipping' }); }
  }
}

let singleton = null;
export function createShippingProvider(name = env.SHIPPING_PROVIDER || 'mock', options = {}) {
  if (name === 'http' || name === 'shippo' || name === 'easypost') return new HttpShippingProvider(options);
  if (singleton && !options.fresh) return singleton;
  const inst = new MockShippingProvider(options);
  if (!options.fresh) singleton = inst;
  return inst;
}
export function _resetShippingProviderForTest() { singleton = null; }
