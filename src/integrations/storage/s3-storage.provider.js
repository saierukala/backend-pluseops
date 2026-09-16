import crypto from 'node:crypto';
import { AppError } from '../../common/errors/app-error.js';
import { IntegrationError, IntegrationErrorCode, normalizeProviderError } from '../errors/integration-error.js';
import { fetchWithTimeout, requestWithRetry } from '../http/http-client.js';
import { env } from '../../config/env.js';

// Helper to compute AWS SigV4 for S3 - minimal implementation
function sha256Hex(data) {
  return crypto.createHash('sha256').update(data || '').digest('hex');
}
function hmacSha256(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}
function hmacSha256Hex(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest('hex');
}

function buildS3Authorization({ accessKeyId, secretAccessKey, region, service = 's3', method, uri, queryString = '', headers, payloadHash, amzDate }) {
  const dateStamp = amzDate.slice(0, 8);
  const signedHeaders = Object.keys(headers).map((k) => k.toLowerCase()).sort().join(';');
  const canonicalHeaders = Object.keys(headers)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map((k) => `${k.toLowerCase()}:${String(headers[k]).trim()}\n`)
    .join('');
  const canonicalRequest = [method, uri, queryString, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, 'aws4_request');
  const signature = hmacSha256Hex(kSigning, stringToSign);
  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

/**
 * REAL S3-compatible storage provider.
 * Uses native fetch with S3 REST API (PUT/GET/HEAD/DELETE) and AWS SigV4 when credentials provided.
 * For tests without credentials, sends unsigned requests to a controllable test endpoint.
 */
export class S3StorageProvider {
  constructor(options = {}) {
    this.bucket = options.bucket || env.S3_BUCKET || 'pulseops-test-bucket';
    this.region = options.region || env.S3_REGION || 'us-east-1';
    this.endpoint = options.endpoint || env.S3_ENDPOINT || null; // e.g., https://s3.amazonaws.com or http://localhost:9000
    this.accessKeyId = options.accessKeyId || env.S3_ACCESS_KEY_ID || null;
    this.secretAccessKey = options.secretAccessKey || env.S3_SECRET_ACCESS_KEY || null;
    this.baseUrl = options.baseUrl || env.S3_PUBLIC_BASE_URL || (this.endpoint ? `${this.endpoint.replace(/\/$/, '')}/${this.bucket}` : `https://${this.bucket}.s3.${this.region}.amazonaws.com`);
    this.forcePathStyle = options.forcePathStyle ?? env.S3_FORCE_PATH_STYLE ?? true;
    this.timeoutMs = options.timeoutMs || env.STORAGE_TIMEOUT_MS || 5000;
    // test injection
    this.shouldTimeout = options.shouldTimeout || false;
    this.shouldFail = options.shouldFail || false;
    this.failStatus = options.failStatus || null;
  }

  _validateConfig() {
    if (env.NODE_ENV === 'production' && env.STORAGE_PROVIDER === 's3') {
      if (!this.bucket) {
        throw new IntegrationError('S3 bucket not configured', { code: IntegrationErrorCode.CONFIGURATION, statusCode: 500, provider: 's3' });
      }
    }
  }

  _enforceTenantKey(storageKey) {
    if (!storageKey || typeof storageKey !== 'string') {
      throw new AppError('Invalid storage key', { statusCode: 400, code: 'INVALID_STORAGE_KEY' });
    }
    if (storageKey.includes('..') || storageKey.includes('//') || storageKey.startsWith('/') || storageKey.includes('\\')) {
      throw new AppError('Invalid storage path: path traversal detected', { statusCode: 400, code: 'INVALID_STORAGE_PATH' });
    }
    if (!storageKey.startsWith('tenants/')) {
      throw new AppError('Storage key must be tenant-scoped', { statusCode: 400, code: 'INVALID_STORAGE_KEY' });
    }
    if (storageKey.includes(':') || storageKey.includes('\0')) {
      throw new AppError('Invalid storage key characters', { statusCode: 400, code: 'INVALID_STORAGE_KEY' });
    }
  }

  _simulateTimeoutIfNeeded() {
    if (this.shouldTimeout) throw new IntegrationError('Provider s3 timed out', { code: IntegrationErrorCode.TIMEOUT, statusCode: 504, provider: 's3' });
  }
  _simulateFailureIfNeeded() {
    if (this.shouldFail) {
      const status = this.failStatus || 502;
      const code = status === 429 ? IntegrationErrorCode.RATE_LIMIT : status === 401 ? IntegrationErrorCode.AUTHENTICATION : status === 404 ? IntegrationErrorCode.NOT_FOUND : IntegrationErrorCode.UNAVAILABLE;
      throw new IntegrationError(`Provider s3 failed with ${status}`, { code, statusCode: status, provider: 's3' });
    }
  }

  _buildUrl(storageKey) {
    // Path-style: endpoint/bucket/key  (works for MinIO and R2 custom endpoint)
    if (this.endpoint) {
      const base = this.endpoint.replace(/\/$/, '');
      if (this.forcePathStyle) return `${base}/${this.bucket}/${storageKey}`;
      // virtual-hosted: https://bucket.endpoint/key  - derive host
      try {
        const u = new URL(base);
        return `${u.protocol}//${this.bucket}.${u.host}/${storageKey}`;
      } catch {
        return `${base}/${this.bucket}/${storageKey}`;
      }
    }
    // AWS default virtual hosted
    return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${storageKey}`;
  }

  _buildHeaders(method, storageKey, payloadHash, contentType) {
    const headers = {};
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z'; // YYYYMMDDTHHmmssZ
    headers['x-amz-date'] = amzDate;
    headers['x-amz-content-sha256'] = payloadHash;
    if (contentType) headers['content-type'] = contentType;
    // Host header derived from URL
    const url = this._buildUrl(storageKey);
    try {
      const host = new URL(url).host;
      headers.host = host;
    } catch { /* ignore */ }

    if (this.accessKeyId && this.secretAccessKey) {
      const uri = `/${this.forcePathStyle || this.endpoint ? `${this.bucket}/${storageKey}` : storageKey}`;
      // For real S3, query string empty; we include signed headers
      const auth = buildS3Authorization({
        accessKeyId: this.accessKeyId,
        secretAccessKey: this.secretAccessKey,
        region: this.region,
        method,
        uri,
        queryString: '',
        headers: { host: headers.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, ...(contentType ? { 'content-type': contentType } : {}) },
        payloadHash,
        amzDate,
      });
      headers.Authorization = auth;
    }
    return headers;
  }

  async upload(storageKey, buffer, mimeType) {
    this._validateConfig();
    this._enforceTenantKey(storageKey);
    this._simulateTimeoutIfNeeded();
    this._simulateFailureIfNeeded();
    if (!Buffer.isBuffer(buffer)) throw new AppError('Invalid buffer', { statusCode: 400, code: 'INVALID_FILE_BUFFER' });
    const url = this._buildUrl(storageKey);
    const payloadHash = sha256Hex(buffer);
    const headers = this._buildHeaders('PUT', storageKey, payloadHash, mimeType);
    headers['content-length'] = String(buffer.length);
    try {
      await requestWithRetry(url, { method: 'PUT', headers, body: buffer }, { timeoutMs: this.timeoutMs, provider: 's3', retries: 2, idempotent: true });
      // S3 PUT returns 200 or 204 on success; requestWithRetry already checks ok
      const publicUrl = `${this.baseUrl.replace(/\/$/, '')}/${storageKey}`;
      return { url: publicUrl, size: buffer.length, mimeType };
    } catch (err) {
      if (err instanceof IntegrationError || err instanceof AppError) throw err;
      throw normalizeProviderError(err, { provider: 's3' });
    }
  }

  async delete(storageKey) {
    this._enforceTenantKey(storageKey);
    this._simulateTimeoutIfNeeded();
    this._simulateFailureIfNeeded();
    const url = this._buildUrl(storageKey);
    const payloadHash = sha256Hex('');
    const headers = this._buildHeaders('DELETE', storageKey, payloadHash, null);
    try {
      const res = await fetchWithTimeout(url, { method: 'DELETE', headers }, { timeoutMs: this.timeoutMs, provider: 's3' });
      if (res.status === 404) return false;
      if (!res.ok) {
        const code = res.status === 429 ? IntegrationErrorCode.RATE_LIMIT : res.status >= 500 ? IntegrationErrorCode.UNAVAILABLE : IntegrationErrorCode.REJECTION;
        throw new IntegrationError(`S3 delete failed with ${res.status}`, { code, statusCode: res.status, provider: 's3' });
      }
      return true;
    } catch (err) {
      if (err instanceof IntegrationError || err instanceof AppError) throw err;
      throw normalizeProviderError(err, { provider: 's3' });
    }
  }

  async getUrl(storageKey) {
    this._enforceTenantKey(storageKey);
    this._simulateTimeoutIfNeeded();
    // For S3, public URL is deterministic; we optionally HEAD to verify existence but return null if 404
    const url = this._buildUrl(storageKey);
    const payloadHash = sha256Hex('');
    const headers = this._buildHeaders('HEAD', storageKey, payloadHash, null);
    try {
      const res = await fetchWithTimeout(url, { method: 'HEAD', headers }, { timeoutMs: this.timeoutMs, provider: 's3' });
      if (res.status === 404) return null;
      if (!res.ok && res.status !== 200) {
        if (res.status >= 500) throw new IntegrationError('S3 HEAD failed', { code: IntegrationErrorCode.UNAVAILABLE, statusCode: res.status, provider: 's3' });
        return null;
      }
      return `${this.baseUrl.replace(/\/$/, '')}/${storageKey}`;
    } catch (err) {
      if (err instanceof IntegrationError) throw err;
      throw normalizeProviderError(err, { provider: 's3' });
    }
  }

  async exists(storageKey) {
    this._enforceTenantKey(storageKey);
    const url = this._buildUrl(storageKey);
    const payloadHash = sha256Hex('');
    const headers = this._buildHeaders('HEAD', storageKey, payloadHash, null);
    try {
      const res = await fetchWithTimeout(url, { method: 'HEAD', headers }, { timeoutMs: this.timeoutMs, provider: 's3' });
      if (res.status === 404) return false;
      return res.ok;
    } catch (err) {
      if (err instanceof IntegrationError) throw err;
      throw normalizeProviderError(err, { provider: 's3' });
    }
  }

  async getStream(storageKey) {
    this._enforceTenantKey(storageKey);
    const url = this._buildUrl(storageKey);
    const payloadHash = sha256Hex('');
    const headers = this._buildHeaders('GET', storageKey, payloadHash, null);
    try {
      const res = await fetchWithTimeout(url, { method: 'GET', headers }, { timeoutMs: this.timeoutMs, provider: 's3' });
      if (res.status === 404) return null;
      if (!res.ok) throw new IntegrationError(`S3 GET failed with ${res.status}`, { code: IntegrationErrorCode.UNAVAILABLE, statusCode: res.status, provider: 's3' });
      // Return Node stream from web stream
      const { Readable } = await import('node:stream');
      if (res.body && typeof res.body.getReader === 'function') {
        // web stream to node
        const reader = res.body.getReader();
        return new Readable({
          async read() {
            const { done, value } = await reader.read();
            if (done) this.push(null);
            else this.push(Buffer.from(value));
          },
        });
      }
      const buf = Buffer.from(await res.arrayBuffer());
      return Readable.from(buf);
    } catch (err) {
      if (err instanceof IntegrationError || err instanceof AppError) throw err;
      throw normalizeProviderError(err, { provider: 's3' });
    }
  }

  _clear() { /* no-op for real provider */ }
  _setFailureMode({ shouldTimeout = false, shouldFail = false, failStatus = null } = {}) {
    this.shouldTimeout = shouldTimeout;
    this.shouldFail = shouldFail;
    this.failStatus = failStatus;
  }
}

/**
 * Deterministic mock S3 provider for unit tests without HTTP.
 * Mirrors S3StorageProvider contract but uses in-memory Map.
 * Clearly distinguished from real S3 provider.
 */
export class MockS3StorageProvider {
  constructor(options = {}) {
    this.store = options.store || new Map();
    this.baseUrl = options.baseUrl || 'https://mock-s3.local/mock-bucket';
    this.shouldTimeout = options.shouldTimeout || false;
    this.shouldFail = options.shouldFail || false;
    this.failStatus = options.failStatus || null;
  }
  _enforceTenantKey(storageKey) {
    if (!storageKey || typeof storageKey !== 'string') throw new AppError('Invalid storage key', { statusCode: 400, code: 'INVALID_STORAGE_KEY' });
    if (storageKey.includes('..') || storageKey.includes('//') || storageKey.startsWith('/') || storageKey.includes('\\')) throw new AppError('Invalid storage path: path traversal detected', { statusCode: 400, code: 'INVALID_STORAGE_PATH' });
    if (!storageKey.startsWith('tenants/')) throw new AppError('Storage key must be tenant-scoped', { statusCode: 400, code: 'INVALID_STORAGE_KEY' });
    if (storageKey.includes(':') || storageKey.includes('\0')) throw new AppError('Invalid storage key characters', { statusCode: 400, code: 'INVALID_STORAGE_KEY' });
  }
  _simulateTimeoutIfNeeded() { if (this.shouldTimeout) throw new IntegrationError('Provider mock-s3 timed out', { code: IntegrationErrorCode.TIMEOUT, statusCode: 504, provider: 'mock-s3' }); }
  _simulateFailureIfNeeded() { if (this.shouldFail) { const status = this.failStatus || 502; const code = status === 429 ? IntegrationErrorCode.RATE_LIMIT : status === 401 ? IntegrationErrorCode.AUTHENTICATION : IntegrationErrorCode.UNAVAILABLE; throw new IntegrationError(`Provider mock-s3 failed with ${status}`, { code, statusCode: status, provider: 'mock-s3' }); } }
  async upload(storageKey, buffer, mimeType) {
    this._enforceTenantKey(storageKey); this._simulateTimeoutIfNeeded(); this._simulateFailureIfNeeded();
    if (!Buffer.isBuffer(buffer)) throw new AppError('Invalid buffer', { statusCode: 400, code: 'INVALID_FILE_BUFFER' });
    const url = `${this.baseUrl}/${storageKey}`;
    this.store.set(storageKey, { buffer: Buffer.from(buffer), mimeType, size: buffer.length, url });
    return { url, size: buffer.length, mimeType };
  }
  async delete(storageKey) { this._enforceTenantKey(storageKey); this._simulateTimeoutIfNeeded(); this._simulateFailureIfNeeded(); if (!this.store.has(storageKey)) return false; this.store.delete(storageKey); return true; }
  async getUrl(storageKey) { this._enforceTenantKey(storageKey); this._simulateTimeoutIfNeeded(); const entry = this.store.get(storageKey); return entry ? entry.url : null; }
  async exists(storageKey) { this._enforceTenantKey(storageKey); return this.store.has(storageKey); }
  async getStream(storageKey) { this._enforceTenantKey(storageKey); const entry = this.store.get(storageKey); if (!entry) return null; const { Readable } = await import('node:stream'); return Readable.from(entry.buffer); }
  _clear() { this.store.clear(); }
  _setFailureMode({ shouldTimeout = false, shouldFail = false, failStatus = null } = {}) { this.shouldTimeout = shouldTimeout; this.shouldFail = shouldFail; this.failStatus = failStatus; }
}

// Backward compatibility: default export alias
export const S3StorageProviderMock = MockS3StorageProvider;
