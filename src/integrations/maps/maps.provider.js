import { IntegrationError, IntegrationErrorCode, normalizeProviderError } from '../errors/integration-error.js';
import { requestWithRetry, mapProviderResponse } from '../http/http-client.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

export class MockMapsProvider {
  constructor(options = {}) {
    this.providerName = 'mock';
    this.shouldTimeout = options.shouldTimeout || false;
    this.shouldFail = options.shouldFail || false;
    this.failStatus = options.failStatus || 502;
  }
  async geocode({ address, tenantId: _tenantId }) {
    if (this.shouldTimeout) throw new IntegrationError('Provider mock-maps timed out', { code: IntegrationErrorCode.TIMEOUT, statusCode: 504, provider: 'mock-maps' });
    if (this.shouldFail) throw new IntegrationError('Provider mock-maps unavailable', { code: IntegrationErrorCode.UNAVAILABLE, statusCode: this.failStatus, provider: 'mock-maps' });
    if (!address) throw new IntegrationError('Address required', { code: IntegrationErrorCode.VALIDATION, statusCode: 400, provider: 'mock-maps' });
    logger.info({ provider: 'mock-maps', address }, 'Mock geocode');
    const raw = { lat: 40.7128, lng: -74.006, address, formatted: address };
    return { ...mapProviderResponse('maps', raw), raw };
  }
  async reverseGeocode({ lat, lng, tenantId: _tenantId2 }) {
    if (this.shouldTimeout) throw new IntegrationError('Provider mock-maps timed out', { code: IntegrationErrorCode.TIMEOUT, statusCode: 504, provider: 'mock-maps' });
    if (this.shouldFail) throw new IntegrationError('Provider mock-maps unavailable', { code: IntegrationErrorCode.UNAVAILABLE, statusCode: this.failStatus, provider: 'mock-maps' });
    if (lat == null || lng == null) throw new IntegrationError('lat/lng required', { code: IntegrationErrorCode.VALIDATION, statusCode: 400, provider: 'mock-maps' });
    const raw = { lat, lng, address: `Mock address for ${lat},${lng}`, formatted: `Mock ${lat},${lng}` };
    return { ...mapProviderResponse('maps', raw), raw };
  }
  _setFailureMode({ shouldTimeout, shouldFail, failStatus }) {
    if (typeof shouldTimeout === 'boolean') this.shouldTimeout = shouldTimeout;
    if (typeof shouldFail === 'boolean') this.shouldFail = shouldFail;
    if (failStatus) this.failStatus = failStatus;
  }
}

export class HttpMapsProvider {
  constructor(options = {}) {
    this.providerName = 'http';
    this.baseUrl = options.baseUrl || env.MAPS_PROVIDER_URL || null;
    this.apiKey = options.apiKey || env.MAPS_PROVIDER_API_KEY || null;
    this.timeoutMs = options.timeoutMs || env.MAPS_PROVIDER_TIMEOUT_MS || 5000;
    this.retries = options.retries ?? 2;
  }
  _ensureConfig() {
    if (!this.baseUrl) throw new IntegrationError('Maps provider URL not configured', { code: IntegrationErrorCode.CONFIGURATION, statusCode: 500, provider: 'http-maps' });
  }
  async geocode({ address, tenantId: _tenantId }) {
    this._ensureConfig();
    if (!address) throw new IntegrationError('Address required', { code: IntegrationErrorCode.VALIDATION, statusCode: 400, provider: 'http-maps' });
    const url = `${this.baseUrl.replace(/\/$/, '')}/geocode?address=${encodeURIComponent(address)}`;
    const headers = {};
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    try {
      const res = await requestWithRetry(url, { method: 'GET', headers }, { timeoutMs: this.timeoutMs, provider: 'http-maps', retries: this.retries, idempotent: true });
      const raw = await res.json().catch(() => ({}));
      return { ...mapProviderResponse('maps', raw), raw };
    } catch (err) { throw normalizeProviderError(err, { provider: 'http-maps' }); }
  }
  async reverseGeocode({ lat, lng, tenantId: _tenantId2 }) {
    this._ensureConfig();
    const url = `${this.baseUrl.replace(/\/$/, '')}/reverse?lat=${lat}&lng=${lng}`;
    const headers = {};
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    try {
      const res = await requestWithRetry(url, { method: 'GET', headers }, { timeoutMs: this.timeoutMs, provider: 'http-maps', retries: this.retries, idempotent: true });
      const raw = await res.json().catch(() => ({}));
      return { ...mapProviderResponse('maps', raw), raw };
    } catch (err) { throw normalizeProviderError(err, { provider: 'http-maps' }); }
  }
}

let singleton = null;
export function createMapsProvider(name = env.MAPS_PROVIDER || 'mock', options = {}) {
  if (name === 'http' || name === 'google' || name === 'mapbox') return new HttpMapsProvider(options);
  if (singleton && !options.fresh) return singleton;
  const inst = new MockMapsProvider(options);
  if (!options.fresh) singleton = inst;
  return inst;
}
export function _resetMapsProviderForTest() { singleton = null; }
